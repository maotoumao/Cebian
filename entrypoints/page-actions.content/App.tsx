import { useEffect, useState } from 'react';
import { announcePresent, subscribeSuppress } from '@/lib/page-actions/channel';
import { FloatingBall } from './FloatingBall';
import { SelectionToolbar } from './SelectionToolbar';

/**
 * 是否应隐藏页面注入 UI：
 * - 取词 picker 激活（页面出现 `#cebian-picker-host`）——内容脚本自行观察 DOM
 * - 录制进行中——background 向被观察 tab 广播 suppress
 * 两种情况都隐藏悬浮球与工具条，避免抢事件 / 误点击 / 录制噪声。
 */
function useSuppressed(): boolean {
  const [pickerActive, setPickerActive] = useState(
    () => !!document.getElementById('cebian-picker-host'),
  );
  const [recording, setRecording] = useState(false);

  useEffect(() => {
    const check = () => setPickerActive(!!document.getElementById('cebian-picker-host'));
    const observer = new MutationObserver(check);
    observer.observe(document.documentElement, { childList: true });
    check();
    const unsubscribe = subscribeSuppress(setRecording);
    // 回报存在，让 background 把当前抑制态推回（应对录制中途挂载）。
    announcePresent();
    return () => {
      observer.disconnect();
      unsubscribe();
    };
  }, []);

  return pickerActive || recording;
}

/** 页面注入 UI 根：承载悬浮球与划词工具条，取词 / 录制时整体隐藏。 */
export function PageActionsApp() {
  const suppressed = useSuppressed();
  if (suppressed) return null;
  return (
    <>
      <FloatingBall />
      <SelectionToolbar />
    </>
  );
}
