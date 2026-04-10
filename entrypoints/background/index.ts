export default defineBackground(() => {
  console.log('Hello background!', { id: browser.runtime.id });

  // 点击插件图标时打开侧边栏
  chrome.sidePanel
    .setPanelBehavior({ openPanelOnActionClick: true })
    .catch((error) => console.error(error));
});
