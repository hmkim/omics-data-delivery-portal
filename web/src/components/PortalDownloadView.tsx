import type { UseView } from '@aws-amplify/ui-react-storage/browser';
import { Alert, Button, Card, Flex, Heading, Loader, Text } from '@aws-amplify/ui-react';
import { ZIP_MAX_FILES } from '@genome-portal/contract';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { api as defaultApi, type ApiClient } from '../api/client';
import { session as defaultSession } from '../auth/session';
import { getConfig } from '../config';
import { planZip, runZip, type ZipItem, type ZipOutcome, type ZipProgress } from '../download/zip';
import { formatBytes } from '../ui/format';

/**
 * Replacement `DownloadView` (T3.10, R4.9): reads the current selection through `useView('Download')`,
 * excludes files above the single-object limit, caps the count at ZIP_MAX_FILES, and streams the rest into one zip
 * (each file counted by its own `POST /downloads`). No resume: an interruption or AUTH_EXPIRED shows "rebuild".
 */
export interface PortalDownloadViewDeps {
  useView: UseView;
  api?: Pick<ApiClient, 'issueDownload'>;
  session?: { incrementActiveDownloads(): void; decrementActiveDownloads(): void };
  serviceWorker?: ServiceWorkerContainer | undefined;
}

type Phase =
  { kind: 'idle' } | { kind: 'running'; progress: ZipProgress } | { kind: 'done'; outcome: ZipOutcome };

/** Registry so `auth/session.ts` can fail every zip in flight on AUTH_EXPIRED. */
const zipAbortControllers = new Set<AbortController>();
export function failAllZips(): void {
  for (const c of zipAbortControllers) c.abort(new DOMException('AUTH_EXPIRED', 'AbortError'));
  zipAbortControllers.clear();
}

export function createPortalDownloadView({
  useView,
  api = defaultApi,
  session = defaultSession,
  serviceWorker,
}: PortalDownloadViewDeps) {
  const sw =
    serviceWorker === undefined && typeof navigator !== 'undefined' ? navigator.serviceWorker : serviceWorker;

  return function PortalDownloadView() {
    const { t } = useTranslation();
    const view = useView('Download');
    const { tasks, onActionExit, location, enumerationStatus } = view;
    const cfg = getConfig();
    const [phase, setPhase] = useState<Phase>({ kind: 'idle' });
    const abortRef = useRef<AbortController | null>(null);

    const items: ZipItem[] = useMemo(
      () =>
        tasks.map((task) => ({
          key: task.data.key,
          sizeBytes: task.data.size ?? 0,
          relativePath: task.data.relativePath,
          lastModified: task.data.lastModified,
        })),
      [tasks],
    );
    const plan = useMemo(
      () => planZip(items, { singleObjectLimitBytes: cfg.singleObjectLimitBytes }),
      [items, cfg],
    );
    const archiveName = tasks[0]?.data.archiveName ?? 'download';
    const bucket = location.current?.bucket ?? cfg.dataBucket;
    const blobFallback = !sw;

    useEffect(() => () => abortRef.current?.abort(), []);

    const start = async () => {
      const controller = new AbortController();
      abortRef.current = controller;
      zipAbortControllers.add(controller);
      setPhase({
        kind: 'running',
        progress: { issued: 0, filesDone: 0, bytesDone: 0, total: plan.included.length, phase: 'issuing' },
      });
      const outcome = await runZip(
        { items: plan.included, bucket, archiveName },
        {
          api,
          session,
          serviceWorker: sw,
          signal: controller.signal,
          // Chunks already inside the counting transform can still report AFTER the abort has settled runZip; React
          // batches that late `running` update behind `done` and the last write won (dev 2026-10-01, ~50 % of
          // cancels kept the panel on "zip 생성 중"). Progress may only ever update a running phase.
          onProgress: (progress) =>
            setPhase((prev) => (prev.kind === 'running' ? { kind: 'running', progress } : prev)),
        },
      );
      zipAbortControllers.delete(controller);
      if (
        controller.signal.aborted &&
        controller.signal.reason instanceof DOMException &&
        controller.signal.reason.message === 'AUTH_EXPIRED'
      ) {
        setPhase({ kind: 'done', outcome: { status: 'failed', reason: 'AUTH_EXPIRED' } });
        return;
      }
      setPhase({ kind: 'done', outcome });
    };

    const cancel = () => abortRef.current?.abort();
    const canStart =
      phase.kind === 'idle' &&
      enumerationStatus === 'SUCCEEDED' &&
      plan.included.length > 0 &&
      !plan.tooMany &&
      !(blobFallback && plan.totalBytes > 2 * 1024 ** 3);

    return (
      <Card variation="outlined">
        <Heading level={4}>{t('zip.title')}</Heading>
        {enumerationStatus === 'PENDING' ? (
          <Text>{t('storageBrowser.DownloadView.enumeratingMessage')}</Text>
        ) : null}
        {enumerationStatus === 'ERROR' ? (
          <Alert variation="error">{t('storageBrowser.DownloadView.enumerationErrorMessage')}</Alert>
        ) : null}
        {enumerationStatus === 'OVER_LIMIT' ? (
          <Alert variation="error">{t('storageBrowser.DownloadView.tooManyFilesMessage')}</Alert>
        ) : null}

        {plan.excludedOverLimit.length > 0 ? (
          <Alert variation="warning" marginTop="0.5rem">
            {t('zip.excludedOverLimit', {
              files: plan.excludedOverLimit.map((f) => f.key.split('/').pop()).join(', '),
            })}
          </Alert>
        ) : null}
        {plan.tooMany ? (
          <Alert variation="error" marginTop="0.5rem">
            {t('zip.tooMany', { max: ZIP_MAX_FILES, count: plan.included.length })}
          </Alert>
        ) : null}
        {plan.included.length === 0 && enumerationStatus === 'SUCCEEDED' ? (
          <Text marginTop="0.5rem">{t('zip.noFiles')}</Text>
        ) : null}

        <Text marginTop="0.5rem">
          {t('zip.summary', { count: plan.included.length, size: formatBytes(plan.totalBytes) })}
        </Text>
        <Text fontSize="small" color="font.tertiary">
          {t('zip.noResume')}
        </Text>
        {blobFallback ? (
          <Alert variation={plan.totalBytes > 2 * 1024 ** 3 ? 'error' : 'info'} marginTop="0.5rem">
            {plan.totalBytes > 2 * 1024 ** 3 ? t('zip.blobTooLarge') : t('zip.blobFallbackWarning')}
          </Alert>
        ) : null}

        {phase.kind === 'running' ? (
          <Flex direction="column" gap="0.25rem" marginTop="0.75rem">
            <Loader
              variation="linear"
              isDeterminate
              isPercentageTextHidden
              percentage={
                plan.totalBytes > 0 ? Math.floor((phase.progress.bytesDone / plan.totalBytes) * 100) : 0
              }
            />
            <Text fontSize="small">
              {phase.progress.phase === 'issuing'
                ? t('zip.preparing', { done: phase.progress.issued, total: phase.progress.total })
                : t('zip.streaming', {
                    done: phase.progress.filesDone,
                    total: phase.progress.total,
                    bytes: formatBytes(phase.progress.bytesDone),
                  })}
            </Text>
          </Flex>
        ) : null}
        {phase.kind === 'done' ? (
          <Alert
            marginTop="0.75rem"
            variation={
              phase.outcome.status === 'complete'
                ? 'success'
                : phase.outcome.status === 'cancelled'
                  ? 'info'
                  : 'error'
            }
          >
            {phase.outcome.status === 'complete'
              ? t('zip.complete')
              : phase.outcome.status === 'cancelled'
                ? t('zip.cancelled')
                : phase.outcome.reason === 'AUTH_EXPIRED'
                  ? t('zip.authExpired')
                  : phase.outcome.reason === 'BLOB_TOO_LARGE'
                    ? t('zip.blobTooLarge')
                    : `${t('zip.failed')}${phase.outcome.message ? ` (${phase.outcome.message})` : ''}`}
          </Alert>
        ) : null}

        <Flex direction="row" gap="0.5rem" marginTop="1rem">
          {phase.kind === 'running' ? (
            <Button onClick={cancel}>{t('zip.cancel')}</Button>
          ) : (
            <Button variation="primary" isDisabled={!canStart} onClick={() => void start()}>
              {t('zip.start')}
            </Button>
          )}
          {phase.kind === 'done' && phase.outcome.status !== 'complete' ? (
            <Button onClick={() => setPhase({ kind: 'idle' })}>{t('panel.retry')}</Button>
          ) : null}
          <Button variation="link" onClick={onActionExit} isDisabled={phase.kind === 'running'}>
            {t('zip.exit')}
          </Button>
        </Flex>
      </Card>
    );
  };
}
