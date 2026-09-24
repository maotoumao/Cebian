import { useCallback, useEffect, useState } from 'react';
import { AlertTriangle } from 'lucide-react';
import { Toaster } from '@/components/ui/sonner';
import { useStorageItem } from '@/hooks/useStorageItem';
import { themePreference } from '@/lib/persistence/storage';
import { t } from '@/lib/i18n';
import { openPermissionSettings } from '@/lib/ui/user-permission';
import { REQUESTERS, parsePermissionType } from './requesters';
import { Panel, type PanelState } from './panels/Panel';
import { PermissionPanel } from './panels/PermissionPanel';
import { PANEL_CONFIGS } from './panels/configs';

// 通用「用户权限」页（独立标签页）。
//
// 目的：sidepanel 等扩展页面无法弹出某些运行时授权弹窗（典型如麦克风
// `getUserMedia` —— 在 sidepanel 里会直接被判 `Permission dismissed`）。
// 而普通扩展标签页可以正常弹授权框，所以这里作为「授权跳板」：在标签页里
// 触发一次浏览器授权，用户允许后授权绑定到扩展 origin、全扩展通用，
// 之后 sidepanel 即可直接使用。
//
// 本文件只做「外壳」：主题 bootstrap、`?type=` 路由、选面板、请求编排与
// 标签页自关。权限请求逻辑在 `requesters/`，各权限 UI 在 `panels/`。

/** 页面整体状态：unknownType=未知权限类型终态；其余复用面板可见状态。 */
type PageState = 'unknownType' | PanelState;

function resolveTheme(pref: 'dark' | 'light' | 'system'): 'dark' | 'light' {
  if (pref !== 'system') return pref;
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

function applyTheme(pref: 'dark' | 'light' | 'system'): void {
  document.documentElement.setAttribute('data-theme', resolveTheme(pref));
}

/** 关闭当前标签页。优先用 tabs API（本页由 chrome.tabs.create 打开，
 *  普通 `window.close()` 对这类标签页通常无效）。 */
async function closeSelfTab(): Promise<void> {
  try {
    const tab = await chrome.tabs.getCurrent();
    if (tab?.id != null) {
      await chrome.tabs.remove(tab.id);
      return;
    }
  } catch {
    /* 退回 window.close */
  }
  window.close();
}

export default function App() {
  const [theme] = useStorageItem(themePreference, 'system');
  useEffect(() => applyTheme(theme), [theme]);

  // 跟随 system 主题变化。
  useEffect(() => {
    if (theme !== 'system') return;
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    const handler = () => applyTheme('system');
    mq.addEventListener('change', handler);
    return () => mq.removeEventListener('change', handler);
  }, [theme]);

  // 解析 ?type=；未知类型走 unknownType 终态。
  const type = parsePermissionType(new URLSearchParams(window.location.search).get('type') ?? '');
  const [state, setState] = useState<PageState>(type ? 'idle' : 'unknownType');

  // denied 时 openPermissionSettings 打不开设置页的失败提示走 sonner，页面底部挂了 Toaster
  const request = useCallback(async () => {
    if (!type) return;
    setState('requesting');
    const outcome = await REQUESTERS[type]();
    setState(outcome);
    if (outcome === 'granted') {
      // 略作停留让用户看到成功提示，再自动关闭标签页。
      setTimeout(() => void closeSelfTab(), 1200);
    } else if (outcome === 'denied') {
      // 被阻止后已无法再弹框，直接打开（或切到）Chrome 设置引导手动放开。
      void openPermissionSettings(type);
    }
  }, [type]);

  return (
    <div className="flex min-h-screen items-center justify-center bg-background px-6 text-foreground">
      <div className="w-full max-w-sm text-center">
        {state === 'unknownType' || !type ? (
          <Panel
            icon={<AlertTriangle className="size-6 text-amber-500" />}
            title={t('permission.unknownType')}
          />
        ) : (
          <PermissionPanel
            state={state}
            onRequest={request}
            icon={PANEL_CONFIGS[type].icon}
            messages={PANEL_CONFIGS[type].messages()}
          />
        )}
      </div>
      <Toaster theme={resolveTheme(theme)} />
    </div>
  );
}
