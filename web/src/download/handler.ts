import type {
  ActionHandler,
  DownloadHandlerInput,
  DownloadHandlerOutput,
} from '@aws-amplify/ui-react-storage/browser';
import type { DownloadResponse } from '@genome-portal/contract';
import { api, ApiRequestError, AuthExpiredError, type ApiClient } from '../api/client';
import { getConfig } from '../config';
import { i18next } from '../i18n';
import { toast } from '../ui/notify';
import { openCommandDialog } from './commandDialogStore';
import { splitEngine } from './engine';
import { decide, type DecideOptions } from './planner';
import { SplitUnavailableError, type SplitEngine } from './splitEngine';

/** Plain anchor download (mode `single`): the browser saves the signed URL to its download folder. */
export function triggerAnchorDownload(url: string, filename: string, doc: Document = document): void {
  const a = doc.createElement('a');
  a.href = url;
  a.download = filename;
  a.rel = 'noopener';
  a.style.display = 'none';
  doc.body.appendChild(a);
  a.click();
  doc.body.removeChild(a);
}

export interface HandlerDeps {
  api: Pick<ApiClient, 'issueDownload'>;
  engine: Pick<SplitEngine, 'start'>;
  plannerOptions?: DecideOptions;
  anchor?: (url: string, filename: string) => void;
  openCommand?: (state: { issued: DownloadResponse; bucket: string; key: string }) => void;
  toast?: typeof toast;
  t?: (key: string, opts?: Record<string, unknown>) => string;
}

/**
 * Replacement for Storage Browser's default `download` action (design §5.2, D3-A):
 * POST /downloads (counts the event, decides S3 vs CloudFront) → planner → single | split | command.
 *
 * `split` may still be refused by the engine (`SplitUnavailableError`: `export` delivery without a usable OPFS, or
 * no capability after all); the download then takes the `none` column of the §5.4 matrix — ordinary download below
 * the single-object limit (R5.9 hint), the command dialog above it (R5.6) — and a toast says why.
 */
/** Same shape as the library's `DownloadHandler`: `(input: DownloadHandlerInput) => DownloadHandlerOutput`. */
export type PortalDownloadHandler = ActionHandler<
  DownloadHandlerInput['data'],
  NonNullable<Awaited<DownloadHandlerOutput['result']>['value']>
>;

export function createPortalDownloadHandler(deps: HandlerDeps): PortalDownloadHandler {
  const anchor = deps.anchor ?? triggerAnchorDownload;
  const openCommand = deps.openCommand ?? openCommandDialog;
  const notify = deps.toast ?? toast;
  const t = deps.t ?? ((key, opts) => i18next.t(key, opts) as string);

  return ({ config, data }: DownloadHandlerInput) => {
    const bucket = config.bucket || getConfig().dataBucket;
    const key = data.key;
    const result = (async () => {
      let issued: DownloadResponse;
      try {
        issued = await deps.api.issueDownload({ bucket, key });
      } catch (err) {
        if (err instanceof AuthExpiredError) {
          return { status: 'FAILED' as const, error: err, message: t('auth.sessionExpiredBanner') };
        }
        if (err instanceof ApiRequestError && err.status === 403) {
          notify(t('toast.accessDenied'), 'error');
          return { status: 'FAILED' as const, error: err, message: t('toast.accessDenied') };
        }
        const message = err instanceof Error ? err.message : String(err);
        notify(t('toast.downloadIssueFailed', { message }), 'error');
        return { status: 'FAILED' as const, error: err instanceof Error ? err : new Error(message), message };
      }

      let mode = decide({ sizeBytes: issued.sizeBytes }, deps.plannerOptions);
      notify(t(issued.path === 'CF' ? 'toast.viaCloudFront' : 'toast.viaS3'), 'info');
      const settings = deps.plannerOptions?.settings ?? {
        splitThresholdBytes: getConfig().splitThresholdBytes,
        singleObjectLimitBytes: getConfig().singleObjectLimitBytes,
      };

      if (mode === 'split') {
        try {
          await deps.engine.start(issued, bucket, key);
        } catch (err) {
          // user dismissed the save picker (AbortError) or the API is missing
          if (err instanceof DOMException && err.name === 'AbortError') {
            notify(t('toast.savePickerCancelled'), 'warning');
            return { status: 'CANCELED' as const, message: t('toast.savePickerCancelled') };
          }
          if (err instanceof SplitUnavailableError) {
            // D8: this browser cannot hold the parts → the `none` behaviour for this size
            mode = decide({ sizeBytes: issued.sizeBytes }, { capability: 'none', settings });
            notify(t(`toast.splitUnavailable.${err.reason}`), 'warning', 15_000);
          } else {
            throw err;
          }
        }
      }
      if (mode === 'single' && issued.sizeBytes > settings.splitThresholdBytes) {
        notify(t('toast.noResumeInThisBrowser'), 'warning', 12_000); // R5.9
      }

      if (mode === 'single') {
        anchor(issued.url, issued.filename);
      } else if (mode === 'command') {
        openCommand({ issued, bucket, key });
      }
      return { status: 'COMPLETE' as const, value: { url: new URL(issued.url) } };
    })();
    return { result };
  };
}

export const portalDownloadHandler: PortalDownloadHandler = createPortalDownloadHandler({
  api,
  engine: splitEngine,
});
