/**
 * Unified clipboard access.
 *
 * All Cebian source must use this helper instead of calling
 * `navigator.clipboard.*` directly. Reasons:
 *   - Single fallback path (legacy `execCommand('copy')`) for the rare cases
 *     when the side panel loses focus and the modern API rejects.
 *   - Consistent toast feedback so callers don't have to re-implement it.
 *   - Easier to swap implementations later (e.g. background-bridged copy for
 *     content scripts).
 *
 * Never log the `text` argument: clipboard data may include OAuth codes or
 * API keys.
 */

import { toast } from 'sonner';
import { t } from '@/lib/i18n';

interface CopyOptions {
  /** Suppress success/failure toasts; caller handles its own feedback. */
  silent?: boolean;
}

export async function copyText(text: string, opts: CopyOptions = {}): Promise<boolean> {
  const ok = await tryCopy(text);
  if (!opts.silent) {
    if (ok) toast.success(t('common.copied'));
    else toast.error(t('common.copyFailed'));
  }
  return ok;
}

export async function readText(): Promise<string> {
  try {
    if (navigator.clipboard?.readText) return await navigator.clipboard.readText();
  } catch {
    /* fall through */
  }
  return '';
}

async function tryCopy(text: string): Promise<boolean> {
  // Modern API — works in secure contexts when the document is focused.
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    /* fall through to legacy path */
  }
  // Legacy fallback: hidden textarea + execCommand('copy').
  try {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.setAttribute('readonly', '');
    ta.style.position = 'fixed';
    ta.style.top = '-9999px';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.focus();
    ta.select();
    const ok = document.execCommand('copy');
    document.body.removeChild(ta);
    return ok;
  } catch {
    return false;
  }
}
