import { describe, expect, it } from 'vitest';
import { isExtensionPageSender } from './sender';

const tab = { id: 7 } as chrome.tabs.Tab;

describe('isExtensionPageSender', () => {
  it('接受侧边栏等无 tab 的扩展页面', () => {
    expect(isExtensionPageSender({ id: chrome.runtime.id, url: chrome.runtime.getURL('/sidepanel.html') })).toBe(true);
  });

  it('接受以标签页打开的扩展页面', () => {
    expect(isExtensionPageSender({ id: chrome.runtime.id, url: chrome.runtime.getURL('/settings.html'), tab })).toBe(true);
  });

  it('拒绝内容脚本（url 是网页地址）', () => {
    expect(isExtensionPageSender({ id: chrome.runtime.id, url: 'https://example.com/', tab })).toBe(false);
  });

  it('拒绝其它扩展', () => {
    expect(isExtensionPageSender({ id: 'other-extension', url: chrome.runtime.getURL('/settings.html') })).toBe(false);
  });

  it('拒绝缺少 url 的来源', () => {
    expect(isExtensionPageSender({ id: chrome.runtime.id })).toBe(false);
  });

  it('拒绝仅以本扩展 origin 为前缀的伪造 url', () => {
    const origin = chrome.runtime.getURL('').replace(/\/$/, '');
    expect(isExtensionPageSender({ id: chrome.runtime.id, url: `${origin}evil/settings.html` })).toBe(false);
  });
});
