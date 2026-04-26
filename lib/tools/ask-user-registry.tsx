// Side-effect module: registers ask_user UI component with the UI tool registry.
// Import this file once in the sidepanel to enable rendering ask_user blocks.

import { uiToolRegistry, type InteractiveToolComponentProps } from './ui-registry';
import type { AskUserRequest } from './ask-user';
import { AskUserBlock } from '@/components/chat/Message';
import { TOOL_ASK_USER } from '@/lib/types';

// ─── UI adapter for the registry's generic interface ───

function AskUserToolComponent({
  args,
  isPending,
  toolResult,
  onResolve,
}: InteractiveToolComponentProps<AskUserRequest>) {
  return (
    <AskUserBlock
      question={args.question}
      options={args.options}
      allowFreeText={args.allow_free_text ?? true}
      answered={!isPending && !!toolResult}
      onSelect={isPending ? onResolve : undefined}
    />
  );
}

// ─── Register with the UI tool registry ───

uiToolRegistry.register<AskUserRequest>({
  name: TOOL_ASK_USER,
  Component: AskUserToolComponent,
  renderResultAsUserBubble: true,
});
