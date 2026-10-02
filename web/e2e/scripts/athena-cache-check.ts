import { parseArgs } from 'node:util';
import { awsGate } from '../helpers/aws';
import { checkSecondPassHits, readCachePasses } from '../helpers/cache';

/**
 * Standalone R5.8 check: verifies with Athena that the second CloudFront pass recorded by the
 * "two CloudFront passes" e2e test was served entirely from cache — without downloading anything again.
 *
 *   npm run e2e:athena-check -w web -- --passes <cache-passes.json> [--wait-min 30]
 *
 * Exit codes: 0 all Hit · 2 misses found · 3 no log rows within the wait · 1 setup/credential error.
 */
async function main(): Promise<number> {
  const { values } = parseArgs({
    options: {
      passes: { type: 'string' },
      'wait-min': { type: 'string', default: '30' },
    },
  });
  if (!values.passes) {
    console.error('usage: athena-cache-check --passes <cache-passes.json> [--wait-min N]');
    return 1;
  }
  const gate = await awsGate();
  if (!gate.ok) {
    console.error(gate.reason);
    return 1;
  }
  const record = readCachePasses(values.passes);
  console.log(
    `object ${record.object} (${record.uriStem}); passes: ${record.passes.map((p) => `${p.path}@${p.startedAt}`).join(', ')}`,
  );
  const result = await checkSecondPassHits(record, Number(values['wait-min']));
  if (result.rows.length === 0) {
    console.error('no CloudFront log rows for the second pass yet; retry later');
    return 3;
  }
  console.log(
    `second pass: ${result.rows.length} requests, by x_edge_result_type: ${JSON.stringify(result.byType)}`,
  );
  for (const m of result.misses) {
    console.log(
      `  non-Hit: ${m.date} ${m.time} ${m.x_edge_result_type} range ${m.sc_range_start}-${m.sc_range_end} ${m.x_edge_request_id}`,
    );
  }
  if (result.misses.length > 0) {
    console.error(`R5.8 FAILED: ${result.misses.length} non-Hit request(s) in the second pass`);
    return 2;
  }
  console.log('R5.8 OK: every second-pass request was a CloudFront cache Hit');
  return 0;
}

main().then(
  (code) => process.exit(code),
  (err) => {
    console.error(err);
    process.exit(1);
  },
);
