/**
 * AIConfigDialog — dialog wrapper for AIConfigContent.
 *
 * Registered in the dialog system as 'ai-config'.
 */
import { DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { AIConfigContent } from './AIConfigContent';
import { aiConfigDialogPanelWidth } from '@/lib/storage';

export function AIConfigDialog() {
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
