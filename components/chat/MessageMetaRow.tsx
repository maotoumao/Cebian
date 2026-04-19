import { CopyButton } from './CopyButton';
import { t } from '@/lib/i18n';

export interface MessageMetaProps {
  modelLabel?: string;
  /** Uncached input tokens (pi-ai `usage.input`). */
  inputTokens?: number;
  outputTokens?: number;
  /** Tokens served from prompt cache (pi-ai `usage.cacheRead`). */
  cacheReadTokens?: number;
  /** Tokens written to prompt cache (pi-ai `usage.cacheWrite`). */
  cacheWriteTokens?: number;
  /** When provided, a copy button is rendered at the end of the row. */
  text?: string;
}

function formatTokens(n: number): string {
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
  return String(n);
}

/**
 * End-of-turn meta row: model · `↑totalIn (uncached … · hit … · write …) ↓out` · (copy).
 *
 * `↑` shows the *real* input token count (uncached + cacheRead + cacheWrite),
 * which is what was actually sent to the API. The breakdown in parentheses
 * splits that total into the three pricing tiers. The breakdown is omitted
 * entirely when no cache activity occurred.
 */
export function MessageMetaRow({
  modelLabel, inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens, text,
}: MessageMetaProps) {
  const parts: string[] = [];
  if (modelLabel) parts.push(modelLabel);

  const uncached = inputTokens ?? 0;
  const cacheRead = cacheReadTokens ?? 0;
  const cacheWrite = cacheWriteTokens ?? 0;
  const realInput = uncached + cacheRead + cacheWrite;
  const out = outputTokens ?? 0;

  if (realInput > 0 || out > 0) {
    let inLabel = formatTokens(realInput);
    if (cacheRead > 0 || cacheWrite > 0) {
      const breakdown = cacheWrite > 0
        ? t('chat.message.tokensInBreakdownHitWrite', [
            formatTokens(uncached),
            formatTokens(cacheRead),
            formatTokens(cacheWrite),
          ])
        : t('chat.message.tokensInBreakdownHit', [
            formatTokens(uncached),
            formatTokens(cacheRead),
          ]);
      inLabel = `${formatTokens(realInput)} (${breakdown})`;
    }
    parts.push(t('chat.message.tokensInOut', [inLabel, formatTokens(out)]));
  }

  if (parts.length === 0 && !text) return null;

  return (
    <div className="mt-2 flex items-center justify-between gap-2 text-[0.7rem] text-muted-foreground/70">
      <span className="font-mono">{parts.join(' · ')}</span>
      {text && <CopyButton text={text} />}
    </div>
  );
}
