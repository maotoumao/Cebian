import type { ReactNode } from 'react';
import { Mic, Type } from 'lucide-react';
import type { PermissionType } from '@/lib/ui/user-permission';
import { t } from '@/lib/i18n';
import type { PermissionMessages } from './PermissionPanel';

/** 各权限类型在授权页上的图标与文案。文案用函数取，保证渲染时按当前语言解析。 */
export const PANEL_CONFIGS: Record<PermissionType, { icon: ReactNode; messages: () => PermissionMessages }> = {
  microphone: {
    icon: <Mic className="size-6 text-primary" />,
    messages: () => ({
      title: t('permission.microphone.title'),
      description: t('permission.microphone.description'),
      allow: t('permission.microphone.allow'),
      requesting: t('permission.microphone.requesting'),
      granted: t('permission.microphone.granted'),
      dismissed: t('permission.microphone.dismissed'),
      denied: t('permission.microphone.denied'),
      deniedHint: t('permission.microphone.deniedHint'),
      deviceError: t('permission.microphone.deviceError'),
    }),
  },
  'local-fonts': {
    icon: <Type className="size-6 text-primary" />,
    messages: () => ({
      title: t('permission.localFonts.title'),
      description: t('permission.localFonts.description'),
      allow: t('permission.localFonts.allow'),
      requesting: t('permission.localFonts.requesting'),
      granted: t('permission.localFonts.granted'),
      dismissed: t('permission.localFonts.dismissed'),
      denied: t('permission.localFonts.denied'),
      deniedHint: t('permission.localFonts.deniedHint'),
      // 本机字体没有「设备」：deviceError 表示读取本身出错
      deviceError: t('permission.localFonts.failed'),
    }),
  },
};
