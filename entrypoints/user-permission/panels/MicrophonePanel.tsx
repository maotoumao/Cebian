import { Mic, Check, AlertTriangle } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { t } from '@/lib/i18n';
import { Panel } from './Panel';
import type { RequestOutcome } from '../requesters';

/** 面板可见状态：等待点击 / 请求中 / 某个归一化结果。 */
export type PanelState = 'idle' | 'requesting' | RequestOutcome;

/** 麦克风授权面板：根据状态展示引导 / 成功 / 失败，并提供请求或重试按钮。 */
export function MicrophonePanel({ state, onRequest }: { state: PanelState; onRequest: () => void }) {
  if (state === 'granted') {
    return (
      <Panel
        icon={<Check className="size-6 text-emerald-500" />}
        title={t('permission.microphone.title')}
        body={t('permission.microphone.granted')}
      />
    );
  }

  const requesting = state === 'requesting';

  // 失败态（dismissed / denied / deviceError）：展示对应说明 + 重试按钮。
  const errorBody =
    state === 'denied'
      ? t('permission.microphone.deniedHint')
      : state === 'dismissed'
        ? t('permission.microphone.dismissed')
        : state === 'deviceError'
          ? t('permission.microphone.deviceError')
          : null;

  return (
    <Panel
      icon={
        errorBody ? (
          <AlertTriangle className="size-6 text-amber-500" />
        ) : (
          <Mic className="size-6 text-primary" />
        )
      }
      title={state === 'denied' ? t('permission.microphone.denied') : t('permission.microphone.title')}
      body={errorBody ?? t('permission.microphone.description')}
      action={
        <Button onClick={onRequest} disabled={requesting} className="mt-2">
          {requesting
            ? t('permission.microphone.requesting')
            : errorBody
              ? t('permission.retry')
              : t('permission.microphone.allow')}
        </Button>
      }
    />
  );
}
