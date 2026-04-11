import { Clock, Plus } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { ScrollArea } from '@/components/ui/scroll-area';

export function TasksPage() {
  return (
    <ScrollArea className="flex-1">
      <div className="flex flex-col items-center justify-center gap-4 p-8 pt-20 text-center">
        <div className="w-12 h-12 rounded-full bg-muted grid place-items-center">
          <Clock className="size-6 text-muted-foreground" />
        </div>
        <div className="space-y-1">
          <h2 className="text-lg font-semibold">定时任务</h2>
          <p className="text-sm text-muted-foreground max-w-[260px]">
            创建定时任务、RPA 自动化流程，支持抢票、秒杀等场景。
          </p>
        </div>
        <Button variant="outline" size="sm" className="gap-1.5 mt-2">
          <Plus className="size-4" />
          创建任务
        </Button>
      </div>
    </ScrollArea>
  );
}
