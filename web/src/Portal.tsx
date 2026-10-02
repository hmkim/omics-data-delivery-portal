import { Flex, View } from '@aws-amplify/ui-react';
import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { CommandDialog } from './components/CommandDialog';
import { DownloadPanel } from './components/DownloadPanel';
import { createPortalDownloadView } from './components/PortalDownloadView';
import { buildDisplayText } from './i18n/displayText';
import { createPortalStorageBrowser } from './storageBrowser';
import { onStorageBrowserValueChange } from './ui/locationStore';

/**
 * Signed-in portal body: Storage Browser (locations → files → download), the zip DownloadView override,
 * the split download panel and the command dialog.
 */
export function Portal() {
  const { t, i18n } = useTranslation();
  const { StorageBrowser, DownloadView } = useMemo(() => {
    const created = createPortalStorageBrowser();
    return {
      StorageBrowser: created.StorageBrowser,
      DownloadView: createPortalDownloadView({ useView: created.useView }),
    };
  }, []);
  const displayText = useMemo(() => buildDisplayText(t, i18n.language), [t, i18n.language]);

  return (
    <Flex direction="column" gap="1rem" padding="1rem">
      <View>
        <StorageBrowser
          displayText={displayText}
          views={{ DownloadView }}
          onValueChange={onStorageBrowserValueChange}
        />
      </View>
      <DownloadPanel />
      <CommandDialog />
    </Flex>
  );
}
