import { render, screen, waitFor } from '@testing-library/react';
import i18next from 'i18next';
import { initReactI18next } from 'react-i18next';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import en from '../i18n/en.json';
import ko from '../i18n/ko.json';
import { SplitEngine, type PartRunner } from '../download/splitEngine';
import { createMemorySplitStore, type SplitRecord } from '../download/store';
import { DownloadPanel } from './DownloadPanel';

const GiB = 1024 ** 3;

function record(status: SplitRecord['status'], reason?: SplitRecord['reason']): SplitRecord {
  return {
    downloadId: 'dl-1',
    bucket: 'b',
    key: 'projects/DEMO-0001/sample-12gib.bin',
    filename: 'sample-12gib.bin',
    size: 12 * GiB,
    path: 'CF',
    url: 'https://cdn/x',
    expiresAt: new Date(Date.now() + 3600_000).toISOString(),
    checksumCrc32: '/sXQ3A==',
    parts: [
      { idx: 0, start: 0, end: 8 * GiB - 1, done: true, receivedBytes: 8 * GiB },
      { idx: 1, start: 8 * GiB, end: 12 * GiB - 1, done: false, receivedBytes: GiB },
    ],
    fileHandle: {} as FileSystemFileHandle,
    status,
    reason,
    createdAt: 1,
    updatedAt: 2,
    renewCount: 3,
  };
}

describe('DownloadPanel e2e hooks (T7.1)', () => {
  beforeAll(async () => {
    if (!i18next.isInitialized) {
      await i18next.use(initReactI18next).init({
        resources: { ko: { translation: ko }, en: { translation: en } },
        lng: 'ko',
        fallbackLng: 'en',
        interpolation: { escapeValue: false },
      });
    }
  });

  it('exposes status / reason / parts / renewCount as data attributes on each row', async () => {
    const store = createMemorySplitStore();
    await store.put(record('paused', 'AUTH_EXPIRED'));
    const engine = new SplitEngine({
      store,
      renew: vi.fn(),
      runPart: vi.fn() as unknown as PartRunner,
      pickFile: vi.fn(),
      session: { incrementActiveDownloads: vi.fn(), decrementActiveDownloads: vi.fn() },
    });
    render(<DownloadPanel engine={engine} confirm={() => true} />);
    const row = await waitFor(() => screen.getByTestId('split-download'));
    expect(row).toHaveAttribute('data-download-id', 'dl-1');
    expect(row).toHaveAttribute('data-status', 'paused');
    expect(row).toHaveAttribute('data-reason', 'AUTH_EXPIRED');
    expect(row).toHaveAttribute('data-parts', '2');
    expect(row).toHaveAttribute('data-renew-count', '3');
    expect(screen.getByTestId('split-status')).toHaveTextContent('일시정지');
    expect(row).toHaveTextContent('9.0 GiB / 12.0 GiB (75%)');
    expect(row).toHaveTextContent('파트 1/2');
    expect(screen.getByRole('button', { name: '재개' })).toBeInTheDocument();
    expect(screen.getByText(/세션이 끝나 일시정지되었습니다/)).toBeInTheDocument();
  });
});
