// ─── iPhone 14 Pro device profile ───

const DEVICE = {
  width: 393,
  height: 852,
  deviceScaleFactor: 3,
  mobile: true,
  screenWidth: 393,
  screenHeight: 852,
  userAgent:
    'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) ' +
    'AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
};

// ─── CDP helpers ───

export async function attachEmulation(tabId: number): Promise<void> {
  const target = { tabId };
  try {
    await chrome.debugger.attach(target, '1.3');
  } catch (err: any) {
    // Already attached — safe to continue
    if (!String(err?.message).includes('Already attached')) throw err;
  }
  await chrome.debugger.sendCommand(target, 'Emulation.setDeviceMetricsOverride', {
    width: DEVICE.width,
    height: DEVICE.height,
    deviceScaleFactor: DEVICE.deviceScaleFactor,
    mobile: DEVICE.mobile,
    screenWidth: DEVICE.screenWidth,
    screenHeight: DEVICE.screenHeight,
  });
  await chrome.debugger.sendCommand(target, 'Emulation.setUserAgentOverride', {
    userAgent: DEVICE.userAgent,
  });
}

export async function detachEmulation(tabId: number): Promise<void> {
  const target = { tabId };
  try {
    await chrome.debugger.sendCommand(target, 'Emulation.clearDeviceMetricsOverride');
    await chrome.debugger.sendCommand(target, 'Emulation.setUserAgentOverride', { userAgent: '' });
  } catch {
    // CDP commands may fail if tab is in a restricted state — still detach
  }
  try {
    await chrome.debugger.detach(target);
  } catch {
    // Tab may have been closed or debugger already detached
  }
}
