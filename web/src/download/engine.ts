import { api } from '../api/client';
import { session } from '../auth/session';
import { i18next } from '../i18n';
import { formatBytes } from '../ui/format';
import { toast } from '../ui/notify';
import { createBrowserExportDelivery, registerExportServiceWorker } from './exportDelivery';
import {
  createWorkerCapacityProbe,
  createWorkerPartRunner,
  SplitEngine,
  type SplitEngineEvent,
} from './splitEngine';
import { opfsPartStorage } from './partStorage';
import { pickSaveFile, splitCapability } from './planner';
import { idbSplitStore } from './store';

function announce(event: SplitEngineEvent): void {
  const t = i18next.t.bind(i18next);
  switch (event.type) {
    case 'started':
      toast(t(event.resumed ? 'toast.splitResumed' : 'toast.splitStarted'), 'info');
      break;
    case 'storage-fallback':
      toast(
        event.choice.fallbackReason === 'OPFS_QUOTA'
          ? t('toast.storageFallbackQuota', { free: formatBytes(event.choice.freeBytes ?? 0) })
          : t('toast.storageFallbackUnavailable'),
        'warning',
        15_000,
      );
      break;
    case 'reconciled':
      toast(t('toast.reconciled', { bytes: formatBytes(event.lostBytes) }), 'warning', 10_000);
      break;
    case 'migrated':
      toast(t('toast.migrated'), 'warning', 10_000);
      break;
    case 'merging':
      toast(t('toast.merging', { filename: event.record.filename }), 'info');
      break;
    case 'exporting':
      toast(t('toast.exporting', { filename: event.record.filename }), 'info', 10_000);
      break;
    case 'renewed':
      toast(t('toast.renewed'), 'info', 3000);
      break;
    case 'paused':
      if (event.reason === 'AUTH_EXPIRED') toast(t('toast.pausedAuthExpired'), 'warning');
      break;
    case 'complete': {
      const { filename } = event.record;
      if (event.checksum.status === 'unverifiable')
        toast(t('toast.checksumUnverifiable', { filename }), 'warning', 10_000);
      else toast(t('toast.checksumOk', { filename }), 'success');
      // a Blob export is "complete" for the engine while the browser is still writing its copy
      if (event.record.exportMode === 'blob') toast(t('toast.exportHanded', { filename }), 'info', 15_000);
      else toast(t('toast.downloadComplete', { filename }), 'success');
      break;
    }
    case 'failed':
      if (event.reason === 'CHECKSUM_MISMATCH') {
        toast(t('toast.checksumMismatch', { filename: event.record.filename }), 'error', 12_000);
      }
      break;
    case 'cancelled':
      break;
  }
}

/** App-wide split download engine (design §5.4). */
export const splitEngine = new SplitEngine({
  store: idbSplitStore,
  renew: (downloadId) => api.renewDownload(downloadId),
  runPart: createWorkerPartRunner(),
  pickFile: (suggestedName) => pickSaveFile(suggestedName),
  session,
  // OPFS part files; the storage choice reserves the file size in a worker (exact), not via the capped estimate
  partStorage: { ...opfsPartStorage, canHold: createWorkerCapacityProbe() },
  // D8: picker (Chrome/Edge) → merge into the chosen file; export (Firefox/Safari/Brave) → browser download
  capability: splitCapability,
  deliver: createBrowserExportDelivery(),
  onEvent: announce,
});

// The export service worker streams verified parts to the browser's download manager (design §5.4 D8). Registered
// at start-up so it is active by the time a download finishes; without it the Blob path is used.
if (typeof navigator !== 'undefined' && 'serviceWorker' in navigator) {
  void registerExportServiceWorker(navigator.serviceWorker);
}
