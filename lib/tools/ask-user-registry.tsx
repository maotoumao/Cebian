// Side-effect module: registers ask_user UI component with the UI tool registry.
// Import this file once in the sidepanel to enable rendering ask_user blocks.

import { uiToolRegistry, type InteractiveToolComponentProps } from './ui-registry';
import type { AskUserRequest, AskUserResponse } from './ask-user';
import { AskUserBlock } from '@/components/chat/Message';
import { TOOL_ASK_USER } from '@/lib/tools/names';

// ─── UI adapter for the registry's generic interface ───

function AskUserToolComponent({
  args,
  isPending,
  toolResult,
  onResolve,
}: InteractiveToolComponentProps<AskUserRequest>) {
  return (
    <AskUserBlock
      request={args}
      answered={!isPending && !!toolResult}
      onResolve={isPending && onResolve ? (response: AskUserResponse) => onResolve(response as any) : undefined}
    />
  );
}

// ─── Register with the UI tool registry ───

uiToolRegistry.register<AskUserRequest>({
  name: TOOL_ASK_USER,
  Component: AskUserToolComponent,
  renderResultAsUserBubble: true,
});
