import { Plus, Trash2 } from 'lucide-react';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { t } from '@/lib/i18n';

export type HeaderRow = { key: string; value: string };

/**
 * rows → Record：跳过空 key，用 Headers 归一化（大小写不敏感、后写覆盖）；全空返回
 * undefined，好让调用方决定「不带 headers 字段」
 */
export function headerRowsToRecord(rows: HeaderRow[]): Record<string, string> | undefined {
  if (rows.length === 0) return undefined;
  const h = new Headers();
  for (const row of rows) {
    const k = row.key.trim();
    if (!k) continue;
    try {
      h.set(k, row.value);
    } catch {
      // 非法 header 名/值（含空格、控制字符等）跳过，避免 Headers.set 抛错中断保存
      continue;
    }
  }
  const out: Record<string, string> = {};
  h.forEach((v, k) => { out[k] = v; });
  return Object.keys(out).length > 0 ? out : undefined;
}

/** Record → rows：编辑既有 headers 时把存储形态还原成可编辑的行 */
export function recordToHeaderRows(record?: Record<string, string>): HeaderRow[] {
  return record ? Object.entries(record).map(([key, value]) => ({ key, value })) : [];
}

interface HeadersEditorProps {
  rows: HeaderRow[];
  onChange: (rows: HeaderRow[]) => void;
}

/**
 * 通用 key/value 请求头编辑器（MCP server 与自定义 provider 共用）。只管「行」的增删改，
 * 聚合成 Record 交给 headerRowsToRecord；区块标题由调用方自行渲染
 */
export function HeadersEditor({ rows, onChange }: HeadersEditorProps) {
  return (
    <div className="space-y-1">
      {rows.length > 0 && (
        <div className="space-y-1">
          {rows.map((row, idx) => (
            <div key={idx} className="flex items-center gap-1">
              <Input
                value={row.key}
                onChange={(e) => onChange(rows.map((r, i) => (i === idx ? { ...r, key: e.target.value } : r)))}
                onKeyDown={(e) => { if (e.key === 'Enter') e.preventDefault(); }}
                placeholder={t('common.headers.keyPlaceholder')}
                aria-label={t('common.headers.keyPlaceholder')}
                className="h-8 text-sm font-mono flex-1"
              />
              <Input
                value={row.value}
                onChange={(e) => onChange(rows.map((r, i) => (i === idx ? { ...r, value: e.target.value } : r)))}
                onKeyDown={(e) => { if (e.key === 'Enter') e.preventDefault(); }}
                placeholder={t('common.headers.valuePlaceholder')}
                aria-label={t('common.headers.valuePlaceholder')}
                className="h-8 text-sm font-mono flex-1"
              />
              <Button
                type="button"
                variant="ghost"
                size="icon"
                className="size-7 shrink-0 text-muted-foreground hover:text-destructive"
                onClick={() => onChange(rows.filter((_, i) => i !== idx))}
                aria-label={t('common.headers.remove')}
              >
                <Trash2 className="size-3.5" />
              </Button>
            </div>
          ))}
        </div>
      )}
      <Button
        type="button"
        variant="outline"
        size="sm"
        className="w-full"
        onClick={() => onChange([...rows, { key: '', value: '' }])}
      >
        <Plus className="size-3.5" />
        {t('common.headers.add')}
      </Button>
    </div>
  );
}
