import { defineConfig } from 'wxt';
import tailwindcss from '@tailwindcss/vite';

// See https://wxt.dev/api/config.html
export default defineConfig({
  modules: ['@wxt-dev/module-react'],
  manifest: {
    permissions: ['sidePanel', 'activeTab', 'tabs', 'scripting', 'storage', 'alarms', 'offscreen', 'debugger', 'webNavigation'],
    host_permissions: ['<all_urls>'],
    action: {
      default_title: '点击打开侧边栏',
    },
  },
  vite: () => ({
    plugins: [tailwindcss()],
  }),
});
