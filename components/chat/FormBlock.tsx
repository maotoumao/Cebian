import { useState, useCallback } from 'react';
import { ClipboardList, Send } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Label } from '@/components/ui/label';
import type { PresentFormRequest, PresentFormField, PresentFormResponse } from '@/lib/tools/present-form';
import { t } from '@/lib/i18n';

// ─── Types ───

interface FormBlockProps {
  request: PresentFormRequest;
  answered: boolean;
  onResolve?: (response: PresentFormResponse) => void;
}

// ─── Field-level value type ───

type FieldValue = string | string[] | null;

// ─── Component ───

export function FormBlock({ request, answered, onResolve }: FormBlockProps) {
  // 防御：流式生成期间 args 可能尚未完整（fields 缺失 / 非数组 / 空），
  // 此时直接 fields.map() 会抛 TypeError 导致整个 React 树崩溃 → 黑屏。
  // 返回 null 等价于「还没准备好渲染」——关掉重开后 DB 里的消息已是完整对象，不会走这里。
  const safeFields = Array.isArray(request?.fields)
    ? request.fields.filter((f): f is PresentFormField =>
        !!f && typeof f === 'object' && typeof f.id === 'string' && typeof f.type === 'string'
      )
    : [];
  if (safeFields.length === 0) return null;

  const { title, description, submit_label } = request;
  const fields = safeFields;

  // ─── 初始化表单值 ───
  const [values, setValues] = useState<Record<string, FieldValue>>(() => {
    const init: Record<string, FieldValue> = {};
    for (const field of fields) {
      if (field.type === 'multi_select') {
        init[field.id] = [];
      } else {
        init[field.id] = null;
      }
    }
    return init;
  });

  // ─── 字段值更新 ───
  const setFieldValue = useCallback((fieldId: string, value: FieldValue) => {
    setValues(prev => ({ ...prev, [fieldId]: value }));
  }, []);

  // 单选 / 下拉
  const setSingleValue = useCallback((fieldId: string, value: string) => {
    setValues(prev => ({ ...prev, [fieldId]: value }));
  }, []);

  // 多选 toggle
  const toggleMultiSelect = useCallback((fieldId: string, value: string) => {
    setValues(prev => {
      const current = (prev[fieldId] as string[]) || [];
      const next = current.includes(value)
        ? current.filter(v => v !== value)
        : [...current, value];
      return { ...prev, [fieldId]: next };
    });
  }, []);

  // ─── 校验 ───
  const errors = validateForm(fields, values);
  const hasErrors = Object.values(errors).some(e => !!e);

  // ─── 提交 ───
  const handleSubmit = () => {
    if (hasErrors || !onResolve) return;
    onResolve({ values: pruneValues(fields, values) });
  };

  // ─── 渲染 ───
  return (
    <div className={`relative mt-3 p-3.5 border border-primary/20 bg-primary/5 rounded-lg ${answered ? 'opacity-60' : ''}`}>
      {/* 标题 */}
      <div className="flex items-start gap-2 text-primary font-medium text-[0.85rem] mb-3">
        <ClipboardList className="size-4.5 shrink-0 mt-0.5" />
        <div>
          <span className="whitespace-pre-wrap">{title}</span>
          {description && (
            <p className="text-[0.75rem] text-muted-foreground font-normal mt-0.5 whitespace-pre-wrap">
              {description}
            </p>
          )}
        </div>
      </div>

      {/* 字段列表 */}
      <div className="space-y-3.5">
        {fields.map(field => (
          <FormFieldWidget
            key={field.id}
            field={field}
            value={values[field.id] ?? null}
            error={errors[field.id]}
            disabled={!onResolve}
            onChange={setFieldValue}
            onSingleChange={setSingleValue}
            onMultiToggle={toggleMultiSelect}
          />
        ))}
      </div>

      {/* 提交按钮 */}
      {onResolve && (
        <div className="flex justify-end mt-4">
          <Button
            variant="default"
            size="sm"
            onClick={handleSubmit}
            disabled={hasErrors}
            className="gap-1.5"
          >
            <Send className="size-3" />
            {submit_label || t('chat.form.submit')}
          </Button>
        </div>
      )}
    </div>
  );
}

// ─── 单个字段组件 ───

interface FormFieldWidgetProps {
  field: PresentFormField;
  value: FieldValue;
  error?: string;
  disabled: boolean;
  onChange: (fieldId: string, value: FieldValue) => void;
  onSingleChange: (fieldId: string, value: string) => void;
  onMultiToggle: (fieldId: string, value: string) => void;
}

function FormFieldWidget({ field, value, error, disabled, onChange, onSingleChange, onMultiToggle }: FormFieldWidgetProps) {
  return (
    <div>
      <Label className="text-[0.8rem] font-medium mb-1.5 block">
        {field.label}
        {field.required && <span className="text-destructive ml-0.5">*</span>}
      </Label>

      {field.type === 'text' && (
        <Input
          value={typeof value === 'string' ? value : ''}
          placeholder={field.placeholder}
          disabled={disabled}
          onChange={e => onChange(field.id, e.target.value)}
          className="h-8 text-xs"
        />
      )}

      {field.type === 'textarea' && (
        <Textarea
          value={typeof value === 'string' ? value : ''}
          placeholder={field.placeholder}
          disabled={disabled}
          onChange={e => onChange(field.id, e.target.value)}
          rows={3}
          className="text-xs resize-y"
        />
      )}

      {field.type === 'single_select' && field.options && (
        <div className="space-y-1.5">
          {field.options.map(opt => (
            <label
              key={opt.value}
              className={`flex items-center gap-2 cursor-pointer rounded-md px-2 py-1.5 transition-colors ${
                disabled ? 'cursor-default' : 'hover:bg-accent/30'
              }`}
            >
              <input
                type="radio"
                name={`field-${field.id}`}
                value={opt.value}
                checked={value === opt.value}
                disabled={disabled}
                onChange={() => onSingleChange(field.id, opt.value)}
                className="size-3.5 accent-primary"
              />
              <div className="text-xs leading-tight">
                <span>{opt.label}</span>
                {opt.description && (
                  <span className="text-muted-foreground ml-1">— {opt.description}</span>
                )}
              </div>
            </label>
          ))}
        </div>
      )}

      {field.type === 'multi_select' && field.options && (
        <div className="space-y-1.5">
          {field.options.map(opt => {
            const arr = (value as string[]) || [];
            const checked = arr.includes(opt.value);
            return (
              <label
                key={opt.value}
                className={`flex items-center gap-2 cursor-pointer rounded-md px-2 py-1.5 transition-colors ${
                  disabled ? 'cursor-default' : 'hover:bg-accent/30'
                }`}
              >
                <input
                  type="checkbox"
                  checked={checked}
                  disabled={disabled}
                  onChange={() => onMultiToggle(field.id, opt.value)}
                  className="size-3.5 accent-primary rounded"
                />
                <div className="text-xs leading-tight">
                  <span>{opt.label}</span>
                  {opt.description && (
                    <span className="text-muted-foreground ml-1">— {opt.description}</span>
                  )}
                </div>
              </label>
            );
          })}
          {field.min_select != null && field.max_select != null && (
            <p className="text-[0.65rem] text-muted-foreground">
              {t('chat.form.selectRange', [String(field.min_select), String(field.max_select)])}
            </p>
          )}
        </div>
      )}

      {field.type === 'dropdown' && field.options && (
        <select
          value={typeof value === 'string' ? value : ''}
          disabled={disabled}
          onChange={e => onSingleChange(field.id, e.target.value)}
          className={`w-full h-8 rounded-md border border-input bg-background px-2.5 text-xs ${
            disabled ? 'opacity-50 cursor-default' : 'cursor-pointer'
          } focus:outline-none focus:ring-1 focus:ring-primary/30`}
        >
          <option value="">{field.placeholder || t('chat.form.selectPlaceholder')}</option>
          {field.options.map(opt => (
            <option key={opt.value} value={opt.value}>
              {opt.label}
            </option>
          ))}
        </select>
      )}

      {error && (
        <p className="text-[0.65rem] text-destructive mt-1">{error}</p>
      )}
    </div>
  );
}

// ─── 表单校验 ───

function validateForm(
  fields: PresentFormField[],
  values: Record<string, FieldValue>,
): Record<string, string> {
  const errors: Record<string, string> = {};
  for (const field of fields) {
    const val = values[field.id];
    // 必填校验
    if (field.required) {
      if (val == null || val === '' || (Array.isArray(val) && val.length === 0)) {
        errors[field.id] = t('chat.form.required');
        continue;
      }
    }
    // 选填字段跳过空值
    if (val == null || val === '' || (Array.isArray(val) && val.length === 0)) continue;

    // 多选数量校验
    if (field.type === 'multi_select' && Array.isArray(val)) {
      if (field.min_select != null && val.length < field.min_select) {
        errors[field.id] = t('chat.form.minSelect', [String(field.min_select)]);
      }
      if (field.max_select != null && val.length > field.max_select) {
        errors[field.id] = t('chat.form.maxSelect', [String(field.max_select)]);
      }
    }
  }
  return errors;
}

// ─── 清理返回值：去掉未填字段为 null ───

function pruneValues(
  fields: PresentFormField[],
  values: Record<string, FieldValue>,
): Record<string, string | string[] | null> {
  const result: Record<string, string | string[] | null> = {};
  for (const field of fields) {
    const val = values[field.id];
    if (val == null || val === '' || (Array.isArray(val) && val.length === 0)) {
      result[field.id] = null;
    } else {
      result[field.id] = val;
    }
  }
  return result;
}
