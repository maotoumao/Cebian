// Side-effect module: registers present_form UI component with the UI tool registry.
// Import this file once in the sidepanel to enable rendering present_form blocks.

import { uiToolRegistry, type InteractiveToolComponentProps } from './ui-registry';
import type { PresentFormRequest, PresentFormResponse } from './present-form';
import { FormBlock } from '@/components/chat/FormBlock';
import { TOOL_PRESENT_FORM } from '@/lib/tools/names';

// ─── UI adapter for the registry's generic interface ───

function PresentFormToolComponent({
  args,
  isPending,
  toolResult,
  onResolve,
}: InteractiveToolComponentProps<PresentFormRequest>) {
  // 防御：流式生成期间 args 可能根本不是对象（空字符串 / null / 部分 JSON），
  // 此时由 FormBlock 内部的 fields 防御统一返回 null，这里再兜底一次。
  if (!args || typeof args !== 'object') return null;

  return (
    <FormBlock
      request={args}
      answered={!isPending && !!toolResult}
      onResolve={
        isPending && onResolve
          ? (response: PresentFormResponse) => onResolve(response)
          : undefined
      }
    />
  );
}

// ─── Register with the UI tool registry ───

uiToolRegistry.register<PresentFormRequest>({
  name: TOOL_PRESENT_FORM,
  Component: PresentFormToolComponent,
  renderResultAsUserBubble: true,
});
