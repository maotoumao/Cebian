import * as React from 'react';
import { Eye, EyeOff } from 'lucide-react';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

// 带显示 / 隐藏切换（眼睛图标）的密码输入框。可见性状态由组件自持，卸载即复位——
// 表单重新打开时总是回到隐藏态。className 作用于内部 Input，与普通 Input 用法一致
function PasswordInput({ className, ...props }: Omit<React.ComponentProps<'input'>, 'type'>) {
  const [visible, setVisible] = React.useState(false);
  return (
    <div className="relative w-full">
      <Input
        type={visible ? 'text' : 'password'}
        className={cn('pr-8', className)}
        {...props}
      />
      <Button
        type="button"
        variant="ghost"
        size="icon-xs"
        className="absolute right-1 top-1/2 -translate-y-1/2"
        onClick={() => setVisible(v => !v)}
        tabIndex={-1}
      >
        {visible ? <EyeOff className="size-3.5" /> : <Eye className="size-3.5" />}
      </Button>
    </div>
  );
}

export { PasswordInput };
