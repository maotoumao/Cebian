import { useCallback, useEffect, useRef, useState, type DragEvent } from 'react';

/** 一次放下的内容：文件，以及被排除掉的文件夹名（不递归上传）。 */
interface FileDrop {
  files: File[];
  folders: string[];
}

/** 本页发起的拖动打上的标记类型（见 useFileDropGuard 里的 dragstart 监听）。 */
const INTERNAL_DRAG_TYPE = 'application/x-cebian-internal-drag';

/**
 * 只认从外部拖进来的文件；拖文本 / 链接不拦，让 textarea 等保留原生拖放行为。本页发起的
 * 拖动（如拖一下聊天记录里的图片）在 Chrome 里也可能带 Files，靠标记类型排除。
 */
function isExternalFileDrag(dt: DataTransfer | null): boolean {
  const types = Array.from(dt?.types ?? []);
  return types.includes('Files') && !types.includes(INTERNAL_DRAG_TYPE);
}

/**
 * 必须在 drop 回调里同步取：事件结束后 DataTransfer 就被清空了。文件夹在 `files` 里也是
 * 一个 File（size 0、type 空），靠 `webkitGetAsEntry()` 才分得出来（Chrome / Firefox 都支持）。
 */
function readDrop(dt: DataTransfer): FileDrop {
  const drop: FileDrop = { files: [], folders: [] };
  const items = Array.from(dt.items ?? []).filter((item) => item.kind === 'file');
  if (items.length === 0) {
    drop.files = Array.from(dt.files);
    return drop;
  }
  for (const item of items) {
    const entry = item.webkitGetAsEntry?.();
    if (entry?.isDirectory) {
      drop.folders.push(entry.name);
      continue;
    }
    const file = item.getAsFile();
    if (file) drop.files.push(file);
  }
  return drop;
}

/**
 * 拖动停在区域上时浏览器会持续派发 dragover（规范约每 350ms±200ms，实际通常更密）。
 * 超过这个时长一次都没收到，说明拖动已经不在这里了，而收尾的 dragleave 丢了。
 */
const DRAGOVER_WATCHDOG_MS = 1000;

/**
 * 把一块区域变成文件拖放区。
 *
 * 拖动经过子元素时，浏览器先对新元素发 dragenter、再对旧元素发 dragleave。这里记下「已进入、
 * 还没离开」的元素，集合清空才算离开了整块区域，遮罩不会在子元素之间闪烁。每次进入 / 悬停
 * 都把集合收紧到当前目标的祖先链（剔除已脱离文档的、不再包含当前目标的），漏掉的 leave 会在
 * 下一次事件时被清理。
 *
 * 收尾的 dragleave 仍可能整个丢失：最后悬停的元素被卸载（回到底部按钮消失、流式输出替换了
 * 节点）后紧接着按 Esc 或拖出窗口，这条 leave 只在脱离文档的子树里传播，到不了这里。所以再加
 * 一个 dragover 看门狗兜底，避免遮罩一直挂着。
 *
 * `enabled` 为 false 时照常记录（重新启用时遮罩能立刻出现），但不显示遮罩、光标显示为禁止
 * 放下，放下也不交付。
 *
 * 依赖页面根部挂着 useFileDropGuard：内部拖动的标记由它打上。
 */
function useFileDropZone({ enabled, onDrop }: { enabled: boolean; onDrop: (drop: FileDrop) => void }) {
  const enteredRef = useRef(new Set<Node>());
  const watchdogRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [isOver, setIsOver] = useState(false);

  const clearWatchdog = useCallback(() => {
    if (watchdogRef.current != null) clearTimeout(watchdogRef.current);
    watchdogRef.current = null;
  }, []);

  const reset = useCallback(() => {
    clearWatchdog();
    enteredRef.current.clear();
    setIsOver(false);
  }, [clearWatchdog]);

  useEffect(() => clearWatchdog, [clearWatchdog]);

  /** 记下当前目标，并把集合收紧到它的祖先链。 */
  const markHovered = useCallback((target: Node) => {
    const entered = enteredRef.current;
    for (const node of entered) if (!node.isConnected || !node.contains(target)) entered.delete(node);
    entered.add(target);
    setIsOver(true);
    clearWatchdog();
    watchdogRef.current = setTimeout(reset, DRAGOVER_WATCHDOG_MS);
  }, [clearWatchdog, reset]);

  const onDragEnter = useCallback((e: DragEvent) => {
    if (!isExternalFileDrag(e.dataTransfer)) return;
    e.preventDefault();
    markHovered(e.target as Node);
  }, [markHovered]);

  const onDragOver = useCallback((e: DragEvent) => {
    if (!isExternalFileDrag(e.dataTransfer)) return;
    // 不 preventDefault 就不允许放下，浏览器会走默认行为（打开文件）
    e.preventDefault();
    e.dataTransfer.dropEffect = enabled ? 'copy' : 'none';
    markHovered(e.target as Node);
  }, [enabled, markHovered]);

  const onDragLeave = useCallback((e: DragEvent) => {
    if (!isExternalFileDrag(e.dataTransfer)) return;
    const entered = enteredRef.current;
    entered.delete(e.target as Node);
    for (const node of entered) if (!node.isConnected) entered.delete(node);
    if (entered.size === 0) reset();
  }, [reset]);

  const handleDrop = useCallback((e: DragEvent) => {
    if (!isExternalFileDrag(e.dataTransfer)) return;
    e.preventDefault();
    reset();
    if (enabled) onDrop(readDrop(e.dataTransfer));
  }, [enabled, onDrop, reset]);

  return {
    isOver: isOver && enabled,
    zoneProps: { onDragEnter, onDragOver, onDragLeave, onDrop: handleDrop },
  };
}

/**
 * 页面级的文件拖放兜底，挂在页面根部（侧边栏 App）。
 * - 给本页发起的拖动打标记。标记跟着这一次拖动的 DataTransfer 走，不用维护「正在内部拖动」
 *   的状态——源元素中途被卸载时 dragend 冒不到 document，那种状态会卡住。
 * - 在拖放区以外（页头、设置页等）松开外部文件时，浏览器默认会在当前页里直接打开这个文件，
 *   把整个界面替换掉。冒泡阶段监听，让拖放区先处理；判据与拖放区相同，纯文本 / 链接和本页
 *   发起的拖动都保留原生行为。
 * - 拖到可编辑区域（contenteditable）上时 dragover 放行：CodeMirror 等编辑器自己处理文件
 *   放下（读出内容插入），但它们只在 drop 里 preventDefault，dragover 被拦成 none 就收不到
 *   drop 了。drop 照样兜底——编辑器处理过会先 preventDefault，这里跳过；没处理就不让导航。
 */
function useFileDropGuard() {
  useEffect(() => {
    const markInternal = (e: globalThis.DragEvent) => e.dataTransfer?.setData(INTERNAL_DRAG_TYPE, '');
    const blockFileDrop = (e: globalThis.DragEvent) => {
      if (e.defaultPrevented || !isExternalFileDrag(e.dataTransfer)) return;
      if (e.type === 'dragover') {
        // Firefox 的拖放目标可能是文本节点，取它所在的元素再判断
        const el = e.target instanceof Node && !(e.target instanceof Element) ? e.target.parentElement : e.target;
        if (el instanceof HTMLElement && el.isContentEditable) return;
        if (e.dataTransfer) e.dataTransfer.dropEffect = 'none';
      }
      e.preventDefault();
    };
    document.addEventListener('dragstart', markInternal, true);
    window.addEventListener('dragover', blockFileDrop);
    window.addEventListener('drop', blockFileDrop);
    return () => {
      document.removeEventListener('dragstart', markInternal, true);
      window.removeEventListener('dragover', blockFileDrop);
      window.removeEventListener('drop', blockFileDrop);
    };
  }, []);
}

export type { FileDrop };
export { useFileDropGuard, useFileDropZone };
