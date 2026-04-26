/**
 * Human-readable labels for tool calls based on tool name + arguments.
 * Used by ToolCard to show concise descriptions instead of raw tool names.
 */

import { t } from '@/lib/i18n';

export function getToolLabel(name: string, args: Record<string, any> = {}): string {
  // MCP tools: name is `mcp__<slug>__<remoteToolName>`. Parse and prettify;
  // we don't have the original server name (slug is lossy: lowercase + `_`),
  // so we surface the slug with underscores → spaces, which is good enough
  // for users who recognize their own server names.
  if (name.startsWith('mcp__')) {
    const rest = name.slice(5); // strip "mcp__"
    const sep = rest.indexOf('__');
    if (sep > 0) {
      const slug = rest.slice(0, sep).replace(/_/g, ' ');
      const tool = rest.slice(sep + 2);
      return t('tools.mcpCall', [slug, tool]);
    }
  }
  switch (name) {
    case 'read_page': {
      const mode = args.mode ?? 'markdown';
      const detail = args.selector ? `${mode}, ${args.selector}` : mode;
      return t('tools.readPage', [detail]);
    }
    case 'execute_js':
      return t('tools.executeJs');
    case 'interact':
      return getInteractLabel(args);
    case 'inspect':
      return getInspectLabel(args);
    case 'tab':
      return getTabLabel(args);
    case 'screenshot':
      return t('tools.screenshot');
    case 'ask_user':
      return t('tools.askUser');
    case 'fs_create_file':
      return t('tools.fs.createFile', [truncPath(args.path)]);
    case 'fs_edit_file':
      return t('tools.fs.editFile', [truncPath(args.path)]);
    case 'fs_mkdir':
      return t('tools.fs.mkdir', [truncPath(args.path)]);
    case 'fs_rename':
      return t('tools.fs.rename', [truncPath(args.old_path)]);
    case 'fs_delete':
      return t('tools.fs.delete', [truncPath(args.path)]);
    case 'fs_read_file':
      return t('tools.fs.readFile', [truncPath(args.path)]);
    case 'fs_list':
      return t('tools.fs.list', [truncPath(args.path)]);
    case 'fs_search':
      return args.mode === 'content'
        ? t('tools.fs.searchContent', [truncPath(args.pattern)])
        : t('tools.fs.searchFiles', [truncPath(args.pattern)]);
    case 'run_skill':
      return t('tools.runSkill', [args.skill ?? '']);
    case 'chrome_api':
      if (args.namespace === 'help') return t('tools.chromeApi.help');
      return t('tools.chromeApi.call', [args.namespace ?? '', args.method ?? '']);
    default:
      return name;
  }
}

function truncPath(p?: string): string {
  if (!p) return '';
  return p.length > 30 ? '...' + p.slice(-27) : p;
}

function getInteractLabel(args: Record<string, any>): string {
  const target = args.selector
    ? ` ${args.selector}`
    : (args.x != null ? ` (${args.x}, ${args.y})` : '');
  const truncTarget = target.length > 40 ? target.slice(0, 37) + '...' : target;

  switch (args.action) {
    case 'click': return t('tools.interact.click', [truncTarget]);
    case 'dblclick': return t('tools.interact.dblclick', [truncTarget]);
    case 'rightclick': return t('tools.interact.rightclick', [truncTarget]);
    case 'hover': return t('tools.interact.hover', [truncTarget]);
    case 'focus': return t('tools.interact.focus', [truncTarget]);
    case 'type': return t('tools.interact.type', [truncTarget]);
    case 'clear': return t('tools.interact.clear', [truncTarget]);
    case 'select': return t('tools.interact.select', [truncTarget]);
    case 'scroll': return t('tools.interact.scroll');
    case 'keypress': return t('tools.interact.keypress', [args.key ?? '']);
    case 'wait': return t('tools.interact.wait', [truncTarget]);
    case 'wait_hidden': return t('tools.interact.waitHidden', [truncTarget]);
    case 'wait_navigation': return t('tools.interact.waitNavigation');
    case 'sequence': return t('tools.interact.sequence', [args.steps?.length ?? 0]);
    default: return t('tools.interact.unknown', [args.action ?? 'unknown']);
  }
}

function getInspectLabel(args: Record<string, any>): string {
  if (args.selector) {
    const sel = args.selector.length > 40 ? args.selector.slice(0, 37) + '...' : args.selector;
    return t('tools.inspect.selector', [sel]);
  }
  if (args.text) {
    const txt = args.text.length > 40 ? args.text.slice(0, 37) + '...' : args.text;
    return t('tools.inspect.text', [txt]);
  }
  return t('tools.inspect.page');
}

function getTabLabel(args: Record<string, any>): string {
  switch (args.action) {
    case 'open': return t('tools.tab.open');
    case 'close': return t('tools.tab.close', [args.tabId ?? '']);
    case 'switch': return t('tools.tab.switch', [args.tabId ?? '']);
    case 'reload': return t('tools.tab.reload');
    case 'list_frames': return t('tools.tab.listFrames');
    default: return t('tools.tab.unknown', [args.action ?? 'unknown']);
  }
}
