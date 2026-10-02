import i18next from 'i18next';
import { describe, expect, it } from 'vitest';
import { buildDisplayText } from './displayText';
import en from './en.json';
import { flattenKeys, resolveInitialLanguage, resources } from './index';
import ko from './ko.json';

describe('i18n dictionaries (T3.2)', () => {
  it('ko and en have identical key sets', () => {
    const koKeys = flattenKeys(ko).sort();
    const enKeys = flattenKeys(en).sort();
    expect(koKeys).toEqual(enKeys);
    expect(koKeys.length).toBeGreaterThan(100);
  });

  it('no empty values except intentionally blank Storage Browser headers', () => {
    const allowedEmpty = new Set(['storageBrowser.shared.tableColumnCancelHeader']);
    for (const dict of [ko, en]) {
      const stack: Array<[string, unknown]> = [['', dict]];
      while (stack.length) {
        const [prefix, node] = stack.pop() as [string, unknown];
        if (typeof node === 'string') {
          if (!allowedEmpty.has(prefix)) expect(node.length, prefix).toBeGreaterThan(0);
        } else if (node && typeof node === 'object') {
          for (const [k, v] of Object.entries(node)) stack.push([prefix ? `${prefix}.${k}` : k, v]);
        }
      }
    }
  });

  it('portal strings required by the design exist', () => {
    for (const key of [
      'toast.viaS3',
      'toast.viaCloudFront',
      'toast.noResumeInThisBrowser',
      'auth.sessionExpiredBanner',
      'badge.split',
      'badge.command',
      'zip.excludedOverLimit',
      'preview.downloadToView',
    ]) {
      const value = key.split('.').reduce<unknown>((o, k) => (o as Record<string, unknown>)[k], ko);
      expect(typeof value, key).toBe('string');
    }
    expect(ko.toast.noResumeInThisBrowser).toContain('이어받기');
    expect(ko.badge.split).toBe('분할·이어받기');
    expect(ko.badge.command).toBe('명령어 다운로드');
  });

  it('buildDisplayText resolves every string for both languages (no missing-key echoes)', async () => {
    const inst = i18next.createInstance();
    await inst.init({ resources, lng: 'ko', fallbackLng: 'en', interpolation: { escapeValue: false } });
    for (const lng of ['ko', 'en'] as const) {
      await inst.changeLanguage(lng);
      const dt = buildDisplayText(inst.t.bind(inst), lng);
      const walk = (node: unknown, path: string) => {
        if (typeof node === 'string') expect(node.startsWith('storageBrowser.'), path).toBe(false);
        else if (typeof node === 'function') return;
        else if (node && typeof node === 'object')
          for (const [k, v] of Object.entries(node)) walk(v, `${path}.${k}`);
      };
      walk(dt, lng);
      expect(dt.LocationDetailView?.getActionListItemLabel?.('Download')).toBe(
        lng === 'ko' ? '다운로드' : 'Download',
      );
      expect(
        dt.DownloadView?.getActionCompleteMessage?.({ counts: { COMPLETE: 2, FAILED: 0, TOTAL: 2 } as never })
          ?.type,
      ).toBe('success');
    }
  });

  it('resolveInitialLanguage: stored → custom:lang → navigator → en', () => {
    expect(resolveInitialLanguage({ stored: 'en', customLang: 'ko', navigatorLanguage: 'ko-KR' })).toBe('en');
    expect(resolveInitialLanguage({ customLang: 'ko', navigatorLanguage: 'en-US' })).toBe('ko');
    expect(resolveInitialLanguage({ navigatorLanguage: 'ko-KR' })).toBe('ko');
    expect(resolveInitialLanguage({ navigatorLanguage: 'de-DE' })).toBe('en');
    expect(resolveInitialLanguage({})).toBe('en');
  });
});
