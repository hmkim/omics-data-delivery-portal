import { Alert, Button, Flex, Heading, Text, TextAreaField, View } from '@aws-amplify/ui-react';
import { useEffect, useState, useSyncExternalStore } from 'react';
import { useTranslation } from 'react-i18next';
import { api as defaultApi, type ApiClient } from '../api/client';
import { getConfig } from '../config';
import {
  closeCommandDialog,
  getCommandDialogState,
  subscribeCommandDialog,
  updateCommandDialog,
} from '../download/commandDialogStore';
import { buildCommands } from '../download/commandFallback';
import { formatBytes, formatTime } from '../ui/format';

/**
 * Command fallback dialog (R5.6, T3.6): aria2c / curl commands with copy buttons, URL expiry time and a
 * "다시 발급" (renew) button that calls `POST /downloads/{id}/renew` — same path, count unchanged.
 */
export interface CommandDialogProps {
  api?: Pick<ApiClient, 'renewDownload'>;
  now?: () => number;
}

export function CommandDialog({ api = defaultApi, now = () => Date.now() }: CommandDialogProps) {
  const { t, i18n } = useTranslation();
  const state = useSyncExternalStore(subscribeCommandDialog, getCommandDialogState, getCommandDialogState);
  const [copied, setCopied] = useState<'aria2c' | 'curl' | null>(null);
  const [renewing, setRenewing] = useState(false);
  const [renewError, setRenewError] = useState<string | null>(null);
  const [, setTick] = useState(0);

  useEffect(() => {
    if (!state) return;
    const id = setInterval(() => setTick((n) => n + 1), 30_000);
    return () => clearInterval(id);
  }, [state]);

  if (!state) return null;
  const { issued } = state;
  const commands = buildCommands({ filename: issued.filename, url: issued.url });
  const expired = new Date(issued.expiresAt).getTime() <= now();
  const limit = formatBytes(getConfig().singleObjectLimitBytes);

  const copy = async (which: 'aria2c' | 'curl') => {
    try {
      await navigator.clipboard.writeText(commands[which]);
      setCopied(which);
      setTimeout(() => setCopied(null), 2000);
    } catch {
      setCopied(null);
    }
  };

  const renew = async () => {
    setRenewing(true);
    setRenewError(null);
    try {
      const res = await api.renewDownload(issued.downloadId);
      updateCommandDialog({ url: res.url, expiresAt: res.expiresAt, path: res.path });
    } catch (err) {
      setRenewError(err instanceof Error ? err.message : String(err));
    } finally {
      setRenewing(false);
    }
  };

  return (
    <View
      role="dialog"
      aria-modal="true"
      aria-labelledby="command-dialog-title"
      style={{
        position: 'fixed',
        inset: 0,
        background: 'rgba(0,0,0,0.45)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        zIndex: 1100,
      }}
    >
      <View
        backgroundColor="background.primary"
        padding="1.5rem"
        borderRadius="0.75rem"
        width="min(48rem, 95vw)"
      >
        <Heading id="command-dialog-title" level={4}>
          {t('command.title')}
        </Heading>
        <Text marginTop="0.5rem">{t('command.intro', { limit })}</Text>
        <Text fontSize="small" color="font.tertiary" marginTop="0.25rem">
          {issued.filename} · {formatBytes(issued.sizeBytes)} · {issued.path === 'CF' ? 'CloudFront' : 'S3'}
        </Text>

        {(['aria2c', 'curl'] as const).map((which) => (
          <Flex key={which} direction="column" gap="0.25rem" marginTop="1rem">
            <Flex direction="row" justifyContent="space-between" alignItems="center">
              <Text fontWeight="bold">{t(`command.${which}`)}</Text>
              <Button size="small" onClick={() => void copy(which)}>
                {copied === which ? t('command.copied') : t('command.copy')}
              </Button>
            </Flex>
            <TextAreaField
              label={t(`command.${which}`)}
              labelHidden
              readOnly
              rows={3}
              value={commands[which]}
              style={{ fontFamily: 'monospace', fontSize: '0.8rem' }}
            />
          </Flex>
        ))}

        <Flex direction="row" alignItems="center" gap="0.75rem" marginTop="1rem" wrap="wrap">
          {expired ? (
            <Alert variation="warning">{t('command.expired')}</Alert>
          ) : (
            <Text>{t('command.expires', { time: formatTime(issued.expiresAt, i18n.language) })}</Text>
          )}
          <Button
            size="small"
            onClick={() => void renew()}
            isLoading={renewing}
            loadingText={t('command.renewing')}
          >
            {t('command.renew')}
          </Button>
        </Flex>
        {renewError ? (
          <Alert variation="error">{t('command.renewFailed', { message: renewError })}</Alert>
        ) : null}
        <Text fontSize="small" color="font.tertiary" marginTop="0.5rem">
          {t('command.counted')}
        </Text>
        <Flex direction="row" justifyContent="flex-end" marginTop="1rem">
          <Button variation="primary" onClick={closeCommandDialog}>
            {t('command.close')}
          </Button>
        </Flex>
      </View>
    </View>
  );
}
