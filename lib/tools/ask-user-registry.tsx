// Side-effect module: registers ask_user as an interactive tool.
// Import this file once at app startup to activate registration.

import { interactiveToolRegistry, type InteractiveToolComponentProps } from './registry';
import { askUserBridge, type AskUserRequest } from './ask-user';
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

// ─── Register with the interactive tool registry ───

interactiveToolRegistry.register<AskUserRequest, string>({
  name: TOOL_ASK_USER,
  bridge: askUserBridge,
  Component: AskUserToolComponent,
  renderResultAsUserBubble: true,
});
