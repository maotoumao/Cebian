import { ArrowLeft } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Separator } from '@/components/ui/separator';

interface SettingsPanelProps {
  open: boolean;
  onClose: () => void;
}

export function SettingsPanel({ open, onClose }: SettingsPanelProps) {
  return (
    <div
      className={`absolute inset-0 bg-background z-50 flex flex-col transition-transform duration-300 ease-out ${
        open ? 'translate-x-0' : 'translate-x-full'
      }`}
    >
      {/* Header */}
      <div className="flex items-center gap-3 px-5 py-4 border-b border-border">
        <Button variant="ghost" size="icon-xs" onClick={onClose}>
          <ArrowLeft className="size-5" />
        </Button>
        <span className="font-semibold">设置</span>
      </div>

      {/* Body */}
      <div className="flex-1 overflow-y-auto px-5 py-5 space-y-6">
        {/* LLM Config */}
        <div className="space-y-2">
          <label className="text-[0.75rem] text-muted-foreground tracking-wide">
            LLM 模型配置
          </label>
          <p className="text-[0.9rem] mb-1">切换模型提供商</p>
          <select className="w-full bg-card border border-border text-foreground px-3 py-2.5 rounded-lg text-[0.9rem] outline-none focus:border-primary transition-colors">
            <option>GitHub Copilot Device Flow</option>
            <option>OpenAI API</option>
            <option>Anthropic Claude</option>
            <option>Local Ollama</option>
          </select>
        </div>

        <Separator />

        {/* Feature Toggles */}
        <div className="space-y-2">
          <label className="text-[0.75rem] text-muted-foreground tracking-wide">
            功能设置
          </label>
          <div className="space-y-4 mt-3">
            <ToggleSwitch
              title="代码执行前确认"
              desc="执行脚本前弹窗确认"
              defaultChecked
            />
            <ToggleSwitch
              title="流式输出"
              desc="实时显示 AI 回复"
              defaultChecked
            />
            <ToggleSwitch
              title="后台任务持久化"
              desc="使用 Offscreen Document 保持定时任务"
              defaultChecked
            />
          </div>
        </div>
      </div>
    </div>
  );
}

function ToggleSwitch({
  title,
  desc,
  defaultChecked = false,
}: {
  title: string;
  desc: string;
  defaultChecked?: boolean;
}) {
  return (
    <label className="flex items-center justify-between cursor-pointer">
      <div className="space-y-0.5">
        <div className="text-[0.9rem]">{title}</div>
        <div className="text-[0.75rem] text-muted-foreground/60">{desc}</div>
      </div>
      <div className="relative">
        <input
          type="checkbox"
          defaultChecked={defaultChecked}
          className="peer sr-only"
        />
        <div className="w-11 h-6 bg-border rounded-full peer-checked:bg-primary transition-colors" />
        <div className="absolute top-0.5 left-0.5 w-5 h-5 bg-white rounded-full shadow-sm transition-transform peer-checked:translate-x-5" />
      </div>
    </label>
  );
}
