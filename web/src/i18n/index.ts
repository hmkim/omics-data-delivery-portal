import i18next, { type TFunction } from 'i18next';
import { initReactI18next } from 'react-i18next';
import en from './en.json';
import ko from './ko.json';

export type PortalLanguage = 'ko' | 'en';

export const resources = {
  ko: { translation: ko },
  en: { translation: en },
} as const;

export const LANGUAGE_STORAGE_KEY = 'genome-portal.lang';

/**
 * Initial language (R3.6, §5.5): explicit user choice in this browser → Cognito `custom:lang` → `navigator.language`.
 */
export function resolveInitialLanguage(input: {
  stored?: string | null;
  customLang?: string | null;
  navigatorLanguage?: string | null;
}): PortalLanguage {
  const candidates = [input.stored, input.customLang, input.navigatorLanguage];
  for (const c of candidates) {
    if (!c) continue;
    const lower = c.toLowerCase();
    if (lower.startsWith('ko')) return 'ko';
    if (lower.startsWith('en')) return 'en';
  }
  return 'en';
}

let initialized = false;

export async function initI18n(lng: PortalLanguage): Promise<typeof i18next> {
  if (!initialized) {
    await i18next.use(initReactI18next).init({
      resources,
      lng,
      fallbackLng: 'en',
      supportedLngs: ['ko', 'en'],
      interpolation: { escapeValue: false },
      returnNull: false,
    });
    initialized = true;
  } else if (i18next.language !== lng) {
    await i18next.changeLanguage(lng);
  }
  return i18next;
}

export async function changeLanguage(lng: PortalLanguage): Promise<void> {
  await i18next.changeLanguage(lng);
  try {
    localStorage.setItem(LANGUAGE_STORAGE_KEY, lng);
  } catch {
    // storage unavailable (private mode); language still switches for this page load
  }
  if (typeof document !== 'undefined') document.documentElement.lang = lng;
}

/** Flattened dotted key list of a dictionary; used by the key-parity test and the displayText builder. */
export function flattenKeys(obj: unknown, prefix = ''): string[] {
  if (typeof obj !== 'object' || obj === null) return [prefix];
  return Object.entries(obj as Record<string, unknown>).flatMap(([k, v]) =>
    flattenKeys(v, prefix ? `${prefix}.${k}` : k),
  );
}

export { i18next };
export type { TFunction };
