// 麦克风授权 gate —— UX 侧（sidepanel）使用。
//
// sidepanel 自己无法弹出 `getUserMedia` 授权框（会被判 `Permission dismissed`），
// 所以授权要走独立标签页 `entrypoints/user-permission`（见该页注释）。本模块是
// 麦克风按钮调用语音识别前的「授权闸门」：探测当前授权态、必要时打开授权页或
// 系统设置页。授权绑定在扩展 origin，一次授权后 sidepanel 即可直接用麦克风。
//
// 交互（方案 b，无 IPC 回传）：未授权时打开授权页让用户授权，用户授权后回到
// sidepanel **再点一次**按钮——此时 query 已是 granted，直接进入识别。

/** 麦克风授权状态。`unknown` 表示无法探测（Permissions API 不支持麦克风名）。 */
export type MicPermissionState = 'granted' | 'prompt' | 'denied' | 'unknown';

const PERMISSION_PAGE = 'user-permission.html';
const MIC_SETTINGS_URL = 'chrome://settings/content/microphone';

/** 探测当前麦克风授权态。不弹任何框，纯查询。 */
export async function queryMicPermission(): Promise<MicPermissionState> {
  try {
    // `microphone` 不在标准 PermissionName 联合里（各浏览器支持度不一），用 as 绕过。
    const status = await navigator.permissions.query({
      name: 'microphone' as PermissionName,
    });
    return status.state as MicPermissionState;
  } catch {
    // 不支持查询麦克风名：返回 unknown，让调用方走「尝试 → 失败再引导」的兜底路径。
    return 'unknown';
  }
}

/** 打开授权跳板标签页，引导用户在普通标签页里完成一次麦克风授权。 */
export function openMicPermissionPage(): void {
  void chrome.tabs.create({
    url: `${chrome.runtime.getURL(PERMISSION_PAGE)}?type=microphone`,
  });
}

/** 打开 Chrome 麦克风内容设置页。用于 denied 后引导用户手动放开。 */
export function openSystemMicSettings(): void {
  void chrome.tabs.create({ url: MIC_SETTINGS_URL });
}
