import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { toast } from 'sonner';
import { Label } from '@/components/ui/label';
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group';
import { Slider } from '@/components/ui/slider';
import { AgentMessage, AgentTextBlock, UserMessageBubble } from '@/components/chat/Message';
import { LocalFontPicker } from '@/components/settings/appearance/LocalFontPicker';
import { useStorageItem } from '@/hooks/useStorageItem';
import {
  CHAT_FONT_SCALE_STEP,
  MAX_CHAT_FONT_SCALE_PERCENT,
  MIN_CHAT_FONT_SCALE_PERCENT,
  chatAppearance,
  resolveChatAppearance,
  themePreference,
  type ChatAppearance,
  type ChatFontPreset,
  type ThemePreference,
} from '@/lib/persistence/storage';
import { chatAppearanceStyle } from '@/lib/ui/chat-appearance';
import { isLocalFontAccessSupported } from '@/lib/ui/local-fonts';
import { t } from '@/lib/i18n';

const THEME_OPTIONS: { value: ThemePreference; getLabel: () => string }[] = [
  { value: 'system', getLabel: () => t('settings.appearance.theme.system') },
  { value: 'light', getLabel: () => t('settings.appearance.theme.light') },
  { value: 'dark', getLabel: () => t('settings.appearance.theme.dark') },
];

const FONT_OPTIONS: { value: ChatFontPreset; getLabel: () => string }[] = [
  { value: 'default', getLabel: () => t('settings.appearance.font.default') },
  { value: 'serif', getLabel: () => t('settings.appearance.font.serif') },
  { value: 'mono', getLabel: () => t('settings.appearance.font.mono') },
  { value: 'custom', getLabel: () => t('settings.appearance.font.custom') },
];

/** 预览里的代码块：代码本身不翻译，只用来展示代码字号跟着缩放。 */
const PREVIEW_CODE = "```ts\nconst greeting = 'Hello, Cebian';\n```";

// ─── 外观写入队列（模块级） ───
//
// 同一页面内所有外观设置实例共用一条写入队列：离开外观页再回来会换一个组件实例，旧实例还没
// 发出的写入必须仍排在新实例的写入之前，否则会晚落盘、把用户后来的修改覆盖掉。
let writeQueue: Promise<void> = Promise.resolve();
let writesInFlight = 0;
/** 写入世代：每发起一笔写入 +1。重读期间若发起过写入（哪怕已落定），重读结果作废。 */
let writeGen = 0;
/** 队列清空时通知所有存活实例重读存储。 */
const drainListeners = new Set<() => void>();

function enqueueAppearanceWrite(next: ChatAppearance): void {
  writesInFlight++;
  writeGen++;
  writeQueue = writeQueue
    .then(() => chatAppearance.setValue(next))
    .catch((err) => {
      console.warn('[appearance] update settings failed:', err);
      toast.error(t('errors.appearanceSaveFailed'));
    })
    .finally(() => {
      writesInFlight--;
      if (writesInFlight === 0) drainListeners.forEach((listener) => listener());
    });
}

/**
 * 可编辑的对话区外观：乐观的本地值 + 串行写入。
 *
 * 存储按整对象覆盖，而回推是异步的：若每次修改都基于「最近一次回推的值」合并，连续操作
 * （选完字体立刻点预设 / 松开滑杆）会拿旧值把前一次改的字段写回去；回推还会冲掉进行中的拖动。
 * 所以这里让界面只认本地值：
 * - 修改立即作用于本地值，并排进写入队列（按发出顺序落盘，最后一笔就是本地最新值）。
 * - 回推只当「存储变了」的信号，不直接采用它携带的值：浏览器不保证 onChanged 先于 set() 的
 *   Promise 兑现，自己写入的回声可能在队列清空后才迟到，直接采用会把本地值退回旧值。
 *   所以回推到达时若没有写入在途，就重读一次存储，以存储为准；有写入在途则忽略。
 * - 队列清空后也重读一次：吸收期间被忽略的外部改动，也回滚写失败的修改。
 * - 重读结果只在期间没有更新的回推、也没有发起过写入（两个世代号都不变）时采用——否则
 *   更晚的那次重读 / 本地写入才是更新的值（写入落定后队列清空还会再触发一次重读）。
 *
 * 不复用 useChatAppearance：这里需要在回推到达时同步判断在途写入，且初读失败时要保持 null
 * （控件一直禁用），不能像对话区那样按默认值放行——那样第一次修改会拿默认值整对象覆盖已存配置。
 */
function useEditableChatAppearance(): [ChatAppearance | null, (patch: Partial<ChatAppearance>) => void] {
  const [local, setLocal] = useState<ChatAppearance | null>(null);
  const localRef = useRef<ChatAppearance | null>(null);

  const show = useCallback((value: ChatAppearance) => {
    localRef.current = value;
    setLocal(value);
  }, []);

  useEffect(() => {
    let active = true;
    // 回推世代：每次回推 +1，让更早发起的重读作废
    let watchGen = 0;
    const reload = () => {
      const gen = watchGen;
      const startWriteGen = writeGen;
      chatAppearance
        .getValue()
        .then((value) => {
          if (active && writesInFlight === 0 && watchGen === gen && writeGen === startWriteGen) {
            show(resolveChatAppearance(value));
          }
        })
        .catch((err) => {
          console.warn('[appearance] load settings failed:', err);
        });
    };
    const unwatch = chatAppearance.watch(() => {
      watchGen++;
      if (active && writesInFlight === 0) reload();
    });
    drainListeners.add(reload);
    // 挂载时若旧实例的写入还在途，等队列清空的通知再读
    if (writesInFlight === 0) reload();
    return () => {
      active = false;
      unwatch();
      drainListeners.delete(reload);
    };
  }, [show]);

  const update = useCallback(
    (patch: Partial<ChatAppearance>) => {
      const base = localRef.current;
      if (!base) return;
      const next = resolveChatAppearance({ ...base, ...patch });
      show(next);
      enqueueAppearanceWrite(next);
    },
    [show],
  );

  return [local, update];
}

/** 横排单选组：一行几个短选项（主题 / 字体预设）。 */
function InlineRadioGroup<T extends string>({
  value,
  options,
  onChange,
  labelId,
  disabled,
}: {
  value: T;
  options: { value: T; getLabel: () => string }[];
  onChange: (value: T) => void;
  labelId: string;
  disabled?: boolean;
}) {
  const idPrefix = useId();
  return (
    <RadioGroup
      value={value}
      onValueChange={(v) => onChange(v as T)}
      aria-labelledby={labelId}
      disabled={disabled}
      className="flex flex-wrap gap-x-5 gap-y-2"
    >
      {options.map((o) => (
        <div key={o.value} className="flex items-center gap-2">
          <RadioGroupItem value={o.value} id={`${idPrefix}-${o.value}`} />
          <Label htmlFor={`${idPrefix}-${o.value}`} className="text-sm font-normal">
            {o.getLabel()}
          </Label>
        </div>
      ))}
    </RadioGroup>
  );
}

/**
 * 字号行：滑杆 + 百分比读数。拖动期间显示本地草稿、松手才提交；`percent` 变化（自己的提交已
 * 同步进本地值，或外部改动）时撤掉草稿。自己写入的回推只触发重读、读回的是本地已有的值，
 * `percent` 不变（见 useEditableChatAppearance），所以不会打断紧接着的下一次拖动。草稿经 onDraftChange 上报，
 * 让预览跟着拖动实时变化。
 */
function FontScaleRow({
  percent,
  disabled,
  onDraftChange,
  onCommit,
}: {
  percent: number;
  disabled: boolean;
  onDraftChange: (percent: number | null) => void;
  onCommit: (percent: number) => void;
}) {
  const [draft, setDraft] = useState<number | null>(null);
  const value = draft ?? percent;
  useEffect(() => {
    setDraft(null);
    onDraftChange(null);
  }, [percent, onDraftChange]);
  // Radix 的 role="slider" 在 Thumb 上，Label 的 htmlFor 指不到它；用 aria-labelledby 关联
  const labelId = useId();
  const valueText = t('settings.appearance.fontScale.value', [String(value)]);

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between gap-4">
        <Label id={labelId} className="text-sm">{t('settings.appearance.fontScale.label')}</Label>
        <span className="shrink-0 text-xs tabular-nums" aria-hidden="true">{valueText}</span>
      </div>
      <Slider
        value={[value]}
        min={MIN_CHAT_FONT_SCALE_PERCENT}
        max={MAX_CHAT_FONT_SCALE_PERCENT}
        step={CHAT_FONT_SCALE_STEP}
        disabled={disabled}
        aria-labelledby={labelId}
        aria-valuetext={valueText}
        onValueChange={([next]) => {
          setDraft(next);
          onDraftChange(next);
        }}
        onValueCommit={([next]) => onCommit(next)}
      />
      <p className="text-xs text-muted-foreground">{t('settings.appearance.fontScale.hint')}</p>
    </div>
  );
}

/**
 * 「外观」设置：主题 + 对话区字号 / 字体 + 实时预览。
 *
 * 对话区外观走 useEditableChatAppearance（乐观本地值 + 串行写入），读出前禁用控件。
 * 「自定义」字体只能从本机已安装的字体里选（Local Font Access API），浏览器不支持时不提供该选项。
 */
export function AppearanceSection() {
  // undefined = 还没读出来：先按 fallback 勾选再跳变会闪一下，读出前禁用
  const [theme] = useStorageItem(themePreference, undefined);
  const [appearance, updateAppearance] = useEditableChatAppearance();
  const loaded = appearance !== null;
  const current = appearance ?? resolveChatAppearance(null);

  const [scaleDraft, setScaleDraft] = useState<number | null>(null);

  const themeLabelId = useId();
  const fontLabelId = useId();
  const fontHintId = useId();

  // 不支持读取本机字体时隐藏「自定义」；但当前已是自定义（如从别的浏览器恢复的备份）时仍列出它，
  // 让单选组如实显示当前状态——对话区照常按保存的字体名渲染。此时选择器禁用，
  // 「从本机字体中选择」的提示也会误导，一并不显示
  const localFontsSupported = isLocalFontAccessSupported();
  const fontOptions =
    localFontsSupported || current.fontPreset === 'custom'
      ? FONT_OPTIONS
      : FONT_OPTIONS.filter((o) => o.value !== 'custom');

  const writeTheme = (next: ThemePreference) => {
    void themePreference.setValue(next).catch((err) => {
      console.warn('[appearance] update theme failed:', err);
      toast.error(t('errors.appearanceSaveFailed'));
    });
  };

  // 预览自带一份局部样式：独立设置标签页没有侧边栏根节点上的变量，且要反映拖动中的字号草稿
  const preview = resolveChatAppearance({
    ...current,
    fontScalePercent: scaleDraft ?? current.fontScalePercent,
  });

  return (
    <div className="flex-1 overflow-y-auto p-6 space-y-6">
      <h2 className="text-base font-semibold">{t('settings.appearance.title')}</h2>

      <div className="space-y-2">
        <Label id={themeLabelId} className="text-sm">{t('settings.appearance.theme.label')}</Label>
        <InlineRadioGroup
          value={theme ?? 'system'}
          options={THEME_OPTIONS}
          onChange={writeTheme}
          labelId={themeLabelId}
          disabled={theme === undefined}
        />
      </div>

      <FontScaleRow
        percent={current.fontScalePercent}
        disabled={!loaded}
        onDraftChange={setScaleDraft}
        onCommit={(fontScalePercent) => updateAppearance({ fontScalePercent })}
      />

      <div className="space-y-2">
        <Label id={fontLabelId} className="text-sm">{t('settings.appearance.font.label')}</Label>
        <InlineRadioGroup
          value={current.fontPreset}
          options={fontOptions}
          onChange={(fontPreset) => updateAppearance({ fontPreset })}
          labelId={fontLabelId}
          disabled={!loaded}
        />
        {loaded && current.fontPreset === 'custom' && (
          <div className="space-y-1.5 pt-1">
            <LocalFontPicker
              value={current.customFontName}
              onChange={(customFontName) => updateAppearance({ customFontName })}
              labelledBy={fontLabelId}
              describedBy={localFontsSupported ? fontHintId : undefined}
            />
            {localFontsSupported && (
              <p id={fontHintId} className="text-xs text-muted-foreground">
                {t('settings.appearance.font.customHint')}
              </p>
            )}
          </div>
        )}
      </div>

      <div className="space-y-2">
        <p className="text-sm font-medium">{t('settings.appearance.preview.label')}</p>
        <div
          style={chatAppearanceStyle(preview)}
          // 纯展示样例：屏蔽代码块复制按钮等可聚焦元素，免得 Tab 键陷进预览
          inert
          className="flex flex-col gap-4 rounded-lg border border-border bg-background p-4"
        >
          <UserMessageBubble>{t('settings.appearance.preview.question')}</UserMessageBubble>
          <AgentMessage>
            <AgentTextBlock content={`${t('settings.appearance.preview.answer')}\n\n${PREVIEW_CODE}`} />
          </AgentMessage>
        </div>
      </div>
    </div>
  );
}
