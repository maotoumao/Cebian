import type { ReactNode } from 'react';
import type { RequestOutcome } from '../requesters';

/** 面板可见状态：等待点击 / 请求中 / 某个归一化结果。各权限面板共用。 */
export type PanelState = 'idle' | 'requesting' | RequestOutcome;

/** 统一的居中卡片排版：图标 + 标题 + 说明 +（可选）操作按钮。
 *  各权限面板共用，保证版式一致。 */
export function Panel({
  icon,
  title,
  body,
  action,
}: {
  icon: ReactNode;
  title: string;
  body?: string;
  action?: ReactNode;
}) {
  return (
    <div className="flex flex-col items-center gap-3">
      <div className="grid size-12 place-items-center rounded-2xl bg-muted">{icon}</div>
      <h1 className="text-base font-semibold">{title}</h1>
      {body && <p className="text-sm leading-relaxed text-muted-foreground">{body}</p>}
      {action}
    </div>
  );
}
