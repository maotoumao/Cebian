// 行内改名输入框（页头标题 / 历史列表行共用，本身不绑定任何领域）：Enter 提交、Esc 取消、
// 失焦提交，IME 组词中的 Enter 忽略（对齐 ChatInput / 消息编辑的习惯）。提交或取消只会
// 触发一次——Enter 之后紧跟的 blur 不会二次提交。清空视为取消，不回退成任何默认值。

import { useEffect, useRef, useState } from 'react';
import { cn } from '@/lib/utils';

interface InlineRenameInputProps {
  /** 进入编辑态时的初值；提交值与之相同则视为取消。只在挂载时读取——编辑途中外部
   *  （别的窗口的改名广播）改了这个值，不影响本次编辑的比较基准。 */
  initial: string;
  onCommit: (next: string) => void;
  onCancel: () => void;
  ariaLabel: string;
  /** 长度上限由调用方按领域给（如会话标题的 MAX_SESSION_TITLE_LENGTH）。 */
  maxLength?: number;
  className?: string;
}

export function InlineRenameInput({ initial, onCommit, onCancel, ariaLabel, maxLength, className }: InlineRenameInputProps) {
  const [draft, setDraft] = useState(initial);
  // 比较基准固定为挂载时的值：若跟着最新 prop 走，未编辑的旧草稿会在外部改名后被当成
  // 「改动」提交回去，把别处刚改好的标题覆盖掉。
  const baseRef = useRef(initial);
  const inputRef = useRef<HTMLInputElement>(null);
  const doneRef = useRef(false);

  useEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
  }, []);

  const finish = (save: boolean) => {
    if (doneRef.current) return;
    doneRef.current = true;
    const next = draft.trim();
    if (save && next && next !== baseRef.current) onCommit(next);
    else onCancel();
  };

  return (
    <input
      ref={inputRef}
      value={draft}
      onChange={(e) => setDraft(e.target.value)}
      maxLength={maxLength}
      aria-label={ariaLabel}
      // 宿主可能是 role="button" 的整行 / 页头：点击、按键、指针按下都就地拦下，免得触发
      // 宿主动作。pointerdown 也要拦：在输入框里拖选文字、鼠标在行上松开，click 会落到
      // 二者的公共祖先（整行）上。
      onPointerDown={(e) => e.stopPropagation()}
      onClick={(e) => e.stopPropagation()}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.nativeEvent.isComposing) return;
        if (e.key === 'Enter') {
          e.preventDefault();
          finish(true);
        } else if (e.key === 'Escape') {
          e.preventDefault();
          finish(false);
        }
      }}
      onBlur={() => finish(true)}
      className={cn('min-w-0 bg-transparent outline-none border-b border-border', className)}
    />
  );
}
