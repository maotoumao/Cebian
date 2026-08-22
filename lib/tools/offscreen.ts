/**
 * Shared offscreen document lifecycle management.
 * Both read-page and screenshot tools need the offscreen document,
 * so this module provides a single coordinated ensureOffscreen().
 */

const OFFSCREEN_URL = 'offscreen.html';

/** Singleton promise to avoid concurrent createDocument calls. */
let offscreenReady: Promise<void> | null = null;

/**
 * Ensure the offscreen document exists, creating it if needed.
 *
 * 失败**不进缓存**：offscreen 是 read-page / 截图 / PDF / 划词后处理的共同前置，若把
 * 被拒的 promise 留在这里，一次偶发的 createDocument 失败就会让这些能力在本 service
 * worker 的整个生命周期里全部报废（表现为「忽然全坏了，重启浏览器才好」）。清掉缓存
 * 让下次调用重试。
 *
 * 已知未覆盖：文档被外部关闭后，已 resolve 的缓存会变成过期状态。要处理得每次调用都
 * 异步复核 hasDocument()，有竞态，属于另一件事。
 */
export async function ensureOffscreen(): Promise<void> {
  if (!offscreenReady) {
    offscreenReady = (async () => {
      const existing = await chrome.offscreen.hasDocument();
      if (existing) return;
      await chrome.offscreen.createDocument({
        url: chrome.runtime.getURL(OFFSCREEN_URL),
        reasons: ['DOM_PARSER'],
        justification: 'Parse HTML / crop images using DOM APIs (DOMParser, Canvas)',
      });
    })().catch((err: unknown) => {
      offscreenReady = null;
      throw err;
    });
  }
  return offscreenReady;
}
