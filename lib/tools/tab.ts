import { Type } from '@sinclair/typebox';
import type { AgentTool, AgentToolResult } from '@mariozechner/pi-agent-core';
import { TOOL_TAB } from '@/lib/types';
import { resolveTabId } from '@/lib/tab-helpers';

// ─── Parameters: single flat object (OpenAI requires top-level "type": "object") ───

const TabParameters = Type.Object({
  action: Type.Union([
    Type.Literal('open'), Type.Literal('close'), Type.Literal('switch'),
    Type.Literal('reload'), Type.Literal('list_frames'),
  ], { description: 'The tab action to perform.' }),
  url: Type.Optional(Type.String({
    description: 'URL to open. Required for "open" action (http/https only).',
  })),
  tabId: Type.Optional(Type.Number({
    description: 'Tab ID. Required for "close" and "switch". Optional for "reload" (omit to reload active tab). Get IDs from the context block.',
  })),
  windowId: Type.Optional(Type.Number({
    description: 'Window ID for the "open" action. Omit to use the current focused window. Get window IDs from the context block.',
  })),
});

// ─── Tool definition ───

export const tabTool: AgentTool<typeof TabParameters> = {
  name: TOOL_TAB,
  label: 'Manage Tab',
  description:
    'Manage browser tabs: open a new tab (http/https only, optionally in a specific window via windowId), ' +
    'close a tab, switch to a tab, reload, ' +
    'or list all frames (including iframes) in a tab (defaults to active tab). ' +
    'Use the tab list from the context block to find tab IDs and window IDs.',
  parameters: TabParameters,

  async execute(_toolCallId, params, signal): Promise<AgentToolResult<{ status: string }>> {
    signal?.throwIfAborted();

    try {
      switch (params.action) {
        case 'open': {
          if (!params.url) {
            return { content: [{ type: 'text', text: 'Error: "url" is required for open action.' }], details: { status: 'error' } };
          }
          const parsed = new URL(params.url);
          if (!['http:', 'https:'].includes(parsed.protocol)) {
            return {
              content: [{ type: 'text', text: `Error: only http/https URLs are allowed. Got: ${parsed.protocol}` }],
              details: { status: 'error' },
            };
          }
          const createProps: chrome.tabs.CreateProperties = { url: params.url };
          if (params.windowId != null) {
            try {
              await chrome.windows.get(params.windowId);
            } catch {
              return {
                content: [{ type: 'text', text: `Error: window ${params.windowId} does not exist.` }],
                details: { status: 'error' },
              };
            }
            createProps.windowId = params.windowId;
          }
          const tab = await chrome.tabs.create(createProps);
          return {
            content: [{ type: 'text', text: `Opened new tab (id: ${tab.id}) in window ${tab.windowId}: ${params.url}` }],
            details: { status: 'done' },
          };
        }

        case 'close': {
          if (!params.tabId) {
            return { content: [{ type: 'text', text: 'Error: "tabId" is required for close action.' }], details: { status: 'error' } };
          }
          await chrome.tabs.remove(params.tabId);
          return {
            content: [{ type: 'text', text: `Closed tab: ${params.tabId}` }],
            details: { status: 'done' },
          };
        }

        case 'switch': {
          if (!params.tabId) {
            return { content: [{ type: 'text', text: 'Error: "tabId" is required for switch action.' }], details: { status: 'error' } };
          }
          await chrome.tabs.update(params.tabId, { active: true });
          const tab = await chrome.tabs.get(params.tabId);
          return {
            content: [{ type: 'text', text: `Switched to tab: ${tab.title ?? tab.url}` }],
            details: { status: 'done' },
          };
        }

        case 'reload': {
          const tabId = params.tabId
            ?? (await chrome.tabs.query({ active: true, currentWindow: true }))[0]?.id;
          if (!tabId) {
            return {
              content: [{ type: 'text', text: 'Error: no tab to reload.' }],
              details: { status: 'error' },
            };
          }
          await chrome.tabs.reload(tabId);
          return {
            content: [{ type: 'text', text: `Reloaded tab: ${tabId}` }],
            details: { status: 'done' },
          };
        }

        case 'list_frames': {
          const tabId = await resolveTabId(params.tabId);
          const results = await (chrome.scripting.executeScript as any)({
            target: { tabId, allFrames: true },
            func: () => ({
              url: window.location.href,
              title: document.title,
              isTop: window === window.top,
            }),
          });
          const frames = (results as chrome.scripting.InjectionResult[]).map(r => ({
            frameId: r.frameId,
            ...r.result,
          }));
          return {
            content: [{ type: 'text', text: JSON.stringify(frames, null, 2) }],
            details: { status: 'done' },
          };
        }

        default:
          return {
            content: [{ type: 'text', text: `Unknown action: ${(params as any).action}` }],
            details: { status: 'error' },
          };
      }
    } catch (err) {
      return {
        content: [{ type: 'text', text: `Error: ${(err as Error).message}` }],
        details: { status: 'error' },
      };
    }
  },
};
