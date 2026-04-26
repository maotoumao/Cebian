/**
 * useUpdateCheck — fetches the latest Cebian release from GitHub and compares
 * against the currently installed extension version.
 *
 * Result is cached in localStorage for 6 hours to avoid hitting the API on
 * every About-page mount. Call `recheck()` to force-refresh.
 */
import { useCallback, useEffect, useRef, useState } from 'react';

const CACHE_KEY = 'cebian:updateCheck';
const CACHE_TTL_MS = 6 * 60 * 60 * 1000; // 6h
const RELEASES_URL = 'https://api.github.com/repos/maotoumao/Cebian/releases/latest';

export type UpdateStatus =
  | { kind: 'idle' }
  | { kind: 'checking' }
  | { kind: 'upToDate'; current: string; latest: string }
  | { kind: 'updateAvailable'; current: string; latest: string }
  | { kind: 'error' };

interface CacheEntry {
  checkedAt: number;
  latest: string;
}

function readCache(): CacheEntry | null {
  try {
    const raw = localStorage.getItem(CACHE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as CacheEntry;
    if (typeof parsed.checkedAt !== 'number' || typeof parsed.latest !== 'string') return null;
    return parsed;
  } catch {
    return null;
  }
}

function writeCache(entry: CacheEntry): void {
  try {
    localStorage.setItem(CACHE_KEY, JSON.stringify(entry));
  } catch {
    // ignore quota / disabled storage
  }
}

/**
 * Compare two semver-like strings. Strips any prerelease/build suffix
 * (anything after `-` or `+`) before numeric `a.b.c` comparison.
 * Returns 1, 0, -1.
 */
function compareVersions(a: string, b: string): number {
  const stripSuffix = (s: string) => s.split(/[-+]/)[0];
  const pa = stripSuffix(a).split('.').map((n) => parseInt(n, 10) || 0);
  const pb = stripSuffix(b).split('.').map((n) => parseInt(n, 10) || 0);
  const len = Math.max(pa.length, pb.length);
  for (let i = 0; i < len; i++) {
    const da = pa[i] ?? 0;
    const db = pb[i] ?? 0;
    if (da > db) return 1;
    if (da < db) return -1;
  }
  return 0;
}

function stripV(tag: string): string {
  return tag.replace(/^v/i, '').trim();
}

function buildStatus(current: string, latest: string): UpdateStatus {
  return compareVersions(latest, current) > 0
    ? { kind: 'updateAvailable', current, latest }
    : { kind: 'upToDate', current, latest };
}

function initialStatus(current: string): UpdateStatus {
  const cached = readCache();
  if (cached && Date.now() - cached.checkedAt < CACHE_TTL_MS) {
    return buildStatus(current, cached.latest);
  }
  return { kind: 'idle' };
}

export function useUpdateCheck() {
  const current = chrome.runtime.getManifest().version;
  const [status, setStatus] = useState<UpdateStatus>(() => initialStatus(current));
  const inflightRef = useRef(false);
  const mountedRef = useRef(true);
  const abortRef = useRef<AbortController | null>(null);

  const runCheck = useCallback(
    async (force: boolean) => {
      if (inflightRef.current) return;

      if (!force) {
        const cached = readCache();
        if (cached && Date.now() - cached.checkedAt < CACHE_TTL_MS) {
          if (mountedRef.current) setStatus(buildStatus(current, cached.latest));
          return;
        }
      }

      inflightRef.current = true;
      const controller = new AbortController();
      abortRef.current = controller;
      if (mountedRef.current) setStatus({ kind: 'checking' });
      try {
        const res = await fetch(RELEASES_URL, {
          headers: { Accept: 'application/vnd.github+json' },
          signal: controller.signal,
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = (await res.json()) as { tag_name?: string; prerelease?: boolean };
        if (data.prerelease) throw new Error('latest release is a prerelease');
        const latest = data.tag_name ? stripV(data.tag_name) : '';
        if (!latest) throw new Error('missing tag_name');
        writeCache({ checkedAt: Date.now(), latest });
        if (mountedRef.current) setStatus(buildStatus(current, latest));
      } catch (err) {
        if ((err as Error)?.name === 'AbortError') return;
        console.warn('[useUpdateCheck] update check failed:', err);
        if (mountedRef.current) setStatus({ kind: 'error' });
      } finally {
        inflightRef.current = false;
        if (abortRef.current === controller) abortRef.current = null;
      }
    },
    [current],
  );

  useEffect(() => {
    mountedRef.current = true;
    void runCheck(false);
    return () => {
      mountedRef.current = false;
      abortRef.current?.abort();
    };
  }, [runCheck]);

  const recheck = useCallback(() => runCheck(true), [runCheck]);

  return { status, current, recheck };
}

/**
 * Resolves the install-guide URL on cebian.catcat.work based on the current
 * UI language. Chinese locales (zh, zh_CN, zh_TW, zh_HK) all map to /zh;
 * everything else falls back to /en.
 *
 * TODO: add a /zh-tw path once the install guide site ships a Traditional
 * Chinese variant — currently zh_TW users get the Simplified guide.
 */
export function getInstallGuideUrl(): string {
  const lang = chrome.i18n.getUILanguage().toLowerCase();
  const path = lang.startsWith('zh') ? '/zh/install-guide' : '/en/install-guide';
  return `https://cebian.catcat.work${path}`;
}

