import { RotateCcw } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { CopyButton } from '@/components/common/CopyButton';
import { SpeakButton } from '@/components/common/SpeakButton';
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
  /** When provided, a copy button is rendered on the left of the row,
   *  before any retry button. */
  text?: string;
  /** When provided (alongside `text`), a read-aloud button is rendered to the
   *  left of the copy button. Lazily yields the message's plain text. */
  getSpeakText?: () => string;
  /** When provided, a retry button is rendered next to the copy button.
   *  The caller decides eligibility (last turn-closing assistant, agent idle, etc.). */
  onRetry?: () => void;
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
  modelLabel, inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens, text, getSpeakText, onRetry,
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

  if (parts.length === 0 && !text && !onRetry) return null;

  const retryLabel = t('chat.message.retry');

  // `ml-auto` on the meta span pushes it to the right whether or not the
  // left-side action buttons are rendered. With `justify-between`, lone
  // left content would flush left — wrong for an "end-of-turn" footer.
  // When `parts` are absent entirely, action buttons sit left-aligned
  // alone (the meta span is omitted, not just emptied).
  return (
    <div className="mt-2 flex items-center gap-2 text-[0.7rem] text-muted-foreground/70">
      {text && getSpeakText && <SpeakButton getText={getSpeakText} />}
      {text && <CopyButton text={text} />}
      {onRetry && (
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="ghost"
              size="icon"
              className="size-7 text-muted-foreground hover:text-foreground"
              onClick={onRetry}
              aria-label={retryLabel}
            >
              <RotateCcw className="size-3.5" />
            </Button>
          </TooltipTrigger>
          <TooltipContent>{retryLabel}</TooltipContent>
        </Tooltip>
      )}
      {parts.length > 0 && <span className="ml-auto font-mono">{parts.join(' · ')}</span>}
    </div>
  );
}
