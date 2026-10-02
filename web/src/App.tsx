import { Authenticator, translations, useAuthenticator, View } from '@aws-amplify/ui-react';
import { fetchUserAttributes, signOut as amplifySignOut, type AuthUser } from 'aws-amplify/auth';
import { Hub, I18n } from 'aws-amplify/utils';
import { useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { session } from './auth/session';
import { Brand, BrandFooter } from './components/Brand';
import { Notifications } from './components/Notifications';
import { failAllZips } from './components/PortalDownloadView';
import { getConfig } from './config';
import { splitEngine } from './download/engine';
import { changeLanguage, LANGUAGE_STORAGE_KEY, resolveInitialLanguage, type PortalLanguage } from './i18n';
import { Portal } from './Portal';
import { showBanner } from './ui/notify';

/**
 * `<Authenticator hideSignUp>` handles sign-in, FORCE_CHANGE_PASSWORD (new password step) and TOTP setup /
 * confirmation; once signed in the session keeper starts and `<Portal/>` renders (T3.2).
 */
I18n.putVocabularies(translations);

export function App() {
  const { i18n } = useTranslation();
  const { brand } = getConfig();

  useEffect(() => {
    I18n.setLanguage(i18n.language.startsWith('ko') ? 'ko' : 'en');
  }, [i18n.language]);

  return (
    <View minHeight="100vh">
      <Notifications />
      <Authenticator
        hideSignUp
        loginMechanisms={['email']}
        formFields={{
          setupTotp: { QR: { totpIssuer: brand.name } },
        }}
        components={{
          Header() {
            return <Brand compact />;
          },
          Footer() {
            return <BrandFooter />;
          },
        }}
      >
        {({ signOut, user }) => <SignedIn signOut={signOut} user={user} />}
      </Authenticator>
    </View>
  );
}

interface SignedInProps {
  signOut?: () => void;
  user?: AuthUser;
}

function SignedIn({ signOut, user }: SignedInProps) {
  const { t } = useTranslation();
  const { toSignIn } = useAuthenticator((ctx) => [ctx.route]);
  const email = user?.signInDetails?.loginId ?? user?.username;

  // initial language: browser choice → custom:lang → navigator (§5.5)
  useEffect(() => {
    let stored: string | null = null;
    try {
      stored = localStorage.getItem(LANGUAGE_STORAGE_KEY);
    } catch {
      stored = null;
    }
    if (stored) return;
    fetchUserAttributes()
      .then((attrs) => {
        const lang = resolveInitialLanguage({
          customLang: attrs['custom:lang'],
          navigatorLanguage: navigator.language,
        });
        return changeLanguage(lang as PortalLanguage);
      })
      .catch(() => undefined);
  }, []);

  useEffect(() => {
    session.start({
      signOut: () => amplifySignOut(),
      pauseAllDownloads: (reason) => splitEngine.pauseAll(reason),
      failZips: failAllZips,
      onSessionExpired: (cause) => {
        showBanner(t(cause === 'IDLE' ? 'auth.idleSignedOut' : 'auth.sessionExpiredBanner'), 'warning');
        toSignIn();
      },
      listenAuthHub: (onSignedOut) =>
        Hub.listen('auth', ({ payload }) => {
          if (payload.event === 'signedOut' || payload.event === 'tokenRefresh_failure') onSignedOut();
        }),
    });
    return () => session.stop();
  }, [t, toSignIn]);

  const handleSignOut = () => {
    // R1.6: confirm when a split download is still transferring
    if (session.activeDownloadCount > 0 && !window.confirm(t('auth.signOutWithDownloads'))) return;
    void splitEngine.pauseAll('USER').then(() => signOut?.());
  };

  return (
    <>
      <Brand email={email} onSignOut={handleSignOut} />
      <Portal />
    </>
  );
}
