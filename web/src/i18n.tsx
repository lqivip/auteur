import React, { createContext, useContext, useEffect, useState } from 'react';
import { en, type LocaleKey } from './locales/en.js';
import { zh } from './locales/zh.js';
import { ja } from './locales/ja.js';

export type Locale = 'zh' | 'en' | 'ja';

const DICTS: Record<Locale, Record<string, string>> = { en, zh, ja };
const STORAGE_KEY = 'auteur-lang';

/**
 * First-launch language: stored choice, else the system language when it is
 * one of the three supported locales, else English (SPEC 5.1).
 */
export function detectLocale(): Locale {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored === 'zh' || stored === 'en' || stored === 'ja') return stored;
  } catch { /* storage unavailable */ }
  const sys = (navigator.language ?? '').toLowerCase();
  if (sys.startsWith('zh')) return 'zh';
  if (sys.startsWith('ja')) return 'ja';
  return 'en';
}

interface I18nCtx {
  locale: Locale;
  setLocale: (l: Locale) => void;
  t: (key: LocaleKey, vars?: Record<string, string | number>) => string;
}

const Ctx = createContext<I18nCtx>({
  locale: 'en',
  setLocale: () => undefined,
  t: (key) => key,
});

export function I18nProvider({ children }: { children: React.ReactNode }) {
  const [locale, setLocaleState] = useState<Locale>(detectLocale);

  useEffect(() => {
    document.documentElement.lang = locale === 'zh' ? 'zh-CN' : locale;
  }, [locale]);

  const setLocale = (l: Locale) => {
    setLocaleState(l);
    try { localStorage.setItem(STORAGE_KEY, l); } catch { /* ignore */ }
  };

  const t = (key: LocaleKey, vars?: Record<string, string | number>): string => {
    let text = DICTS[locale][key] ?? DICTS.en[key] ?? key;
    if (vars) {
      for (const [k, v] of Object.entries(vars)) text = text.replaceAll(`{${k}}`, String(v));
    }
    return text;
  };

  return <Ctx.Provider value={{ locale, setLocale, t }}>{children}</Ctx.Provider>;
}

export function useI18n(): I18nCtx {
  return useContext(Ctx);
}

export function LanguageSwitcher() {
  const { locale, setLocale } = useI18n();
  return (
    <select
      className="lang-switcher"
      value={locale}
      onChange={(e) => setLocale(e.target.value as Locale)}
      aria-label="Language"
    >
      <option value="zh">简体中文</option>
      <option value="en">English</option>
      <option value="ja">日本語</option>
    </select>
  );
}
