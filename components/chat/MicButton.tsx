// 语音输入按钮（纯展示）。
//
// 放在输入框底部行、发送按钮左侧。本组件只负责「按状态渲染图标 + 触发
// onClick」，不持有语音识别逻辑——hook（useSpeechRecognition）由 ChatInput
// 持有，因为识别结果要写进它的输入框、interim 要在它的 textarea 里预览。
// 这与 RecordButton 自持 useRecorder 不同：语音识别的产出与输入框强耦合，
// 所以状态上提到 ChatInput，按钮退化为受控的展示件。
//
// 与 RecordButton（操作录制，CircleDot 图标）区分：语音输入用 Mic 图标，
// 听写中以 primary 色 + 脉动表达「正在进行」，准备语言包时显示 spinner。

import { Mic } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Spinner } from '@/components/ui/spinner';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { t } from '@/lib/i18n';
import type { SpeechState } from '@/hooks/useSpeechRecognition';

export interface MicButtonProps {
  state: SpeechState;
  onClick: () => void;
  /** 由 ChatInput 在派发中禁用（与其它工具按钮一致）。听写中不受此影响——
   *  停止识别始终允许。 */
  disabled?: boolean;
}

export function MicButton({ state, onClick, disabled }: MicButtonProps) {
  const listening = state === 'listening';
  const preparing = state === 'preparing';

  const label = listening
    ? t('chat.composer.voiceStop')
    : preparing
      ? t('chat.composer.voicePreparing')
      : t('chat.composer.voiceStart');

  // span 包裹：按钮 disabled 时本身不接收指针事件，靠外层 span 触发 tooltip
  // （与 ChatInput 截图按钮同一路数，保证「准备中」等禁用态也能看到提示）。
  // relative 容器用于叠加听写中的脉冲光环。
  // 听写中：麦克风外圈不断扩散的脉冲光环，比单纯图标闪烁更醒目，且与
  // RecordButton 的 CircleDot 形态区分开。
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span className="relative inline-flex">
          {listening && (
            <span className="pointer-events-none absolute inset-0 animate-mic-pulse rounded-full bg-primary/30" />
          )}
          <Button
            variant="ghost"
            size="icon-xs"
            onClick={onClick}
            // 准备语言包时禁用点击（下载不可中断）；派发中也禁用，但听写中允许
            // 点击以停止。
            disabled={preparing || (disabled && !listening)}
            aria-label={label}
            aria-pressed={listening}
            className={
              listening
                ? 'relative bg-primary/15 text-primary hover:bg-primary/25 hover:text-primary'
                : ''
            }
          >
            {preparing ? (
              <Spinner className="size-3.5" />
            ) : (
              <Mic className={`size-3.5 ${listening ? 'animate-pulse' : ''}`} />
            )}
          </Button>
        </span>
      </TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  );
}
