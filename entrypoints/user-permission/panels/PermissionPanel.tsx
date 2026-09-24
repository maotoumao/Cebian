import type { ReactNode } from 'react';
import { Check, AlertTriangle } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { t } from '@/lib/i18n';
import { Panel, type PanelState } from './Panel';

/** 一类权限在授权页上的全部文案。 */
export interface PermissionMessages {
  title: string;
  description: string;
  allow: string;
  requesting: string;
  granted: string;
  dismissed: string;
  denied: string;
  deniedHint: string;
  deviceError: string;
}

/** 授权面板：根据状态展示引导 / 成功 / 失败，并提供请求或重试按钮。图标与文案由权限类型决定。 */
export function PermissionPanel({
  state,
  onRequest,
  icon,
  messages,
}: {
  state: PanelState;
  onRequest: () => void;
  icon: ReactNode;
  messages: PermissionMessages;
}) {
  if (state === 'granted') {
    return <Panel icon={<Check className="size-6 text-emerald-500" />} title={messages.title} body={messages.granted} />;
  }

  const requesting = state === 'requesting';

  // 失败态（dismissed / denied / deviceError）：展示对应说明 + 重试按钮。
  const errorBody =
    state === 'denied'
      ? messages.deniedHint
      : state === 'dismissed'
        ? messages.dismissed
        : state === 'deviceError'
          ? messages.deviceError
          : null;

  return (
    <Panel
      icon={errorBody ? <AlertTriangle className="size-6 text-amber-500" /> : icon}
      title={state === 'denied' ? messages.denied : messages.title}
      body={errorBody ?? messages.description}
      action={
        <Button onClick={onRequest} disabled={requesting} className="mt-2">
          {requesting ? messages.requesting : errorBody ? t('permission.retry') : messages.allow}
        </Button>
      }
    />
  );
}
