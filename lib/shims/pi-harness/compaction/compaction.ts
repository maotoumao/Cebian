/**
 * 移植自 @earendil-works/pi-agent-core@0.84.4 `src/harness/compaction/compaction.ts`（MIT，许可证见同目录 LICENSE）。
 * vendor 原因、维护约定与偏离记录见 lib/shims/pi-harness/README.md。
 */
import {
  type Api,
  type AssistantMessage,
  type Context,
  contentText,
  type Model,
  type Models,
  type RetryCallbacks,
  type RetryPolicy,
  retryAssistantCall,
  type SimpleStreamOptions,
  type Usage,
  uuidv7,
} from '@earendil-works/pi-ai';
import type { AgentMessage, ThinkingLevel } from '@earendil-works/pi-agent-core';
import { convertToLlm } from '@/lib/shims/pi-harness/messages';
import { CompactionError, err, ok, type Result } from '@/lib/shims/pi-harness/types';
import { serializeConversation } from '@/lib/shims/pi-harness/compaction/utils';

export async function completeSimpleWithRetries(
  models: Models,
  model: Model<Api>,
  context: Context,
  options: SimpleStreamOptions,
  retry?: RetryPolicy,
  callbacks?: RetryCallbacks,
): Promise<AssistantMessage> {
  // Summaries are standalone requests, so isolate routing and avoid cache writes that cannot be reused.
  const requestOptions: SimpleStreamOptions = {
    ...options,
    cacheRetention: 'none',
    sessionId: uuidv7(),
  };
  return retryAssistantCall(
    () => models.completeSimple(model, context, requestOptions),
    retry,
    requestOptions.signal,
    callbacks,
  );
}

/** Compaction thresholds and retention settings. */
export interface CompactionSettings {
  /** Enable automatic compaction decisions. */
  enabled: boolean;
  /** Tokens reserved for summary prompt and output. */
  reserveTokens: number;
  /** Approximate recent-context tokens to keep after compaction. */
  keepRecentTokens: number;
}

/** Default compaction settings used by the harness. */
export const DEFAULT_COMPACTION_SETTINGS: CompactionSettings = {
  enabled: true,
  reserveTokens: 16384,
  keepRecentTokens: 20000,
};

export const SUMMARIZATION_SYSTEM_PROMPT = `You are a context summarization assistant. Your task is to read a conversation between a user and an AI assistant, then produce a structured summary following the exact format specified.

Do NOT continue the conversation. Do NOT respond to any questions in the conversation. ONLY output the structured summary.`;

const SUMMARIZATION_PROMPT = `The messages above are a conversation to summarize. Create a structured context checkpoint summary that another LLM will use to continue the work.

Use this EXACT format:

## Goal
[What is the user trying to accomplish? Can be multiple items if the session covers different tasks.]

## Constraints & Preferences
- [Any constraints, preferences, or requirements mentioned by user]
- [Or "(none)" if none were mentioned]

## Progress
### Done
- [x] [Completed tasks/changes]

### In Progress
- [ ] [Current work]

### Blocked
- [Issues preventing progress, if any]

## Key Decisions
- **[Decision]**: [Brief rationale]

## Next Steps
1. [Ordered list of what should happen next]

## Critical Context
- [Any data, examples, or references needed to continue]
- [Or "(none)" if not applicable]

Keep each section concise. Preserve exact file paths, function names, and error messages.`;

const UPDATE_SUMMARIZATION_PROMPT = `The messages above are NEW conversation messages to incorporate into the existing summary provided in <previous-summary> tags.

Update the existing structured summary with new information. RULES:
- PRESERVE all existing information from the previous summary
- ADD new progress, decisions, and context from the new messages
- UPDATE the Progress section: move items from "In Progress" to "Done" when completed
- UPDATE "Next Steps" based on what was accomplished
- PRESERVE exact file paths, function names, and error messages
- If something is no longer relevant, you may remove it

Use this EXACT format:

## Goal
[Preserve existing goals, add new ones if the task expanded]

## Constraints & Preferences
- [Preserve existing, add new ones discovered]

## Progress
### Done
- [x] [Include previously done items AND newly completed items]

### In Progress
- [ ] [Current work - update based on progress]

### Blocked
- [Current blockers - remove if resolved]

## Key Decisions
- **[Decision]**: [Brief rationale] (preserve all previous, add new)

## Next Steps
1. [Update based on current state]

## Critical Context
- [Preserve important context, add new if needed]

Keep each section concise. Preserve exact file paths, function names, and error messages.`;

/** Generate or update a conversation summary for compaction. */
export async function generateSummary(
  currentMessages: AgentMessage[],
  models: Models,
  model: Model<Api>,
  reserveTokens: number,
  signal?: AbortSignal,
  customInstructions?: string,
  previousSummary?: string,
  thinkingLevel?: ThinkingLevel,
  retry?: RetryPolicy,
  callbacks?: RetryCallbacks,
): Promise<Result<string, CompactionError>> {
  const result = await generateSummaryWithUsage(
    currentMessages,
    models,
    model,
    reserveTokens,
    signal,
    customInstructions,
    previousSummary,
    thinkingLevel,
    retry,
    callbacks,
  );
  return result.ok ? ok(result.value.text) : err(result.error);
}

/** Generate or update a conversation summary and return its provider usage. */
export async function generateSummaryWithUsage(
  currentMessages: AgentMessage[],
  models: Models,
  model: Model<Api>,
  reserveTokens: number,
  signal?: AbortSignal,
  customInstructions?: string,
  previousSummary?: string,
  thinkingLevel?: ThinkingLevel,
  retry?: RetryPolicy,
  callbacks?: RetryCallbacks,
): Promise<Result<{ text: string; usage: Usage }, CompactionError>> {
  const maxTokens = Math.min(
    Math.floor(0.8 * reserveTokens),
    model.maxTokens > 0 ? model.maxTokens : Number.POSITIVE_INFINITY,
  );
  let basePrompt = previousSummary ? UPDATE_SUMMARIZATION_PROMPT : SUMMARIZATION_PROMPT;
  if (customInstructions) {
    basePrompt = `${basePrompt}\n\nAdditional focus: ${customInstructions}`;
  }
  const llmMessages = convertToLlm(currentMessages);
  const conversationText = serializeConversation(llmMessages);
  let promptText = `<conversation>\n${conversationText}\n</conversation>\n\n`;
  if (previousSummary) {
    promptText += `<previous-summary>\n${previousSummary}\n</previous-summary>\n\n`;
  }
  promptText += basePrompt;

  const summarizationMessages = [
    {
      role: 'user' as const,
      content: [{ type: 'text' as const, text: promptText }],
      timestamp: Date.now(),
    },
  ];

  const completionOptions =
    model.reasoning && thinkingLevel && thinkingLevel !== 'off'
      ? { maxTokens, signal, reasoning: thinkingLevel }
      : { maxTokens, signal };

  const response = await completeSimpleWithRetries(
    models,
    model,
    { systemPrompt: SUMMARIZATION_SYSTEM_PROMPT, messages: summarizationMessages },
    completionOptions,
    retry,
    callbacks,
  );
  if (response.stopReason === 'aborted') {
    return err(new CompactionError('aborted', response.errorMessage || 'Summarization aborted'));
  }
  if (response.stopReason === 'error') {
    return err(
      new CompactionError(
        'summarization_failed',
        `Summarization failed: ${response.errorMessage || 'Unknown error'}`,
      ),
    );
  }

  const textContent = contentText(response.content);

  return ok({ text: textContent, usage: response.usage });
}

