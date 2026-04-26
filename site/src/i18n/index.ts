import { zh } from './zh';
import { en } from './en';
import type { Dict } from './types';

export type Lang = 'zh' | 'en';

export const languages: Record<Lang, { name: string; shortName: string; htmlLang: string }> = {
  zh: { name: '简体中文', shortName: 'ZH', htmlLang: 'zh-CN' },
  en: { name: 'English', shortName: 'EN', htmlLang: 'en' },
};

export const dicts: Record<Lang, Dict> = { zh, en };

export function getDict(lang: Lang): Dict {
  return dicts[lang];
}

/**
 * Resolve the current language from an Astro url pathname like /zh/install.
 * Falls back to zh.
 */
export function langFromUrl(url: URL): Lang {
  const seg = url.pathname.split('/').filter(Boolean)[0];
  if (seg === 'en') return 'en';
  return 'zh';
}

/**
 * Build a link for a given route in the given language.
 * Paths should be written *without* the leading /zh or /en.
 */
export function localePath(lang: Lang, path: string): string {
  const clean = path.startsWith('/') ? path : `/${path}`;
  return `/${lang}${clean === '/' ? '' : clean}`;
}

/**
 * Compute the counterpart path on the opposite locale. Used by the language toggle.
 */
export function alternatePath(currentPath: string, targetLang: Lang): string {
  // Normalize: split off leading locale segment
  const parts = currentPath.split('/').filter(Boolean);
  if (parts[0] === 'zh' || parts[0] === 'en') parts.shift();
  const rest = parts.length ? '/' + parts.join('/') : '';
  return `/${targetLang}${rest}`;
}
