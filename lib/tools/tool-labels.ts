/**
 * Human-readable labels for tool calls based on tool name + arguments.
 * Used by ToolCard to show concise descriptions instead of raw tool names.
 */

export function getToolLabel(name: string, args: Record<string, any> = {}): string {
  switch (name) {
    case 'read_page':
      return `正在阅读页面内容 (${args.mode ?? 'markdown'}${args.selector ? ', ' + args.selector : ''})`;
    case 'execute_js':
      return '正在执行脚本';
    case 'interact':
      return getInteractLabel(args);
    case 'tab':
      return getTabLabel(args);
    case 'screenshot':
      return '正在截取页面截图';
    case 'ask_user':
      return '等待用户回答';
    case 'fs_create_file':
      return `正在创建文件 ${truncPath(args.path)}`;
    case 'fs_edit_file':
      return `正在编辑文件 ${truncPath(args.path)}`;
    case 'fs_mkdir':
      return `正在创建目录 ${truncPath(args.path)}`;
    case 'fs_rename':
      return `正在重命名 ${truncPath(args.old_path)}`;
    case 'fs_delete':
      return `正在删除 ${truncPath(args.path)}`;
    case 'fs_read_file':
      return `正在读取文件 ${truncPath(args.path)}`;
    case 'fs_list':
      return `正在列出目录 ${truncPath(args.path)}`;
    case 'fs_search':
      return args.mode === 'content'
        ? `正在搜索文件内容 "${truncPath(args.pattern)}"`
        : `正在搜索文件 "${truncPath(args.pattern)}"`;
    case 'execute_skill_code':
      return `正在执行技能脚本 ${args.skill ?? ''}`;
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
    case 'click': return `正在点击${truncTarget}`;
    case 'dblclick': return `正在双击${truncTarget}`;
    case 'rightclick': return `正在右键点击${truncTarget}`;
    case 'hover': return `正在悬浮${truncTarget}`;
    case 'type': return `正在输入文本${truncTarget}`;
    case 'clear': return `正在清除输入框${truncTarget}`;
    case 'select': return `正在选择选项${truncTarget}`;
    case 'scroll': return '正在滚动页面';
    case 'keypress': return `正在按键 ${args.key ?? ''}`;
    case 'wait': return `正在等待元素出现${truncTarget}`;
    case 'wait_hidden': return `正在等待元素消失${truncTarget}`;
    case 'wait_navigation': return '正在等待页面加载';
    case 'find': return `正在搜索 "${args.text ?? ''}"`;
    case 'query': return `正在查询元素${truncTarget}`;
    case 'sequence': return `正在执行操作序列 (${args.steps?.length ?? 0} 步)`;
    default: return `interact: ${args.action ?? 'unknown'}`;
  }
}

function getTabLabel(args: Record<string, any>): string {
  switch (args.action) {
    case 'open': return `正在打开新标签页`;
    case 'close': return `正在关闭标签页 ${args.tabId ?? ''}`;
    case 'switch': return `正在切换标签页 ${args.tabId ?? ''}`;
    case 'reload': return '正在刷新页面';
    case 'list_frames': return '正在列出页面 frames';
    default: return `tab: ${args.action ?? 'unknown'}`;
  }
}
