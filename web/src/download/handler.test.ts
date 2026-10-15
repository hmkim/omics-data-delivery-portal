import type { DownloadHandlerInput } from '@aws-amplify/ui-react-storage/browser';
import type { DownloadResponse } from '@genome-portal/contract';
import { describe, expect, it, vi } from 'vitest';
import { ApiRequestError } from '../api/client';
import { createPortalDownloadHandler } from './handler';
import { SplitUnavailableError } from './splitEngine';

const GiB = 1024 ** 3;

const issued = (size: number, path: 'S3' | 'CF' = 'S3'): DownloadResponse => ({
  downloadId: 'dl',
  url: 'https://x/y',
  path,
  mode: size > GiB ? 'split' : 'single',
  expiresAt: new Date().toISOString(),
  sizeBytes: size,
  count: path === 'CF' ? 2 : 1,
  filename: 'f.bam',
});

const input = (): DownloadHandlerInput => ({
  config: {
    bucket: 'bkt',
    region: 'ap-northeast-2',
    credentials: async () => ({ credentials: {} as never }),
  },
  data: { id: '1', key: 'p/f.bam', fileKey: 'f.bam' },
  all: [],
});

function setup(size: number, fsAccess: boolean | 'export', path: 'S3' | 'CF' = 'S3') {
  const api = { issueDownload: vi.fn(async () => issued(size, path)) };
  const engine = { start: vi.fn(async () => ({}) as never) };
  const anchor = vi.fn();
  const openCommand = vi.fn();
  const toast = vi.fn();
  const handler = createPortalDownloadHandler({
    api,
    engine,
    anchor,
    openCommand,
    toast,
    t: (k) => k,
    plannerOptions: {
      ...(fsAccess === 'export' ? { capability: 'export' as const } : { hasFileSystemAccess: fsAccess }),
      settings: { splitThresholdBytes: GiB, singleObjectLimitBytes: 50_000_000_000 },
    },
  });
  return { api, engine, anchor, openCommand, toast, handler };
}

describe('portalDownloadHandler (T3.6, §5.2)', () => {
  it('single: POST /downloads then anchor download, path toast viaS3', async () => {
    const s = setup(500 * 1024 ** 2, true);
    const res = await s.handler(input()).result;
    expect(s.api.issueDownload).toHaveBeenCalledWith({ bucket: 'bkt', key: 'p/f.bam' });
    expect(s.anchor).toHaveBeenCalledWith('https://x/y', 'f.bam');
    expect(s.toast.mock.calls.map((c) => c[0])).toEqual(['toast.viaS3']);
    expect(res.status).toBe('COMPLETE');
  });

  it('split (FS Access, 12 GiB): engine.start, toast viaCloudFront', async () => {
    const s = setup(12 * GiB, true, 'CF');
    await s.handler(input()).result;
    expect(s.engine.start).toHaveBeenCalledWith(
      expect.objectContaining({ sizeBytes: 12 * GiB }),
      'bkt',
      'p/f.bam',
    );
    expect(s.anchor).not.toHaveBeenCalled();
    expect(s.toast.mock.calls.map((c) => c[0])).toEqual(['toast.viaCloudFront']);
  });

  it('single without FS Access above the split threshold adds the R5.9 no-resume toast', async () => {
    const s = setup(12 * GiB, false);
    await s.handler(input()).result;
    expect(s.anchor).toHaveBeenCalled();
    expect(s.toast.mock.calls.map((c) => c[0])).toEqual(['toast.viaS3', 'toast.noResumeInThisBrowser']);
  });

  it('command (no FS Access, > 50 GB): opens the command dialog', async () => {
    const s = setup(150_000_000_000, false);
    await s.handler(input()).result;
    expect(s.openCommand).toHaveBeenCalledWith({
      issued: expect.objectContaining({ sizeBytes: 150_000_000_000 }),
      bucket: 'bkt',
      key: 'p/f.bam',
    });
    expect(s.engine.start).not.toHaveBeenCalled();
  });

  it('export capability (D8): 12 GiB and 150 GB both start the engine, no R5.9 toast, no command dialog', async () => {
    for (const size of [12 * GiB, 150_000_000_000]) {
      const s = setup(size, 'export');
      await s.handler(input()).result;
      expect(s.engine.start).toHaveBeenCalledTimes(1);
      expect(s.anchor).not.toHaveBeenCalled();
      expect(s.openCommand).not.toHaveBeenCalled();
      expect(s.toast.mock.calls.map((c) => c[0])).toEqual(['toast.viaS3']);
    }
  });

  it('SplitUnavailableError (OPFS quota) → ordinary download + reason toast + R5.9 hint below 50 GB', async () => {
    const s = setup(12 * GiB, 'export');
    s.engine.start.mockRejectedValueOnce(new SplitUnavailableError('OPFS_QUOTA'));
    const out = await s.handler(input()).result;
    expect(out.status).toBe('COMPLETE');
    expect(s.anchor).toHaveBeenCalledWith('https://x/y', 'f.bam');
    expect(s.openCommand).not.toHaveBeenCalled();
    expect(s.toast.mock.calls.map((c) => c[0])).toEqual([
      'toast.viaS3',
      'toast.splitUnavailable.OPFS_QUOTA',
      'toast.noResumeInThisBrowser',
    ]);
  });

  it('SplitUnavailableError (no OPFS) above 50 GB → command dialog + reason toast', async () => {
    const s = setup(150_000_000_000, 'export');
    s.engine.start.mockRejectedValueOnce(new SplitUnavailableError('OPFS_UNAVAILABLE'));
    await s.handler(input()).result;
    expect(s.anchor).not.toHaveBeenCalled();
    expect(s.openCommand).toHaveBeenCalledWith({
      issued: expect.objectContaining({ sizeBytes: 150_000_000_000 }),
      bucket: 'bkt',
      key: 'p/f.bam',
    });
    expect(s.toast.mock.calls.map((c) => c[0])).toEqual([
      'toast.viaS3',
      'toast.splitUnavailable.OPFS_UNAVAILABLE',
    ]);
  });

  it('403 → FAILED with access-denied toast; save picker dismissal → CANCELED', async () => {
    const s = setup(1, true);
    s.api.issueDownload.mockRejectedValueOnce(
      new ApiRequestError(403, { error: 'FORBIDDEN' }, '/api/downloads'),
    );
    const failed = await s.handler(input()).result;
    expect(failed.status).toBe('FAILED');
    expect(s.toast.mock.calls[0]?.[0]).toBe('toast.accessDenied');

    const split = setup(12 * GiB, true);
    split.engine.start.mockRejectedValueOnce(new DOMException('dismissed', 'AbortError'));
    const cancelled = await split.handler(input()).result;
    expect(cancelled.status).toBe('CANCELED');
  });
});
