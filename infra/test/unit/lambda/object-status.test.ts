import { TEST, makeEvent, parseResult } from './helpers/fixtures';
import { ddbMock, resetAllMocks } from './helpers/mocks';
import { beforeEach, describe, expect, it } from 'vitest';
import { BatchGetCommand, GetCommand, PutCommand, QueryCommand } from '@aws-sdk/lib-dynamodb';
import { OBJECT_STATUS_MAX_ITEMS } from '@genome-portal/contract';
import { resetOriginVerifyCache } from '../../../lambda/shared/originVerify';
import { resetSettingsCache } from '../../../lambda/shared/config';
import { BATCH_GET_LIMIT, batchGetCounts, handler } from '../../../lambda/handlers/object-status';

const B = TEST.bucket;
const T = TEST.downloadsTable;

function setup(cfThreshold = '1') {
  resetAllMocks({ cfThreshold });
  resetOriginVerifyCache();
  resetSettingsCache();
  ddbMock.on(PutCommand).resolves({});
  ddbMock.on(GetCommand).resolves({ Item: { active: true } });
  ddbMock.on(QueryCommand).resolves({ Items: [{ bucket: B, prefix: 'projects/P1/' }] });
}

beforeEach(() => setup());

const items = (n: number) =>
  Array.from({ length: n }, (_, i) => ({ bucket: B, key: `projects/P1/f${i}.bam` }));
const call = (body: unknown) => handler(makeEvent({ body })).then(parseResult);

describe('POST /api/objects/status', () => {
  it('returns count + nextPath, defaulting missing objects to 0/S3', async () => {
    ddbMock.on(BatchGetCommand).resolves({
      Responses: {
        [T]: [
          { pk: `OBJ#${B}/projects/P1/f0.bam`, count: 3 },
          { pk: `OBJ#${B}/projects/P1/f1.bam`, count: 0 },
        ],
      },
    });
    const res = await call({ items: items(3) });
    expect(res.status).toBe(200);
    expect(res.json).toEqual({
      items: [
        { bucket: B, key: 'projects/P1/f0.bam', count: 3, nextPath: 'CF' },
        { bucket: B, key: 'projects/P1/f1.bam', count: 0, nextPath: 'S3' },
        { bucket: B, key: 'projects/P1/f2.bam', count: 0, nextPath: 'S3' },
      ],
    });
    const req = ddbMock.commandCalls(BatchGetCommand)[0]?.args[0].input.RequestItems?.[T];
    expect(req?.Keys).toHaveLength(3);
    expect(req?.ProjectionExpression).toBe('pk, #c');
  });

  it('cf-threshold 0 -> every nextPath is CF', async () => {
    setup('0');
    ddbMock.on(BatchGetCommand).resolves({ Responses: { [T]: [] } });
    const res = await call({ items: items(2) });
    expect((res.json?.['items'] as Array<{ nextPath: string }>).map((i) => i.nextPath)).toEqual(['CF', 'CF']);
  });

  it('exactly 100 items is accepted in one BatchGet; 101 -> 400', async () => {
    ddbMock.on(BatchGetCommand).resolves({ Responses: { [T]: [] } });
    const ok = await call({ items: items(OBJECT_STATUS_MAX_ITEMS) });
    expect(ok.status).toBe(200);
    expect((ok.json?.['items'] as unknown[]).length).toBe(100);
    expect(ddbMock.commandCalls(BatchGetCommand)).toHaveLength(1);
    expect(ddbMock.commandCalls(BatchGetCommand)[0]?.args[0].input.RequestItems?.[T]?.Keys).toHaveLength(
      BATCH_GET_LIMIT,
    );

    const tooMany = await call({ items: items(OBJECT_STATUS_MAX_ITEMS + 1) });
    expect(tooMany.status).toBe(400);
    expect(tooMany.json).toMatchObject({ error: 'BAD_REQUEST' });
  });

  it('retries UnprocessedKeys', async () => {
    const k1 = `OBJ#${B}/projects/P1/f0.bam`;
    const k2 = `OBJ#${B}/projects/P1/f1.bam`;
    ddbMock
      .on(BatchGetCommand)
      .resolvesOnce({
        Responses: { [T]: [{ pk: k1, count: 1 }] },
        UnprocessedKeys: { [T]: { Keys: [{ pk: k2 }] } },
      })
      .resolvesOnce({ Responses: { [T]: [{ pk: k2, count: 2 }] } });
    const res = await call({ items: items(2) });
    expect(res.json?.['items']).toEqual([
      { bucket: B, key: 'projects/P1/f0.bam', count: 1, nextPath: 'CF' },
      { bucket: B, key: 'projects/P1/f1.bam', count: 2, nextPath: 'CF' },
    ]);
    expect(ddbMock.commandCalls(BatchGetCommand)).toHaveLength(2);
    expect(ddbMock.commandCalls(BatchGetCommand)[1]?.args[0].input.RequestItems?.[T]?.Keys).toEqual([
      { pk: k2 },
    ]);
  });

  it('drops objects outside the assigned locations (R2.3)', async () => {
    ddbMock.on(BatchGetCommand).resolves({ Responses: { [T]: [] } });
    const res = await call({
      items: [
        { bucket: B, key: 'projects/P1/ok.bam' },
        { bucket: B, key: 'projects/P2/secret.bam' },
        { bucket: 'other', key: 'projects/P1/x' },
      ],
    });
    expect(res.json?.['items']).toEqual([{ bucket: B, key: 'projects/P1/ok.bam', count: 0, nextPath: 'S3' }]);
    expect(ddbMock.commandCalls(BatchGetCommand)[0]?.args[0].input.RequestItems?.[T]?.Keys).toEqual([
      { pk: `OBJ#${B}/projects/P1/ok.bam` },
    ]);
  });

  it('empty list -> empty response without touching DynamoDB batch', async () => {
    const res = await call({ items: [] });
    expect(res.json).toEqual({ items: [] });
    expect(ddbMock.commandCalls(BatchGetCommand)).toHaveLength(0);
  });

  it('inactive org -> 403; bad body -> 400; missing origin -> 403', async () => {
    ddbMock.on(GetCommand).resolves({ Item: { active: false } });
    expect((await call({ items: items(1) })).status).toBe(403);
    setup();
    expect((await call({ nope: true })).status).toBe(400);
    expect(parseResult(await handler(makeEvent({ withOrigin: false, body: { items: [] } }))).status).toBe(
      403,
    );
  });
});

describe('batchGetCounts', () => {
  it('splits more than 100 keys into chunks and dedupes', async () => {
    ddbMock
      .on(BatchGetCommand)
      .callsFake((input: { RequestItems: Record<string, { Keys: Array<{ pk: string }> }> }) => ({
        Responses: { [T]: input.RequestItems[T]?.Keys.map((k) => ({ pk: k.pk, count: 7 })) ?? [] },
      }));
    const pks = Array.from({ length: 150 }, (_, i) => `OBJ#b/k${i}`).concat(['OBJ#b/k0']);
    const counts = await batchGetCounts(pks, [0, 0, 0]);
    expect(counts.size).toBe(150);
    expect(counts.get('OBJ#b/k149')).toBe(7);
    const calls = ddbMock
      .commandCalls(BatchGetCommand)
      .map((c) => c.args[0].input.RequestItems?.[T]?.Keys?.length);
    expect(calls).toEqual([100, 50]);
  });

  it('gives up after repeated UnprocessedKeys', async () => {
    ddbMock
      .on(BatchGetCommand)
      .resolves({ Responses: { [T]: [] }, UnprocessedKeys: { [T]: { Keys: [{ pk: 'OBJ#b/k' }] } } });
    await expect(batchGetCounts(['OBJ#b/k'], [0, 0, 0])).rejects.toThrow(/unprocessed/);
    expect(ddbMock.commandCalls(BatchGetCommand)).toHaveLength(4);
  });
});
