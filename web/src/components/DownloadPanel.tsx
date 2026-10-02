import { Badge, Button, Card, Flex, Heading, Loader, Text, View } from '@aws-amplify/ui-react';
import { useEffect, useState, useSyncExternalStore } from 'react';
import { useTranslation } from 'react-i18next';
import { splitEngine as defaultEngine } from '../download/engine';
import type { SplitEngine, SplitSnapshot } from '../download/splitEngine';
import { formatBytes, formatDuration, formatTime } from '../ui/format';

/**
 * Split download panel (T3.8, R5.4, R5.7): progress per download, pause / resume / cancel, the
 * "file size × 2 free disk space" note, ETA from the first 30 s of throughput, and paused entries from
 * previous visits (resume re-requests file permission).
 */
export interface DownloadPanelProps {
  engine?: SplitEngine;
  confirm?: (message: string) => boolean;
}

export function DownloadPanel({
  engine = defaultEngine,
  confirm = (m) => window.confirm(m),
}: DownloadPanelProps) {
  const { t, i18n } = useTranslation();
  useSyncExternalStore(
    (cb) => engine.subscribe(cb),
    () => engine.version,
    () => engine.version,
  );
  const snapshots = engine.getSnapshots();

  useEffect(() => {
    void engine.load();
  }, [engine]);

  // re-render every second while something is running so speed/ETA stay current
  const running = snapshots.some((s) => s.record.status === 'running');
  const [, setTick] = useState(0);
  useEffect(() => {
    if (!running) return;
    const id = setInterval(() => setTick((n) => n + 1), 1000);
    return () => clearInterval(id);
  }, [running]);

  if (snapshots.length === 0) {
    return (
      <Card variation="outlined">
        <Heading level={5}>{t('panel.title')}</Heading>
        <Text color="font.tertiary">{t('panel.empty')}</Text>
      </Card>
    );
  }

  return (
    <Card variation="outlined">
      <Heading level={5}>{t('panel.title')}</Heading>
      <Flex direction="column" gap="0.75rem" marginTop="0.5rem">
        {snapshots.map((snap) => (
          <DownloadRow
            key={snap.record.downloadId}
            snap={snap}
            lang={i18n.language}
            onPause={() => void engine.pause(snap.record.downloadId, 'USER')}
            onResume={() => void engine.resume(snap.record.downloadId)}
            onCancel={() => {
              if (confirm(t('panel.cancelConfirm'))) void engine.cancel(snap.record.downloadId);
            }}
            onRemove={() => void engine.remove(snap.record.downloadId)}
          />
        ))}
      </Flex>
    </Card>
  );
}

interface RowProps {
  snap: SplitSnapshot;
  lang: string;
  onPause: () => void;
  onResume: () => void;
  onCancel: () => void;
  onRemove: () => void;
}

function statusVariation(
  status: SplitSnapshot['record']['status'],
): 'info' | 'success' | 'warning' | 'error' {
  switch (status) {
    case 'complete':
      return 'success';
    case 'failed':
      return 'error';
    case 'paused':
      return 'warning';
    default:
      return 'info';
  }
}

function DownloadRow({ snap, lang, onPause, onResume, onCancel, onRemove }: RowProps) {
  const { t } = useTranslation();
  const { record, receivedBytes, partsDone, speedBps, etaSeconds, mergeProgress, verifyProgress } = snap;
  const percent = record.size > 0 ? Math.floor((receivedBytes / record.size) * 100) : 0;
  const isRunning = record.status === 'running';
  const isMerging = record.status === 'merging';
  const isPaused = record.status === 'paused';
  const isFinal = record.status === 'complete' || record.status === 'failed';
  const storage = record.storage ?? 'direct';

  return (
    <View
      padding="0.75rem"
      style={{ border: '1px solid var(--amplify-colors-border-secondary)', borderRadius: '0.5rem' }}
      data-download-id={record.downloadId}
      data-testid="split-download"
      data-status={record.status}
      data-reason={record.reason ?? ''}
      data-parts={record.parts.length}
      data-renew-count={record.renewCount}
      data-storage={storage}
    >
      <Flex direction="row" justifyContent="space-between" alignItems="center" wrap="wrap" gap="0.5rem">
        <Text fontWeight="bold" style={{ wordBreak: 'break-all' }}>
          {record.filename}
        </Text>
        <Badge variation={statusVariation(record.status)} data-testid="split-status">
          {t(`panel.status.${record.status}`)}
        </Badge>
      </Flex>
      <Text fontSize="small" color="font.tertiary">
        {record.key}
      </Text>
      <Loader
        variation="linear"
        percentage={isMerging && mergeProgress !== undefined ? Math.floor(mergeProgress * 100) : percent}
        isDeterminate
        isPercentageTextHidden
        marginTop="0.5rem"
      />
      <Flex direction="row" wrap="wrap" gap="1rem" fontSize="small" marginTop="0.25rem">
        <Text>
          {t('panel.progress', {
            received: formatBytes(receivedBytes),
            total: formatBytes(record.size),
            percent,
          })}
        </Text>
        <Text>{t('panel.parts', { done: partsDone, total: record.parts.length })}</Text>
        {isRunning ? (
          speedBps !== undefined && etaSeconds !== undefined ? (
            <Text>
              {t('panel.speed', { speed: formatBytes(speedBps) })} ·{' '}
              {t('panel.eta', { eta: formatDuration(etaSeconds, lang) })}
            </Text>
          ) : (
            <Text>{t('panel.etaMeasuring')}</Text>
          )
        ) : null}
        {isMerging && mergeProgress !== undefined ? (
          <Text data-testid="merge-progress">
            {t('panel.mergeProgress', { percent: Math.floor(mergeProgress * 100) })}
          </Text>
        ) : null}
        {record.status === 'verifying' && verifyProgress !== undefined ? (
          <Text>{Math.floor(verifyProgress * 100)}%</Text>
        ) : null}
        {isRunning ? <Text>{t('panel.expiresAt', { time: formatTime(record.expiresAt, lang) })}</Text> : null}
      </Flex>
      {isRunning || isMerging || isPaused ? (
        <Text fontSize="small" color="font.tertiary" marginTop="0.25rem">
          {storage === 'opfs'
            ? t('panel.diskHintOpfs', { size: formatBytes(record.size) })
            : t('panel.diskHintDirect', { size: formatBytes(record.size * 2) })}
        </Text>
      ) : null}
      {record.reason ? (
        <Text
          fontSize="small"
          color={record.status === 'failed' ? 'font.error' : 'font.warning'}
          marginTop="0.25rem"
        >
          {t(`panel.reason.${record.reason}`)}
          {record.reason === 'PERMISSION' ? ` ${t('panel.permissionNeeded')}` : ''}
          {record.message ? ` (${record.message})` : ''}
        </Text>
      ) : null}
      <Flex direction="row" gap="0.5rem" marginTop="0.5rem">
        {isRunning || isMerging ? (
          <Button size="small" onClick={onPause}>
            {t('panel.pause')}
          </Button>
        ) : null}
        {isPaused ? (
          <Button size="small" variation="primary" onClick={onResume}>
            {t('panel.resume')}
          </Button>
        ) : null}
        {record.status === 'failed' ? (
          <Button size="small" variation="primary" onClick={onResume}>
            {t('panel.retry')}
          </Button>
        ) : null}
        {!isFinal ? (
          <Button size="small" variation="destructive" onClick={onCancel}>
            {t('panel.cancel')}
          </Button>
        ) : (
          <Button size="small" variation="link" onClick={onRemove}>
            {t('panel.remove')}
          </Button>
        )}
      </Flex>
    </View>
  );
}
