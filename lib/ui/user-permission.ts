// 运行时权限的「授权闸门」—— UX 侧（侧边栏 / 设置页 / 授权页）共用。
//
// 侧边栏等扩展页面弹不出某些浏览器授权框（麦克风 `getUserMedia` 会直接被判
// `Permission dismissed`，本机字体同理），所以授权统一走独立标签页
// `entrypoints/user-permission`：在普通标签页里触发一次授权，授权绑定在扩展 origin，
// 之后侧边栏即可直接使用。调用方的交互（与麦克风按钮一致，无 IPC 回传）：
// - prompt：打开授权页，用户授权后回来**再点一次**，此时 query 已是 granted。
// - denied：已无法再弹框，打开 Chrome 对应的内容设置页让用户手动放开。
// - granted / unknown：直接使用（unknown 表示查不到状态，乐观尝试）。

import { toast } from 'sonner';
import { t } from '@/lib/i18n';

/** 授权页支持的权限类型；也是授权页 `?type=` 的取值。 */
type PermissionType = 'microphone' | 'local-fonts';

/** 授权状态。`unknown` 表示无法探测（Permissions API 不认该权限名）。 */
type PermissionQueryState = 'granted' | 'prompt' | 'denied' | 'unknown';

const PERMISSION_PAGE = 'user-permission.html';

/** 各权限在 Permissions API 里的名字（不在标准 PermissionName 联合里，查询时 as 绕过）。 */
const PERMISSION_NAMES: Record<PermissionType, string> = {
  microphone: 'microphone',
  'local-fonts': 'local-fonts',
};

/** 各权限对应的 Chrome 内容设置页，denied 后引导用户手动放开。 */
const SETTINGS_URLS: Record<PermissionType, string> = {
  microphone: 'chrome://settings/content/microphone',
  'local-fonts': 'chrome://settings/content/localFonts',
};

/** 比较用的地址：Edge 会把 `chrome://settings/...` 改写成 `edge://settings/...` 再报给 tabs API。 */
function comparableUrl(url: string | undefined): string | undefined {
  return url?.replace(/^edge:/, 'chrome:');
}

/** 切到已有标签页（连带聚焦其窗口）；该标签页恰好已被关掉等原因失败时返回 false。 */
async function focusTab(tab: chrome.tabs.Tab): Promise<boolean> {
  if (tab.id == null) return false;
  try {
    await chrome.tabs.update(tab.id, { active: true });
    await chrome.windows.update(tab.windowId, { focused: true });
    return true;
  } catch {
    return false;
  }
}

/**
 * 已有同一地址的标签页就切过去，没有（或切不过去）才新开——用户没授权就回来再点一次时，
 * 不会叠出一排相同的授权页 / 设置页。返回是否成功；失败时在这里出声，调用方据此决定要不要
 * 再给「已为你打开」之类的引导提示，免得两条提示互相矛盾。
 */
async function focusOrOpenTab(url: string): Promise<boolean> {
  try {
    const target = comparableUrl(url);
    const tabs = await chrome.tabs.query({});
    // 优先看待提交地址：正在从目标页导航离开的标签页 url 还是旧值，不能当成目标页
    const existing = tabs.find((tab) => comparableUrl(tab.pendingUrl ?? tab.url) === target);
    if (existing && (await focusTab(existing))) return true;
    await chrome.tabs.create({ url });
    return true;
  } catch (err) {
    console.warn('[permission] open tab failed:', err);
    toast.error(t('errors.openTabFailed'));
    return false;
  }
}

/** 探测当前授权态。不弹任何框，纯查询。 */
async function queryPermission(type: PermissionType): Promise<PermissionQueryState> {
  try {
    const status = await navigator.permissions.query({ name: PERMISSION_NAMES[type] as PermissionName });
    return status.state;
  } catch {
    // 不认该权限名：返回 unknown，让调用方走「尝试 → 失败再引导」的兜底路径
    return 'unknown';
  }
}

/** 打开（或切到）授权跳板页，引导用户在普通标签页里完成一次授权。返回是否成功打开。 */
function openPermissionPage(type: PermissionType): Promise<boolean> {
  return focusOrOpenTab(`${chrome.runtime.getURL(PERMISSION_PAGE)}?type=${type}`);
}

/** 打开（或切到）该权限的 Chrome 内容设置页。用于 denied 后引导用户手动放开。返回是否成功打开。 */
function openPermissionSettings(type: PermissionType): Promise<boolean> {
  return focusOrOpenTab(SETTINGS_URLS[type]);
}

export type { PermissionType };
export { openPermissionPage, openPermissionSettings, queryPermission };
