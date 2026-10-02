import { Alert, Flex } from '@aws-amplify/ui-react';
import { useSyncExternalStore } from 'react';
import { clearBanner, dismissToast, getNotifyState, subscribe } from '../ui/notify';

/** Renders the notification bus: a sticky banner (session expiry) and stacked toasts (download path, warnings). */
export function Notifications() {
  const state = useSyncExternalStore(subscribe, getNotifyState, getNotifyState);
  return (
    <>
      {state.banner ? (
        <Alert variation={state.banner.kind} isDismissible onDismiss={clearBanner} heading={undefined}>
          {state.banner.message}
        </Alert>
      ) : null}
      <Flex
        direction="column"
        gap="0.5rem"
        style={{ position: 'fixed', right: '1rem', bottom: '1rem', zIndex: 1000, maxWidth: '28rem' }}
        aria-live="polite"
      >
        {state.toasts.map((toast) => (
          <Alert key={toast.id} variation={toast.kind} isDismissible onDismiss={() => dismissToast(toast.id)}>
            {toast.message}
          </Alert>
        ))}
      </Flex>
    </>
  );
}
