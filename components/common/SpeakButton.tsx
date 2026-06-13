import { useEffect, useRef, useState } from 'react';
import { Volume2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { t } from '@/lib/i18n';

/**
 * Web Speech API 特性检测。speechSynthesis 是普通扩展页面（如 sidepanel）即可
 * 使用的标准 API，但部分环境（无 TTS 引擎的 Linux 等）可能缺失；不支持时
 * 按钮仍渲染但置为 disabled，让用户能看到该能力存在、只是当前环境不可用。
 */
const ttsSupported =
  typeof window !== 'undefined' &&
  'speechSynthesis' in window &&
  typeof window.SpeechSynthesisUtterance !== 'undefined';

/**
 * 启发式选择朗读语言：文本含 CJK 字符 → zh-CN，否则 en-US。speechSynthesis 一条
 * utterance 只能绑定一个 lang，无法在中英混排时自动切换音色；这里取「有中文就按
 * 中文念」的策略，覆盖绝大多数对话场景，引擎对夹杂的英文单词通常也能正常发音。
 */
function pickLang(text: string): string {
  return /[\u4e00-\u9fff]/.test(text) ? 'zh-CN' : 'en-US';
}

/**
 * 全局当前正在播放的 utterance。speechSynthesis 是单一全局队列，而 `cancel()`
 * 会清掉整个队列；记下当前拥有者，才能在某个按钮卸载时判断「正在念的是不
 * 是我这条」，避免误停另一条消息的朗读。
 */
let activeUtterance: SpeechSynthesisUtterance | null = null;

/**
 * 朗读按钮：点击后用系统默认音色朗读 `getText()` 返回的纯文本，再次点击或朗读
 * 结束后复位。`getText` 惰性求值，调用方负责把消息 DOM 转成「所见即所读」的纯
 * 文本（见 Message.tsx 的 extractSpeakText）。
 *
 * speechSynthesis 是全局单队列：播放前先 `cancel()` 清掉其它消息正在念的内容，
 * 从而实现多个按钮之间的天然互斥——被打断的那条 utterance 会触发 `onend`，自动
 * 复位它自己的 speaking 态。
 *
 * 系统不支持时按钮置为 disabled。
 */
export function SpeakButton({ getText }: { getText: () => string }) {
  const [speaking, setSpeaking] = useState(false);
  // 持有当前这条按钮发起的 utterance，便于在停止/卸载时判断回调是否仍属于自己。
  const utteranceRef = useRef<SpeechSynthesisUtterance | null>(null);

  // 卸载时停止朗读，避免组件销毁后语音仍在继续（符合「关闭面板即停」的直觉）。
  // 仅当本组件仍是全局拥有者时才 cancel，否则会误停接管了队列的另一条消息。
  useEffect(() => () => {
    const own = utteranceRef.current;
    if (own && activeUtterance === own) {
      activeUtterance = null;
      utteranceRef.current = null;
      window.speechSynthesis.cancel();
    }
  }, []);

  function stop() {
    const own = utteranceRef.current;
    utteranceRef.current = null;
    setSpeaking(false);
    // 仅当本组件仍是全局拥有者时才动全局队列，避免在「A 被 B 打断、A 的 speaking
    // 尚未复位」的窗口里点 A 误停了已接管的 B。
    if (own && activeUtterance === own) {
      activeUtterance = null;
      window.speechSynthesis.cancel();
    }
  }

  function onClick() {
    if (speaking) {
      stop();
      return;
    }

    const text = getText().trim();
    if (!text) return;

    // 先清空全局队列：打断其它消息正在进行的朗读，保证同一时刻只有一条在念。
    window.speechSynthesis.cancel();

    const utterance = new SpeechSynthesisUtterance(text);
    utterance.lang = pickLang(text);
    const reset = () => {
      // 仅当结束的正是本按钮发起的 utterance 时才复位，避免被后发起者打断后误改状态。
      if (utteranceRef.current === utterance) {
        utteranceRef.current = null;
        setSpeaking(false);
      }
      if (activeUtterance === utterance) activeUtterance = null;
    };
    utterance.onend = reset;
    utterance.onerror = reset;

    utteranceRef.current = utterance;
    activeUtterance = utterance;
    setSpeaking(true);
    window.speechSynthesis.speak(utterance);
  }

  const label = speaking ? t('common.stopSpeaking') : t('common.speak');

  // 朗读中以脉动 + primary 色表达「正在进行」（与 RecordButton 同一路数），
  // 而不是换成易误读为「静音」的 VolumeX 图标；停止语义由 tooltip 承担。
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          variant="ghost"
          size="icon"
          className={`size-7 hover:text-foreground ${
            speaking ? 'text-primary' : 'text-muted-foreground'
          }`}
          onClick={onClick}
          disabled={!ttsSupported}
          aria-label={label}
          aria-pressed={speaking}
        >
          <Volume2 className={`size-3.5 ${speaking ? 'animate-pulse' : ''}`} />
        </Button>
      </TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  );
}
