import { useId } from 'react';
import { Trash2 } from 'lucide-react';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Button } from '@/components/ui/button';
import { Switch } from '@/components/ui/switch';
import { AccordionItem, AccordionContent, AccordionTrigger } from '@/components/ui/accordion';
import type { CustomModelDef } from '@/lib/persistence/storage';
import { DEFAULT_CONTEXT_WINDOW, DEFAULT_MAX_TOKENS } from '@/lib/providers/custom-models';
import { formatCompactCount } from '@/lib/utils';
import { t } from '@/lib/i18n';

/** 把用户输入清成正整数 token；空/0/非法 → undefined（走默认），并夹到安全整数上界 */
function parseTokenInput(raw: string): number | undefined {
  const digits = raw.replace(/\D/g, '');
  if (digits === '') return undefined;
  const n = Number.parseInt(digits, 10);
  if (!Number.isFinite(n) || n <= 0) return undefined;
  return Math.min(n, Number.MAX_SAFE_INTEGER);
}

interface ModelListItemProps {
  model: CustomModelDef;
  onToggleReasoning: (modelId: string) => void;
  onToggleImage: (modelId: string) => void;
  onRemove: (modelId: string) => void;
  onFieldChange: (modelId: string, patch: Partial<Pick<CustomModelDef, 'contextWindow' | 'maxTokens'>>) => void;
}

/**
 * 自定义 provider 里的单个模型行：摘要行（modelId + 非默认 chip + 推理/多模态开关 +
 * 删除 + 展开箭头）+ 展开后的 context/maxTokens 配置。父级用 <Accordion> 包裹一组
 */
export function ModelListItem({ model, onToggleReasoning, onToggleImage, onRemove, onFieldChange }: ModelListItemProps) {
  const reasoningId = useId();
  const imageId = useId();
  const ctxId = useId();
  const maxId = useId();

  const ctxChip = model.contextWindow != null && model.contextWindow !== DEFAULT_CONTEXT_WINDOW
    ? formatCompactCount(model.contextWindow)
    : null;
  const maxChip = model.maxTokens != null && model.maxTokens !== DEFAULT_MAX_TOKENS
    ? `≤${formatCompactCount(model.maxTokens)}`
    : null;

  return (
    <AccordionItem value={model.modelId} className="border-0">
      <div className="flex items-center gap-2 text-xs py-1.5">
        <span className="flex-1 min-w-0 font-mono truncate">{model.modelId}</span>
        {(ctxChip || maxChip) && (
          <span className="shrink-0 text-[0.6rem] text-muted-foreground tabular-nums whitespace-nowrap">
            {[ctxChip, maxChip].filter(Boolean).join(' · ')}
          </span>
        )}
        <div className="flex items-center gap-1 shrink-0">
          <Label htmlFor={reasoningId} className="text-[0.6rem] text-muted-foreground">{t('provider.form.reasoning')}</Label>
          <Switch
            id={reasoningId}
            checked={model.reasoning}
            onCheckedChange={() => onToggleReasoning(model.modelId)}
            className="scale-75"
          />
        </div>
        <div className="flex items-center gap-1 shrink-0">
          <Label htmlFor={imageId} className="text-[0.6rem] text-muted-foreground">{t('provider.form.image')}</Label>
          <Switch
            id={imageId}
            checked={model.image ?? false}
            onCheckedChange={() => onToggleImage(model.modelId)}
            className="scale-75"
          />
        </div>
        <Button
          variant="ghost"
          size="icon-xs"
          className="shrink-0 text-destructive hover:text-destructive"
          onClick={() => onRemove(model.modelId)}
          aria-label={t('provider.form.removeModel', [model.modelId])}
        >
          <Trash2 className="size-3" />
        </Button>
        <AccordionTrigger
          aria-label={t('provider.form.modelSettingsFor', [model.modelId])}
          className="py-0 px-1 flex-none gap-0 hover:no-underline [&>svg]:size-3.5"
        />
      </div>
      <AccordionContent className="pb-2">
        <div className="rounded-md bg-muted/30 p-2 space-y-1.5">
          <div className="grid grid-cols-2 gap-2">
            <div className="space-y-1">
              <Label htmlFor={ctxId} className="text-[0.65rem] text-muted-foreground">{t('provider.form.contextWindow')}</Label>
              <Input
                id={ctxId}
                inputMode="numeric"
                value={model.contextWindow ?? ''}
                onChange={e => onFieldChange(model.modelId, { contextWindow: parseTokenInput(e.target.value) })}
                placeholder={t('provider.form.contextWindowPlaceholder')}
                className="h-7 text-xs tabular-nums bg-background"
              />
            </div>
            <div className="space-y-1">
              <Label htmlFor={maxId} className="text-[0.65rem] text-muted-foreground">{t('provider.form.maxTokens')}</Label>
              <Input
                id={maxId}
                inputMode="numeric"
                value={model.maxTokens ?? ''}
                onChange={e => onFieldChange(model.modelId, { maxTokens: parseTokenInput(e.target.value) })}
                placeholder={t('provider.form.maxTokensPlaceholder')}
                className="h-7 text-xs tabular-nums bg-background"
              />
            </div>
          </div>
          <p className="text-[0.6rem] text-muted-foreground">{t('provider.form.tokensHint')}</p>
        </div>
      </AccordionContent>
    </AccordionItem>
  );
}
