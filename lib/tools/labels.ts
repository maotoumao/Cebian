/**
 * Human-readable labels for tool calls based on tool name + arguments.
 * Used by ToolCard to show concise descriptions instead of raw tool names.
 */

import { t } from '@/lib/i18n';
import {
  TOOL_ASK_USER,
  TOOL_EXECUTE_JS,
  TOOL_READ_PAGE,
  TOOL_INTERACT,
  TOOL_INSPECT,
  TOOL_TAB,
  TOOL_SCREENSHOT,
  TOOL_PDF,
  TOOL_FS_CREATE_FILE,
  TOOL_FS_EDIT_FILE,
  TOOL_FS_MKDIR,
  TOOL_FS_RENAME,
  TOOL_FS_DELETE,
  TOOL_FS_READ_FILE,
  TOOL_FS_LIST,
  TOOL_FS_SEARCH,
  TOOL_FS_SAVE_URL,
  TOOL_RUN_SKILL,
  TOOL_CHROME_API,
  TOOL_SEARCH_DOCUMENTS,
} from '@/lib/tools/names';

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
    case TOOL_READ_PAGE: {
      const mode = args.mode ?? 'markdown';
      const detail = args.selector ? `${mode}, ${args.selector}` : mode;
      return t('tools.readPage', [detail]);
    }
    case TOOL_EXECUTE_JS:
      return t('tools.executeJs');
    case TOOL_INTERACT:
      return getInteractLabel(args);
    case TOOL_INSPECT:
      return getInspectLabel(args);
    case TOOL_TAB:
      return getTabLabel(args);
    case TOOL_SCREENSHOT:
      return t('tools.screenshot');
    case TOOL_PDF:
      return getPdfLabel(args);
    case TOOL_ASK_USER:
      return t('tools.askUser');
    case TOOL_FS_CREATE_FILE:
      return t('tools.fs.createFile', [truncPath(args.path)]);
    case TOOL_FS_EDIT_FILE:
      return t('tools.fs.editFile', [truncPath(args.path)]);
    case TOOL_FS_MKDIR:
      return t('tools.fs.mkdir', [truncPath(args.path)]);
    case TOOL_FS_RENAME:
      return t('tools.fs.rename', [truncPath(args.old_path)]);
    case TOOL_FS_DELETE:
      return t('tools.fs.delete', [truncPath(args.path)]);
    case TOOL_FS_READ_FILE:
      return t('tools.fs.readFile', [truncPath(args.path)]);
    case TOOL_FS_LIST:
      return t('tools.fs.list', [truncPath(args.path)]);
    case TOOL_FS_SEARCH:
      return args.mode === 'content'
        ? t('tools.fs.searchContent', [truncPath(args.pattern)])
        : t('tools.fs.searchFiles', [truncPath(args.pattern)]);
    case TOOL_FS_SAVE_URL:
      return t('tools.fs.saveUrl', [truncPath(args.dest)]);
    case TOOL_RUN_SKILL:
      return t('tools.runSkill', [args.skill ?? '']);
    case TOOL_CHROME_API:
      if (args.namespace === 'help') return t('tools.chromeApi.help');
      return t('tools.chromeApi.call', [args.namespace ?? '', args.method ?? '']);
    case TOOL_SEARCH_DOCUMENTS:
      return t('tools.searchDocuments', [truncPath(args.keyword)]);
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

function getPdfLabel(args: Record<string, any>): string {
  switch (args.action) {
    case 'info':
      return t('tools.pdf.info');
    case 'read': {
      const range = args.pageRange ? String(args.pageRange) : 'all pages';
      return t('tools.pdf.read', [range]);
    }
    case 'search': {
      const q = typeof args.query === 'string' && args.query.length > 30
        ? args.query.slice(0, 27) + '...'
        : (args.query ?? '');
      return t('tools.pdf.search', [q]);
    }
    default:
      return t('tools.pdf.unknown', [args.action ?? 'unknown']);
  }
}
