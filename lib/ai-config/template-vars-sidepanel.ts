/**
 * 侧边栏侧的模板变量取值器（prompts 的 `/` 菜单用）。
 *
 * 与引擎（template.ts）分开：这里要 chrome.tabs / chrome.scripting / 剪贴板，属侧边栏
 * 专有能力，background 引不得（depcruise `background-no-lib-ui`）。同一份变量表在
 * 不同上下文有不同取值路径，故按上下文各写一个取值器，引擎保持纯净。
 */

import { readText } from '@/lib/ui/clipboard';
import { languageName } from '@/lib/utils';
import type { TemplateVarName } from './template';

/** 全部变量的空值底盘。写成 Record<TemplateVarName, string> 是为了让「新增变量却忘了
 *  在这里采集」变成编译错误，而不是运行时静默留空。 */
function emptyVars(): Record<TemplateVarName, string> {
  return {
    selected_text: '',
    context: '',
    page_url: '',
    page_title: '',
    date: '',
    ui_language: '',
    clipboard: '',
  };
}

/**
 * 取当前上下文能拿到的全部模板变量值。以空值底盘起步，取到的覆盖上去——任何一步失败
 * （无活动标签页、脚本注入被拒、剪贴板无权限）都只是该变量留空，不影响其它变量。
 */
async function gatherTemplateVars(): Promise<Record<string, string>> {
  const vars = emptyVars();

  vars.date = new Date().toLocaleDateString();
  // 与内置划词动作一致给英文语言名，而不是 BCP-47 代码（见 languageName 注释）。
  vars.ui_language = languageName(chrome.i18n.getUILanguage());
  // context（选区周边文本）只有划词场景采集，这里没有对应来源，保持空串。

  let tab: chrome.tabs.Tab | undefined;
  try {
    [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tab) {
      vars.page_url = tab.url ?? '';
      vars.page_title = tab.title ?? '';
    }
  } catch {
    // 查不到活动标签页：page_url / page_title 留空。
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
    // 受限页面（chrome:// 等）注入会被拒：selected_text 留空。
  }

  // readText() 内部吞掉权限 / 焦点错误并返回 ''。
  vars.clipboard = await readText();

  return vars;
}

export { gatherTemplateVars };
