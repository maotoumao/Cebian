# Documentation screenshots

Captured from Cebian commit `595010db2a5b87546ad26d8b9e9b5f55ca099177` using Chrome for Testing 145.0.7632.77 and an isolated profile. These are actual Simplified Chinese extension pages with non-sensitive demonstration data; the same assets are shared by the three documentation locales. Settings and VFS were opened as extension tabs; chat screenshots show the extension's sidepanel page in a sized viewport, not a whole browser window.

No UI was redrawn, relabeled, or forced into a hidden state. No remote inference or paid model call was made. The model picker uses a local demonstration `/v1/models` list (`demo-*`); it does not document a real provider's catalogue. The context example was imported via the real backup API; the backend computed its usage and whether the compact action should appear. The VFS HTML and uploaded text file are explicitly demonstration files, not claimed model output.

`manual-compaction.png` is an unscaled crop of the original context screenshot. Other PNGs retain the original captures. The uncropped context screenshot is deliberately omitted because it repeats the same controls and long fixture text. No browser profile, private key, or real account credentials are included.

As of capture, the latest release was v1.8.0. Manual compaction, tool-calling controls, model picker/multi-select changes, and network recording were main-branch features awaiting release. The public guides describe how to use the features without release-status labels. Build and source details describe the capture, not a promise that the release status will never change.
