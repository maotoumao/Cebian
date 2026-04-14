/**
 * Shared offscreen document lifecycle management.
 * Both read-page and screenshot tools need the offscreen document,
 * so this module provides a single coordinated ensureOffscreen().
 */

const OFFSCREEN_URL = 'offscreen.html';

/** Singleton promise to avoid concurrent createDocument calls. */
let offscreenReady: Promise<void> | null = null;

/** Ensure the offscreen document exists, creating it if needed. */
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
    })();
  }
  return offscreenReady;
}
