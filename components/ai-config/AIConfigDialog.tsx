/**
 * AIConfigDialog — dialog wrapper for AIConfigContent.
 *
 * Shows the full editor when the panel is wide enough (>= 680px).
 * Shows a redirect hint when the panel is too narrow.
 * Registered in the dialog system as 'ai-config'.
 */
import { useState, useEffect } from 'react';
import { ExternalLink } from 'lucide-react';
import { DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { AIConfigContent } from './AIConfigContent';
import { aiConfigDialogPanelWidth } from '@/lib/storage';
import { AI_CONFIG_MIN_DIALOG_WIDTH } from '@/lib/constants';

export function AIConfigDialog() {
  const [tooNarrow, setTooNarrow] = useState(false);

  useEffect(() => {
    const check = () => setTooNarrow(document.documentElement.clientWidth < AI_CONFIG_MIN_DIALOG_WIDTH);
    check();
    const ro = new ResizeObserver(check);
    ro.observe(document.documentElement);
    return () => ro.disconnect();
  }, []);

  const openInTab = () => {
    chrome.tabs.create({ url: browser.runtime.getURL('/ai-config.html') });
  };

  if (tooNarrow) {
    return (
      <div className="flex flex-col h-[50vh]">
        <DialogHeader className="shrink-0 px-5 pt-5 pb-3">
          <DialogTitle className="text-base">AI 配置</DialogTitle>
        </DialogHeader>
        <div className="flex flex-col items-center justify-center gap-4 p-8 flex-1">
          <p className="text-sm text-muted-foreground text-center">当前面板宽度不足，建议在新标签页中打开</p>
          <Button onClick={openInTab} variant="outline" size="sm">
            <ExternalLink className="size-4 mr-2" />
            在新标签页中打开
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col h-[85vh]">
      <DialogHeader className="shrink-0 px-5 pt-5 pb-0">
        <DialogTitle className="text-base">AI 配置</DialogTitle>
      </DialogHeader>
      <AIConfigContent
        panelWidthStorage={aiConfigDialogPanelWidth}
        className="flex-1 min-h-0"
      />
    </div>
  );
}
