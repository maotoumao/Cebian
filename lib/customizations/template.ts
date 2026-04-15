/**
 * Template variable replacement engine for Prompts.
 *
 * Replaces {{variable}} placeholders in prompt content with actual values.
 * Unknown variables are left as-is.
 */

/** Built-in template variable names. */
export const TEMPLATE_VARIABLES = [
  { name: 'selected_text', label: '页面选中文本' },
  { name: 'page_url', label: '当前页面 URL' },
  { name: 'page_title', label: '当前页面标题' },
  { name: 'date', label: '当前日期' },
  { name: 'clipboard', label: '剪贴板内容' },
] as const;

export type TemplateVarName = (typeof TEMPLATE_VARIABLES)[number]['name'];

/**
 * Replace all {{variable}} occurrences in content using the provided vars map.
 * Unknown variables (not in vars) are left untouched.
 */
export function replaceTemplateVars(content: string, vars: Record<string, string>): string {
  return content.replace(/\{\{(\w+)\}\}/g, (match, name: string) => {
    return Object.hasOwn(vars, name) ? vars[name] : match;
  });
}

/**
 * Gather all built-in template variable values from the current context.
 * Runs in the sidepanel (has access to chrome.tabs and navigator.clipboard).
 */
export async function gatherTemplateVars(): Promise<Record<string, string>> {
  const vars: Record<string, string> = {};

  // Date
  vars.date = new Date().toLocaleDateString();

  // Tab info + selected text
  let tab: chrome.tabs.Tab | undefined;
  try {
    [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tab) {
      vars.page_url = tab.url ?? '';
      vars.page_title = tab.title ?? '';
    }
  } catch {
    vars.page_url = '';
    vars.page_title = '';
  }

  try {
    if (tab?.id) {
      const results = await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        func: () => window.getSelection()?.toString() ?? '',
      });
      vars.selected_text = results?.[0]?.result ?? '';
    }
  } catch {
    vars.selected_text = '';
  }

  // Clipboard
  try {
    vars.clipboard = await navigator.clipboard.readText();
  } catch {
    vars.clipboard = '';
  }

  return vars;
}
