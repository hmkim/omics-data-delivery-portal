import { act, fireEvent, render, screen } from '@testing-library/react';
import i18next from 'i18next';
import { initReactI18next } from 'react-i18next';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import en from '../i18n/en.json';
import ko from '../i18n/ko.json';
import * as zip from '../download/zip';
import { createPortalDownloadView } from './PortalDownloadView';

/**
 * Cancel race (dev 2026-10-01): `runZip` had already resolved `cancelled` when a chunk still queued in the counting
 * transform reported progress; React batched the late `running` update behind `done` and the panel stayed on
 * "zip 생성 중" with a live Cancel button (about half of the cancels on the deployed portal). The view must treat
 * progress as an update of a running phase only.
 */
describe('PortalDownloadView cancel (R4.9)', () => {
  beforeAll(async () => {
    if (!i18next.isInitialized) {
      await i18next.use(initReactI18next).init({
        lng: 'ko',
        fallbackLng: 'en',
        resources: { ko: { translation: ko }, en: { translation: en } },
        interpolation: { escapeValue: false },
      });
    }
  });

  const useView = (() => ({
    tasks: [
      {
        data: {
          key: 'projects/DEMO-0001/sample-1gib.bin',
          size: 1024 ** 3,
          relativePath: 'sample-1gib.bin',
          lastModified: new Date(0),
          archiveName: 'DEMO-0001',
        },
      },
    ],
    onActionExit: vi.fn(),
    location: { current: { bucket: 'bkt' } },
    enumerationStatus: 'SUCCEEDED',
  })) as unknown as Parameters<typeof createPortalDownloadView>[0]['useView'];

  it('a late progress report after a cancelled outcome does not revive the running phase', async () => {
    let onProgress: ((p: zip.ZipProgress) => void) | undefined;
    let resolveRun!: (o: zip.ZipOutcome) => void;
    const runZipSpy = vi.spyOn(zip, 'runZip').mockImplementation(
      (_input, deps) =>
        new Promise<zip.ZipOutcome>((r) => {
          onProgress = deps.onProgress;
          resolveRun = r;
        }),
    );
    const View = createPortalDownloadView({
      useView,
      api: { issueDownload: vi.fn() },
      session: { incrementActiveDownloads: vi.fn(), decrementActiveDownloads: vi.fn() },
      serviceWorker: {} as ServiceWorkerContainer,
    });
    render(<View />);

    fireEvent.click(screen.getByRole('button', { name: 'zip 다운로드 시작' }));
    await act(async () => {
      onProgress?.({ issued: 1, filesDone: 0, bytesDone: 8 * 1024 ** 2, total: 1, phase: 'streaming' });
    });
    expect(screen.getByText(/zip 스트리밍 중/)).toBeInTheDocument();

    // cancel: runZip resolves, then one more chunk is reported in the same tick
    fireEvent.click(screen.getByRole('button', { name: '취소' }));
    await act(async () => {
      resolveRun({ status: 'cancelled' });
      await Promise.resolve();
      onProgress?.({ issued: 1, filesDone: 0, bytesDone: 9 * 1024 ** 2, total: 1, phase: 'streaming' });
    });

    expect(screen.getByText(/zip 생성을 취소했습니다/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '취소' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'zip 다운로드 시작' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '다시 받기' })).toBeInTheDocument();
    runZipSpy.mockRestore();
  });
});
