import { useEffect, useState } from 'react';
import { chatAppearance, resolveChatAppearance, type ChatAppearance } from '@/lib/persistence/storage';

/**
 * 订阅对话区外观（已规范化）。首次读出前返回 null，调用方据此推迟渲染，避免先按默认字号
 * 画一帧再跳变。
 *
 * 先挂 watch 再读初值：若初读返回前已有更新推送进来，丢弃迟到的初读，免得旧值覆盖新值。
 * 读失败时按默认外观放行，不让对话区永远空白。
 */
export function useChatAppearance(): ChatAppearance | null {
  const [value, setValue] = useState<ChatAppearance | null>(null);

  useEffect(() => {
    let active = true;
    let updated = false;
    const unwatch = chatAppearance.watch((next) => {
      updated = true;
      if (active) setValue(resolveChatAppearance(next));
    });
    chatAppearance
      .getValue()
      .then((initial) => {
        if (active && !updated) setValue(resolveChatAppearance(initial));
      })
      .catch((err) => {
        console.warn('[chat-appearance] load failed, using defaults:', err);
        if (active && !updated) setValue(resolveChatAppearance(null));
      });
    return () => {
      active = false;
      unwatch();
    };
  }, []);

  return value;
}
