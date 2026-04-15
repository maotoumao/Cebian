import { useState, useEffect } from 'react';
import { useStorageItem } from './useStorageItem';
import { themePreference } from '@/lib/storage';

/**
 * Reactive hook that returns whether the current theme is dark.
 * Handles 'system' preference by listening to OS `prefers-color-scheme`.
 */
export function useIsDark(): boolean {
  const [theme] = useStorageItem(themePreference, 'system');
  const [matchesDark, setMatchesDark] = useState(
    () => window.matchMedia('(prefers-color-scheme: dark)').matches,
  );

  useEffect(() => {
    if (theme !== 'system') return;
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    const handler = (e: MediaQueryListEvent) => setMatchesDark(e.matches);
    mq.addEventListener('change', handler);
    return () => mq.removeEventListener('change', handler);
  }, [theme]);

  if (theme === 'light') return false;
  if (theme === 'dark') return true;
  return matchesDark;
}
