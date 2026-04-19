import { CopyButton } from './CopyButton';
import { t } from '@/lib/i18n';

export interface MessageMetaProps {
  modelLabel?: string;
  inputTokens?: number;
  outputTokens?: number;
  costUsd?: number;
  /** When provided, a copy button is rendered at the end of the row. */
  text?: string;
}

function formatTokens(n?: number): string {
  if (n == null) return '—';
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
  return String(n);
}

/**
 * End-of-turn meta row: model · `↑in ↓out` · cost · (copy).
 *
 * Always visible once the turn ends — the meta is the primary signal that
 * the message is complete. Parts that have no data are silently omitted.
 */
export function MessageMetaRow({
  modelLabel, inputTokens, outputTokens, costUsd, text,
}: MessageMetaProps) {
  const parts: string[] = [];
  if (modelLabel) parts.push(modelLabel);
  if (inputTokens != null || outputTokens != null) {
    parts.push(t('chat.message.tokensInOut', [
      formatTokens(inputTokens),
      formatTokens(outputTokens),
    ]));
  }
  if (costUsd != null && costUsd > 0) {
    // `$` is universal for USD across our locales; inline rather than wrap a
    // single-substitution i18n key that would only echo its argument.
    parts.push(`$${costUsd.toFixed(4)}`);
  }

  if (parts.length === 0 && !text) return null;

  return (
    <div className="mt-2 flex items-center justify-between gap-2 text-[0.7rem] text-muted-foreground/70">
      <span className="font-mono">{parts.join(' · ')}</span>
      {text && <CopyButton text={text} />}
    </div>
  );
}
