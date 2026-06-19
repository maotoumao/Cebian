import { SquarePen, Settings, FileText, Languages, ListChecks, LayoutGrid, type LucideIcon } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { t } from '@/lib/i18n';

// 一张示例卡片：标题用于显示，prompt 是点击后填入输入框的完整文案。
interface Example {
  icon: LucideIcon;
  title: string;
  prompt: string;
}

interface WelcomeScreenProps {
  /** 是否已配置可用模型。未配置时只展示引导去设置的 CTA。 */
  hasModel: boolean;
  /** 点击示例卡片时回调，参数为要填入输入框的完整 prompt。 */
  onPickExample: (prompt: string) => void;
  /** 点击「前往设置」时回调。 */
  onOpenSettings: () => void;
}

/**
 * 新会话空状态：已配置模型时展示问候语 + 4 张示例卡片（点击填入输入框）；
 * 未配置模型时展示一句说明 + 「前往设置」CTA。
 *
 * 布局：在外层 ScrollArea 中用 `m-auto` 垂直居中——内容矮时居中、内容高时
 * 可正常滚动且不裁切顶部（避免 flex `justify-center` 的溢出裁切问题）。
 */
export function WelcomeScreen({ hasModel, onPickExample, onOpenSettings }: WelcomeScreenProps) {
  const examples: Example[] = [
    { icon: FileText, title: t('chat.session.exampleSummarizeTitle'), prompt: t('chat.session.exampleSummarizePrompt') },
    { icon: Languages, title: t('chat.session.exampleTranslateTitle'), prompt: t('chat.session.exampleTranslatePrompt') },
    { icon: ListChecks, title: t('chat.session.exampleExtractTitle'), prompt: t('chat.session.exampleExtractPrompt') },
    { icon: LayoutGrid, title: t('chat.session.exampleTabsTitle'), prompt: t('chat.session.exampleTabsPrompt') },
  ];

  return (
    <div className="m-auto flex w-full max-w-105 flex-col items-center gap-3 px-2 pt-24 pb-12 text-center">
      <div className="grid size-10 place-items-center rounded-xl bg-primary/10">
        <SquarePen className="size-5 text-primary" />
      </div>

      {!hasModel ? (
        <div className="flex flex-col items-center gap-3">
          <p className="text-sm text-muted-foreground">{t('chat.composer.needModel')}</p>
          <Button variant="outline" size="sm" onClick={onOpenSettings}>
            <Settings className="size-3.5" />
            {t('chat.composer.goToSettings')}
          </Button>
        </div>
      ) : (
        <>
          <p className="text-base font-medium text-foreground">{t('chat.session.welcomeReady')}</p>

          <div className="mt-2 grid w-full grid-cols-1 gap-2.5 min-[340px]:grid-cols-2">
            {examples.map(({ icon: Icon, title, prompt }) => (
              <button
                key={title}
                type="button"
                onClick={() => onPickExample(prompt)}
                className="group flex items-center gap-2.5 rounded-lg border border-border bg-muted/40 px-3 py-2.5 text-left transition-colors hover:border-primary/30 hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
              >
                <Icon className="size-4 shrink-0 text-muted-foreground transition-colors group-hover:text-primary" />
                <span className="min-w-0 truncate text-[0.8rem] font-medium text-foreground">{title}</span>
              </button>
            ))}
          </div>
        </>
      )}
    </div>
  );
}
