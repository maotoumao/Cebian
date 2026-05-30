import { Type } from 'typebox';
import type { AgentTool, AgentToolResult } from '@earendil-works/pi-agent-core';
import { TOOL_TAB } from '@/lib/types';

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
    description: 'Tab ID. Required for "close", "switch", "reload", and "list_frames". Ignored for "open". Read it from the `tabId:` line under `[Active Tab]` (or the windows list) in the context block.',
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
    'or list all frames (including iframes) in a tab. ' +
    'Use the tab list from the context block to find tab IDs and window IDs.',
  parameters: TabParameters,

  async execute(_toolCallId, params, signal): Promise<AgentToolResult<{}>> {
    signal?.throwIfAborted();

    switch (params.action) {
      case 'open': {
        if (!params.url) {
          throw new Error('"url" is required for open action.');
        }
        let parsed: URL;
        try {
          parsed = new URL(params.url);
        } catch {
          throw new Error(`Invalid URL for tab open: ${params.url}`);
        }
        if (!['http:', 'https:'].includes(parsed.protocol)) {
          throw new Error(`Only http/https URLs are allowed. Got: ${parsed.protocol}`);
        }
        const createProps: chrome.tabs.CreateProperties = { url: params.url };
        if (params.windowId != null) {
          try {
            await chrome.windows.get(params.windowId);
          } catch {
            throw new Error(`Window ${params.windowId} does not exist.`);
          }
          createProps.windowId = params.windowId;
        }
        const tab = await chrome.tabs.create(createProps);
        return {
          content: [{ type: 'text', text: `Opened new tab (id: ${tab.id}) in window ${tab.windowId}: ${params.url}` }],
          details: {},
        };
      }

      case 'close': {
        if (params.tabId == null) {
          throw new Error('"tabId" is required for close action.');
        }
        await chrome.tabs.remove(params.tabId);
        return {
          content: [{ type: 'text', text: `Closed tab: ${params.tabId}` }],
          details: {},
        };
      }

      case 'switch': {
        if (params.tabId == null) {
          throw new Error('"tabId" is required for switch action.');
        }
        await chrome.tabs.update(params.tabId, { active: true });
        const tab = await chrome.tabs.get(params.tabId);
        return {
          content: [{ type: 'text', text: `Switched to tab: ${tab.title ?? tab.url}` }],
          details: {},
        };
      }

      case 'reload': {
        if (params.tabId == null) {
          throw new Error('"tabId" is required for reload action.');
        }
        await chrome.tabs.reload(params.tabId);
        return {
          content: [{ type: 'text', text: `Reloaded tab: ${params.tabId}` }],
          details: {},
        };
      }

      case 'list_frames': {
        if (params.tabId == null) {
          throw new Error('"tabId" is required for list_frames action.');
        }
        const tabId = params.tabId;
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
          details: {},
        };
      }

      default:
        throw new Error(`Unknown action: ${(params as { action?: string }).action}`);
    }
  },
};
