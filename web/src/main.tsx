import '@aws-amplify/ui-react/styles.css';
import '@aws-amplify/ui-react-storage/styles.css';
import { ThemeProvider } from '@aws-amplify/ui-react';
import { Amplify } from 'aws-amplify';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { loadConfig } from './config';
import { initI18n, LANGUAGE_STORAGE_KEY, resolveInitialLanguage } from './i18n';
import { buildBrandTheme } from './theme';

/**
 * Boot sequence (T3.1): fetch `/config.json` → `Amplify.configure` (Cognito user pool + client) → brand theme →
 * i18n → render. Nothing renders until the runtime config is in place, so no module reads a stale config.
 */
async function bootstrap(): Promise<void> {
  const root = createRoot(document.getElementById('root') as HTMLElement);
  try {
    const cfg = await loadConfig();
    Amplify.configure({
      Auth: {
        Cognito: {
          userPoolId: cfg.userPoolId,
          userPoolClientId: cfg.clientId,
          loginWith: { email: true },
        },
      },
    });
    let stored: string | null = null;
    try {
      stored = localStorage.getItem(LANGUAGE_STORAGE_KEY);
    } catch {
      stored = null;
    }
    const lang = resolveInitialLanguage({ stored, navigatorLanguage: navigator.language });
    await initI18n(lang);
    document.documentElement.lang = lang;
    document.title = cfg.brand.name;
    const theme = buildBrandTheme(cfg.brand);
    root.render(
      <StrictMode>
        <ThemeProvider theme={theme}>
          <App />
        </ThemeProvider>
      </StrictMode>,
    );
  } catch (err) {
    console.error(err);
    root.render(
      <div role="alert" style={{ padding: '2rem', fontFamily: 'system-ui, sans-serif' }}>
        <h1>Genome Data Portal</h1>
        <p>The portal configuration could not be loaded. Please try again later.</p>
        <p>포털 설정을 불러오지 못했습니다. 잠시 후 다시 시도하세요.</p>
      </div>,
    );
  }
}

void bootstrap();
