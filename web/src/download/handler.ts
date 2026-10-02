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
import type { SplitEngine } from './splitEngine';

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

      const mode = decide({ sizeBytes: issued.sizeBytes }, deps.plannerOptions);
      notify(t(issued.path === 'CF' ? 'toast.viaCloudFront' : 'toast.viaS3'), 'info');
      const splitThreshold =
        deps.plannerOptions?.settings?.splitThresholdBytes ?? getConfig().splitThresholdBytes;
      if (mode === 'single' && issued.sizeBytes > splitThreshold) {
        notify(t('toast.noResumeInThisBrowser'), 'warning', 12_000); // R5.9
      }

      if (mode === 'single') {
        anchor(issued.url, issued.filename);
      } else if (mode === 'split') {
        try {
          await deps.engine.start(issued, bucket, key);
        } catch (err) {
          // user dismissed the save picker (AbortError) or the API is missing
          if (err instanceof DOMException && err.name === 'AbortError') {
            notify(t('toast.savePickerCancelled'), 'warning');
            return { status: 'CANCELED' as const, message: t('toast.savePickerCancelled') };
          }
          throw err;
        }
      } else {
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
