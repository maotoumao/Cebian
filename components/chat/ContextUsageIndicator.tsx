import { useId } from 'react';
import { Button } from '@/components/ui/button';
import {
  Popover,
  PopoverContent,
  PopoverDescription,
  PopoverHeader,
  PopoverTitle,
  PopoverTrigger,
} from '@/components/ui/popover';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import type { ContextUsage } from '@/lib/ipc/protocol';
import { formatCompactCount } from '@/lib/utils';
import { t } from '@/lib/i18n';

/** 环形进度的几何参数（viewBox 单位）。 */
const RADIUS = 7;
const CIRCUMFERENCE = 2 * Math.PI * RADIUS;

/** 提示「快到压缩点了」的提前量：进入触发点的这个比例内就转成警示色。 */
const NEAR_TRIGGER_RATIO = 0.9;

type Tone = 'normal' | 'near' | 'over';

/** 占用配色只有三档：正常（低调）、接近压缩点（警示）、已过压缩点（更强的警示）。 */
function toneOf(tokens: number, triggerTokens: number | null): Tone {
  if (triggerTokens === null) return 'normal';
  if (tokens >= triggerTokens) return 'over';
  return tokens >= triggerTokens * NEAR_TRIGGER_RATIO ? 'near' : 'normal';
}

// 色阶只升不降：amber 是仓里既定的警示色，越过压缩点再往上走到 destructive。
// 用 primary 会读成「松一口气」，与语义相反。
const RING_CLASS: Record<Tone, string> = {
  normal: 'text-muted-foreground',
  near: 'text-amber-500',
  over: 'text-destructive',
};

/**
 * 输入框右下角的上下文占用环：点开是一个小窗，报当前会话占了模型窗口的多少。
 *
 * 数字一律来自后台（`context_usage` 帧），不在前端重算——前端拿不到模型的
 * `contextWindow`，而且两处各算一套必然漂移，会出现「显示 75% 却已经开始压缩」。
 *
 * 窄侧栏里只画环、不显示百分比，数字留给小窗；环本身足够表达「快满了」。
 *
 * 已知局限：在输入框里改了模型但还没发送时，环的分母仍是会话**当前实际在用**的模型
 * 窗口——模型选择在发送前只是前端草稿，后台并不知情。下一轮发出去之后即自动纠正。
 */
export function ContextUsageIndicator({ usage }: { usage: ContextUsage | null }) {
  const titleId = useId();
  // 没收到过快照、或模型没声明窗口（画不出比例）时整个不渲染，不占位、不显示假数据。
  // 显式挡掉 NaN：`NaN <= 0` 是 false，漏过去会渲染出 "NaN%" 和非法的 strokeDashoffset。
  if (!usage || !Number.isFinite(usage.contextWindow) || usage.contextWindow <= 0) return null;

  // 文字用真实百分比，只有环的填充夹到 [0,1]：超窗时（120K/100K）夹了文字就会显示
  // "100%"，把「超出多少」这个最要紧的信息藏起来。
  const rawRatio = usage.tokens / usage.contextWindow;
  const percent = Math.round(rawRatio * 100);
  const tone = toneOf(usage.tokens, usage.triggerTokens);
  const label = t('chat.contextUsage.label', [String(percent)]);

  return (
    <Popover>
      <Tooltip>
        <TooltipTrigger asChild>
          <PopoverTrigger asChild>
            <Button variant="ghost" size="icon-xs" aria-label={label} className="size-7">
              <svg viewBox="0 0 18 18" className={`size-4 -rotate-90 ${RING_CLASS[tone]}`} aria-hidden="true">
                <circle cx="9" cy="9" r={RADIUS} fill="none" stroke="currentColor" strokeWidth="2" className="opacity-20" />
                <circle
                  cx="9"
                  cy="9"
                  r={RADIUS}
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeDasharray={CIRCUMFERENCE}
                  strokeDashoffset={CIRCUMFERENCE * (1 - Math.min(1, Math.max(0, rawRatio)))}
                />
              </svg>
            </Button>
          </PopoverTrigger>
        </TooltipTrigger>
        <TooltipContent>{label}</TooltipContent>
      </Tooltip>
      {/*
       * aria-labelledby：按钮的 aria-label 不会自动成为 dialog 的名称，要显式指到标题上。
       */}
      <PopoverContent align="end" aria-labelledby={titleId} className="w-64 space-y-2 p-3">
        <PopoverHeader className="flex-row items-baseline justify-between gap-2 p-0">
          <PopoverTitle id={titleId} className="text-sm font-medium">
            {t('chat.contextUsage.title')}
          </PopoverTitle>
          <span className="text-sm tabular-nums text-muted-foreground">{percent}%</span>
        </PopoverHeader>
        <PopoverDescription className="text-xs tabular-nums">
          {t('chat.contextUsage.amount', [
            formatCompactCount(usage.tokens),
            formatCompactCount(usage.contextWindow),
          ])}
        </PopoverDescription>
        <PopoverDescription className="text-xs">
          {usage.triggerTokens === null
            ? t('chat.contextUsage.compactionOff')
            : t('chat.contextUsage.threshold', [
                String(Math.round((usage.triggerTokens / usage.contextWindow) * 100)),
              ])}
        </PopoverDescription>
        <PopoverDescription className="text-[0.7rem] text-muted-foreground/70">
          {t('chat.contextUsage.estimateNote')}
        </PopoverDescription>
      </PopoverContent>
    </Popover>
  );
}
