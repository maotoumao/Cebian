// 录制按钮旁的小下拉：选择录「页面操作」「网络请求」哪几项（可以都不勾，此时录制按钮
// 置灰）。选项状态由 RecordButton 持有（与开始录制读的是同一份），这里只负责展示与修改。
//
// Firefox 的网络录制依赖可选权限 webRequest：勾选时在点击处理里同步申请（之前不能有 await，
// 否则浏览器不认为是用户手势），拒绝则保持未勾选。

import { useEffect, useId, useState } from 'react';
import { ChevronDown } from 'lucide-react';
import { toast } from 'sonner';
import { browser } from 'wxt/browser';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { t } from '@/lib/i18n';
import type { RecorderOptions } from '@/lib/recorder/types';

interface RecorderOptionsMenuProps {
  options: RecorderOptions;
  /** 写入一部分选项（合并到最新保存的值上）。 */
  onChange: (patch: Partial<RecorderOptions>) => void;
  /** 录制进行中（本轮选项已定）或助手正在运行时不可修改。 */
  disabled?: boolean;
}

export function RecorderOptionsMenu({ options, onChange, disabled }: RecorderOptionsMenuProps) {
  const [open, setOpen] = useState(false);
  const [requesting, setRequesting] = useState(false);
  const hintId = useId();

  // 变为不可修改时（如别的窗口开始了录制）收起已展开的菜单；恢复可用后不自己弹出来
  useEffect(() => {
    if (disabled) setOpen(false);
  }, [disabled]);

  const toggleNetwork = (checked: boolean) => {
    if (!checked || !import.meta.env.FIREFOX) {
      onChange({ network: checked });
      return;
    }
    // 同步发起申请：保住用户手势
    setRequesting(true);
    browser.permissions.request({ permissions: ['webRequest'] })
      .catch((err: unknown) => {
        console.warn('[recorder] webRequest permission request failed:', err);
        return false;
      })
      .then((granted) => {
        if (granted) onChange({ network: true });
        else toast.warning(t('errors.recorder.networkPermissionDenied'));
      })
      .finally(() => setRequesting(false));
  };

  return (
    <Popover open={open && !disabled} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          variant="ghost"
          size="icon-xs"
          title={t('chat.recorder.options')}
          disabled={disabled}
          className="h-7 w-5"
        >
          <ChevronDown className="size-3" />
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-64 p-3" align="start">
        <div className="flex flex-col gap-3 text-sm">
          <p className="text-xs font-medium text-muted-foreground">{t('chat.recorder.options')}</p>
          <label className="flex items-center gap-2">
            <Checkbox
              checked={options.interactions}
              onCheckedChange={(checked) => onChange({ interactions: checked === true })}
            />
            {t('chat.recorder.interactions')}
          </label>
          <div className="flex flex-col gap-1">
            <label className="flex items-center gap-2">
              <Checkbox
                checked={options.network}
                disabled={requesting}
                aria-describedby={hintId}
                onCheckedChange={(checked) => toggleNetwork(checked === true)}
              />
              {t('chat.recorder.network')}
            </label>
            <p id={hintId} className="pl-6 text-xs text-muted-foreground">
              {import.meta.env.FIREFOX ? t('chat.recorder.networkHintFirefox') : t('chat.recorder.networkHint')}
            </p>
          </div>
        </div>
      </PopoverContent>
    </Popover>
  );
}
