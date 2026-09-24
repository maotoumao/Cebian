import { useId, useRef, useState } from 'react';
import { Check, ChevronDown } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from '@/components/ui/command';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { MAX_CUSTOM_FONT_NAME_LENGTH } from '@/lib/persistence/storage';
import { toCssString } from '@/lib/ui/chat-appearance';
import { getQueryLocalFonts, type QueryLocalFonts } from '@/lib/ui/local-fonts';
import { openPermissionPage, openPermissionSettings, queryPermission } from '@/lib/ui/user-permission';
import { cn } from '@/lib/utils';
import { t } from '@/lib/i18n';

type LoadState =
  | { status: 'idle' }
  | { status: 'loading' }
  | { status: 'ready'; families: string[] }
  | { status: 'empty' }
  | { status: 'failed' };

/**
 * 读取本机字体族列表：queryLocalFonts 按字重 / 样式逐个返回字形，按 family 去重后排序。
 * 调用方已确认权限不是 prompt / denied（见 LocalFontPicker）；查不到权限状态（unknown）时也会走到这里，
 * 此时乐观尝试，未授权的结果多半是空列表，按「没有找到字体」展示。
 */
async function loadFontFamilies(query: QueryLocalFonts): Promise<LoadState> {
  try {
    const fonts = await query();
    // 超长的族名存储时会被截断、截断后就对不上字体，干脆不列
    const families = [
      ...new Set(fonts.map((f) => f.family).filter((f) => f && f.length <= MAX_CUSTOM_FONT_NAME_LENGTH)),
    ];
    families.sort((a, b) => a.localeCompare(b));
    return families.length > 0 ? { status: 'ready', families } : { status: 'empty' };
  } catch (err) {
    console.warn('[appearance] query local fonts failed:', err);
    return { status: 'failed' };
  }
}

/**
 * 本机字体选择器：可搜索的下拉，选项用该字体本身渲染。
 *
 * 授权沿用麦克风的做法：侧边栏弹不出浏览器授权框，所以点开时先查权限——未授权（prompt）打开
 * 授权跳板标签页让用户在那里允许，已阻止（denied）打开 Chrome 的本机字体设置页；两种情况都不
 * 展开下拉，用户授权后回来再点一次即可。已授权（或查不到权限状态）才展开并读取列表。
 * 读到的非空列表缓存在组件内（组件卸载即丢弃）；空结果 / 失败在下次展开时重试。
 *
 * 当前值不在列表里（字体已卸载 / 从别的设备恢复的备份）时，触发按钮仍显示它；浏览器找不到该
 * 字体会自动回退默认字体。
 */
function LocalFontPicker({
  value,
  onChange,
  disabled,
  labelledBy,
  describedBy,
}: {
  value: string;
  onChange: (family: string) => void;
  disabled?: boolean;
  labelledBy: string;
  describedBy?: string;
}) {
  const [open, setOpen] = useState(false);
  const [load, setLoad] = useState<LoadState>({ status: 'idle' });
  // 列表高亮项：打开时定位到当前字体，而不是停在第一项（同 ModelSelector）
  const [highlighted, setHighlighted] = useState('');
  const valueId = useId();
  const query = getQueryLocalFonts();
  // 权限查询在途时忽略重复点击，免得连点两下就查两次权限、读两遍字体
  const checkingRef = useRef(false);

  const openList = () => {
    setHighlighted(value);
    setOpen(true);
    if (query && load.status !== 'ready' && load.status !== 'loading') {
      setLoad({ status: 'loading' });
      void loadFontFamilies(query).then(setLoad);
    }
  };

  const handleOpenChange = (next: boolean) => {
    if (!next) {
      setOpen(false);
      return;
    }
    if (checkingRef.current) return;
    checkingRef.current = true;
    void queryPermission('local-fonts').then((permission) => {
      checkingRef.current = false;
      if (permission === 'prompt') {
        void openPermissionPage('local-fonts').then((opened) => {
          if (opened) toast.info(t('settings.appearance.font.needPermission'));
        });
      } else if (permission === 'denied') {
        void openPermissionSettings('local-fonts').then((opened) => {
          if (opened) toast.error(t('errors.localFontsPermissionDenied'));
        });
      } else {
        openList();
      }
    });
  };

  // 首次打开时先显示读取中、列表稍后才挂载，Radix 的初始聚焦落不到输入框上，故搜索框自己 autoFocus
  const message =
    load.status === 'loading'
      ? t('settings.appearance.font.loading')
      : load.status === 'empty'
        ? t('settings.appearance.font.notFound')
        : load.status === 'failed'
          ? t('errors.localFontsLoadFailed')
          : null;

  return (
    <Popover open={open} onOpenChange={handleOpenChange}>
      <PopoverTrigger asChild>
        <Button
          variant="outline"
          size="sm"
          disabled={disabled || !query}
          aria-labelledby={`${labelledBy} ${valueId}`}
          aria-describedby={describedBy}
          className="w-full max-w-72 justify-between font-normal"
        >
          <span
            id={valueId}
            className="truncate min-w-0"
            style={value ? { fontFamily: toCssString(value) } : undefined}
          >
            {value || t('settings.appearance.font.pickerPlaceholder')}
          </span>
          <ChevronDown data-icon className="shrink-0 opacity-60" />
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-72 p-0" align="start">
        {message ? (
          <p role="status" className="px-3 py-4 text-xs text-muted-foreground">{message}</p>
        ) : (
          <Command
            label={t('settings.appearance.font.label')}
            // 当前字体不在列表里（已卸载 / 恢复自别的设备）时不指定高亮项，交给 cmdk 默认高亮第一项
            value={load.status === 'ready' && load.families.includes(highlighted) ? highlighted : ''}
            onValueChange={setHighlighted}
          >
            <CommandInput autoFocus placeholder={t('settings.appearance.font.searchPlaceholder')} />
            <CommandList label={t('settings.appearance.font.label')}>
              <CommandEmpty>{t('settings.appearance.font.notFound')}</CommandEmpty>
              <CommandGroup>
                {load.status === 'ready' &&
                  load.families.map((family) => (
                    <CommandItem
                      key={family}
                      value={family}
                      // 每项用自身字体渲染：屏幕外的项跳过排版，免得一打开就把几百个字体文件全加载一遍
                      className="[content-visibility:auto] [contain-intrinsic-size:auto_2rem]"
                      onSelect={() => {
                        onChange(family);
                        setOpen(false);
                      }}
                    >
                      <span className="truncate min-w-0" style={{ fontFamily: toCssString(family) }}>
                        {family}
                      </span>
                      <Check className={cn('ml-auto shrink-0', family === value ? 'opacity-100' : 'opacity-0')} />
                    </CommandItem>
                  ))}
              </CommandGroup>
            </CommandList>
          </Command>
        )}
      </PopoverContent>
    </Popover>
  );
}

export { LocalFontPicker };
