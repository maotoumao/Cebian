/**
 * Human-readable labels for tool calls based on tool name + arguments.
 * Used by ToolCard to show concise descriptions instead of raw tool names.
 */

export function getToolLabel(name: string, args: Record<string, any>): string {
  switch (name) {
    case 'read_page':
      return `正在阅读页面内容 (${args.mode ?? 'readable'})`;
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
    default:
      return name;
  }
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
