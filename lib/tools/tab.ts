import { Type } from '@sinclair/typebox';
import type { AgentTool, AgentToolResult } from '@mariozechner/pi-agent-core';
import { TOOL_TAB } from '@/lib/types';
import { getActiveTabId } from './chrome-api';

// ─── Discriminated union per action ───

const OpenParams = Type.Object({
  action: Type.Literal('open'),
  url: Type.String({ description: 'URL to open in a new tab.' }),
});

const CloseParams = Type.Object({
  action: Type.Literal('close'),
  tabId: Type.Number({ description: 'Tab ID to close. Get IDs from the context block.' }),
});

const SwitchParams = Type.Object({
  action: Type.Literal('switch'),
  tabId: Type.Number({ description: 'Tab ID to switch to. Get IDs from the context block.' }),
});

const ReloadParams = Type.Object({
  action: Type.Literal('reload'),
  tabId: Type.Optional(Type.Number({ description: 'Tab ID to reload. Omit to reload the active tab.' })),
});

const ListFramesParams = Type.Object({
  action: Type.Literal('list_frames'),
});

const TabParameters = Type.Union([
  OpenParams, CloseParams, SwitchParams, ReloadParams, ListFramesParams,
]);

// ─── Tool definition ───

export const tabTool: AgentTool<typeof TabParameters> = {
  name: TOOL_TAB,
  label: 'Manage Tab',
  description:
    'Manage browser tabs: open a new tab, close a tab, switch to a tab, reload, ' +
    'or list all frames (including iframes) in the active tab. ' +
    'Use the tab list from the context block to find tab IDs.',
  parameters: TabParameters,

  async execute(_toolCallId, params, signal): Promise<AgentToolResult<{ status: string }>> {
    signal?.throwIfAborted();

    switch (params.action) {
      case 'open': {
        const tab = await chrome.tabs.create({ url: params.url });
        return {
          content: [{ type: 'text', text: `Opened new tab (id: ${tab.id}): ${params.url}` }],
          details: { status: 'done' },
        };
      }

      case 'close': {
        await chrome.tabs.remove(params.tabId);
        return {
          content: [{ type: 'text', text: `Closed tab: ${params.tabId}` }],
          details: { status: 'done' },
        };
      }

      case 'switch': {
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
        const tabId = await getActiveTabId();
        try {
          const results = await chrome.scripting.executeScript({
            target: { tabId, allFrames: true },
            func: () => ({
              url: window.location.href,
              title: document.title,
              isTop: window === window.top,
            }),
          } as any);
          const frames = results.map((r: any) => ({
            frameId: r.frameId,
            ...r.result,
          }));
          return {
            content: [{ type: 'text', text: JSON.stringify(frames, null, 2) }],
            details: { status: 'done' },
          };
        } catch {
          return {
            content: [{ type: 'text', text: 'Error: cannot list frames (page may be restricted).' }],
            details: { status: 'error' },
          };
        }
      }

      default:
        return {
          content: [{ type: 'text', text: `Unknown action: ${(params as any).action}` }],
          details: { status: 'error' },
        };
    }
  },
};
