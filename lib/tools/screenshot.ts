import { Type } from '@sinclair/typebox';
import type { AgentTool, AgentToolResult } from '@mariozechner/pi-agent-core';
import { TOOL_SCREENSHOT } from '@/lib/types';

const ScreenshotParameters = Type.Object({
  quality: Type.Optional(
    Type.Number({
      description: 'JPEG quality (1-100). Default: 80.',
      minimum: 1,
      maximum: 100,
    }),
  ),
});

export const screenshotTool: AgentTool<typeof ScreenshotParameters> = {
  name: TOOL_SCREENSHOT,
  label: 'Screenshot',
  description:
    'Capture a screenshot of the current visible area of the active tab. ' +
    'Returns the image for visual analysis. ' +
    'Use this to see what the page looks like, verify UI state, or analyze layout.',
  parameters: ScreenshotParameters,

  async execute(_toolCallId, params, signal): Promise<AgentToolResult<{ status: string }>> {
    signal?.throwIfAborted();
    const quality = params.quality ?? 80;

    const dataUrl = await chrome.tabs.captureVisibleTab(undefined, {
      format: 'jpeg',
      quality,
    });

    // Extract base64 data from data URL
    const base64 = dataUrl.replace(/^data:image\/jpeg;base64,/, '');

    return {
      content: [
        { type: 'image', data: base64, mimeType: 'image/jpeg' },
      ],
      details: { status: 'done' },
    };
  },
};
