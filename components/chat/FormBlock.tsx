import { useState, useCallback } from 'react';
import { ClipboardList, Send } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Label } from '@/components/ui/label';
import type { AskUserQuestion, AskUserAnswer, AskUserResponse } from '@/lib/tools/ask-user';
import { t } from '@/lib/i18n';

// ─── Types ───

interface FormBlockProps {
  request: {
    title?: string;
    description?: string;
    submit_label?: string;
    questions: AskUserQuestion[];
  };
  answered: boolean;
  onResolve?: (response: AskUserResponse) => void;
}

// ─── Field-level value type ───

type FieldValue = string | string[] | null;

// ─── Component ───

export function FormBlock({ request, answered, onResolve }: FormBlockProps) {
  const safeFields = Array.isArray(request?.questions)
    ? request.questions.filter((f): f is AskUserQuestion =>
        !!f && typeof f === 'object' && typeof f.id === 'string' && typeof f.question === 'string'
      )
    : [];
  if (safeFields.length === 0) return null;

  const { title, description, submit_label } = request;
  const fields = safeFields;

  const [values, setValues] = useState<Record<string, FieldValue>>(() => {
    const init: Record<string, FieldValue> = {};
    for (const field of fields) {
      if (field.type === 'multi_select' || field.multiple) {
        init[field.id] = [];
      } else {
        init[field.id] = null;
      }
    }
    return init;
  });

  const setFieldValue = useCallback((fieldId: string, value: FieldValue) => {
    setValues(prev => ({ ...prev, [fieldId]: value }));
  }, []);

  const toggleMultiSelect = useCallback((fieldId: string, value: string) => {
    setValues(prev => {
      const current = (prev[fieldId] as string[]) || [];
      const next = current.includes(value)
        ? current.filter(v => v !== value)
        : [...current, value];
      return { ...prev, [fieldId]: next };
    });
  }, []);

  const errors = validateForm(fields, values);
  const hasErrors = Object.values(errors).some(e => !!e);

  const handleSubmit = () => {
    if (hasErrors || !onResolve) return;
    const answers: Record<string, AskUserAnswer> = {};
    for (const field of fields) {
      const val = values[field.id];
      if (val == null || val === '' || (Array.isArray(val) && val.length === 0)) {
        answers[field.id] = { value: null };
      } else {
        answers[field.id] = { value: val };
      }
    }
    onResolve({ answers });
  };

  return (
    <div className={`relative mt-3 p-3.5 border border-primary/20 bg-primary/5 rounded-lg ${answered ? 'opacity-60' : ''}`}>
      <div className="flex items-start gap-2 text-primary font-medium text-[0.85rem] mb-3">
        <ClipboardList className="size-4.5 shrink-0 mt-0.5" />
        <div>
          <span className="whitespace-pre-wrap">{title || t('chat.form.title')}</span>
          {description && (
            <p className="text-[0.75rem] text-muted-foreground font-normal mt-0.5 whitespace-pre-wrap">
              {description}
            </p>
          )}
        </div>
      </div>

      <div className="space-y-3.5">
        {fields.map(field => (
          <FormFieldWidget
            key={field.id}
            field={field}
            value={values[field.id]}
            error={errors[field.id]}
            disabled={answered || !onResolve}
            onChange={val => setFieldValue(field.id, val)}
            onToggleMulti={val => toggleMultiSelect(field.id, val)}
          />
        ))}
      </div>

      {onResolve && !answered && (
        <div className="flex justify-end mt-4">
          <Button
            size="sm"
            disabled={hasErrors}
            onClick={handleSubmit}
          >
            <Send className="size-3.5 mr-1.5" />
            {submit_label || t('chat.form.submit')}
          </Button>
        </div>
      )}
    </div>
  );
}

// ─── Field widget ───

function FormFieldWidget({
  field,
  value,
  error,
  disabled,
  onChange,
  onToggleMulti,
}: {
  field: AskUserQuestion;
  value: FieldValue;
  error?: string;
  disabled: boolean;
  onChange: (val: FieldValue) => void;
  onToggleMulti: (val: string) => void;
}) {
  const type = field.type ?? 'text';
  const isMulti = type === 'multi_select' || field.multiple;
  const options = field.options?.filter(
    (o): o is NonNullable<typeof field.options>[number] => !!o && typeof o.label === 'string'
  ) ?? [];

  return (
    <div className="space-y-1.5">
      <Label className="text-xs font-medium flex items-center gap-1">
        {field.question}
        {field.required && <span className="text-destructive">*</span>}
      </Label>
      {field.message && (
        <p className="text-[0.65rem] text-muted-foreground whitespace-pre-wrap">{field.message}</p>
      )}

      {/* Text input */}
      {(type === 'text') && (
        <Input
          value={(value as string) ?? ''}
          placeholder={field.placeholder ?? ''}
          disabled={disabled}
          onChange={e => onChange(e.target.value)}
          className="h-8 text-xs"
        />
      )}

      {/* Textarea */}
      {type === 'textarea' && (
        <Textarea
          value={(value as string) ?? ''}
          placeholder={field.placeholder ?? ''}
          disabled={disabled}
          rows={3}
          onChange={e => onChange(e.target.value)}
          className="text-xs resize-y"
        />
      )}

      {/* Dropdown */}
      {type === 'dropdown' && (
        <select
          value={(value as string) ?? ''}
          disabled={disabled}
          onChange={e => onChange(e.target.value)}
          className="w-full h-8 rounded-md border border-input bg-background px-2.5 text-xs focus:outline-none focus:ring-1 focus:ring-primary/30"
        >
          <option value="">{field.placeholder || t('chat.form.selectPlaceholder')}</option>
          {options.map(opt => (
            <option key={opt.value} value={opt.value}>
              {opt.label}
            </option>
          ))}
        </select>
      )}

      {/* Single select (radio) */}
      {type === 'single_select' && (
        <div className="space-y-1.5">
          {options.map(opt => (
            <label
              key={opt.value}
              className={`flex items-center gap-2 px-2.5 py-1.5 rounded-md border cursor-pointer text-xs transition-colors ${
                disabled ? 'opacity-60 cursor-default' : 'hover:bg-accent/50'
              } ${
                value === opt.value ? 'border-primary bg-primary/10' : 'border-border'
              }`}
            >
              <input
                type="radio"
                name={field.id}
                value={opt.value}
                checked={value === opt.value}
                disabled={disabled}
                onChange={e => onChange(e.target.value)}
                className="size-3.5 accent-primary"
              />
              <span className="flex-1">{opt.label}</span>
              {opt.recommended && (
                <span className="text-[0.6rem] text-primary/70 font-medium px-1 py-0.5 rounded bg-primary/10">
                  {t('chat.form.recommended')}
                </span>
              )}
            </label>
          ))}
        </div>
      )}

      {/* Multi select (checkbox) */}
      {isMulti && options.length > 0 && (
        <div className="space-y-1.5">
          <div className="space-y-1">
            {options.map(opt => (
              <label
                key={opt.value}
                className={`flex items-center gap-2 px-2.5 py-1.5 rounded-md border cursor-pointer text-xs transition-colors ${
                  disabled ? 'opacity-60 cursor-default' : 'hover:bg-accent/50'
                } ${
                  Array.isArray(value) && value.includes(opt.value) ? 'border-primary bg-primary/10' : 'border-border'
                }`}
              >
                <input
                  type="checkbox"
                  value={opt.value}
                  checked={Array.isArray(value) && value.includes(opt.value)}
                  disabled={disabled}
                  onChange={() => onToggleMulti(opt.value)}
                  className="size-3.5 accent-primary rounded"
                />
                <span className="flex-1">{opt.label}</span>
                {opt.recommended && (
                  <span className="text-[0.6rem] text-primary/70 font-medium px-1 py-0.5 rounded bg-primary/10">
                    {t('chat.form.recommended')}
                  </span>
                )}
              </label>
            ))}
          </div>
          {(field.min_select || field.max_select) && (
            <p className="text-[0.65rem] text-muted-foreground">
              {field.min_select && field.max_select
                ? t('chat.form.selectRange', [String(field.min_select), String(field.max_select)])
                : field.min_select
                  ? t('chat.form.minSelect', [String(field.min_select)])
                  : field.max_select
                    ? t('chat.form.maxSelect', [String(field.max_select)])
                    : null}
            </p>
          )}
        </div>
      )}

      {error && (
        <p className="text-[0.65rem] text-destructive mt-1">{error}</p>
      )}
    </div>
  );
}

// ─── Validation ───

function validateForm(
  fields: AskUserQuestion[],
  values: Record<string, FieldValue>,
): Record<string, string> {
  const errors: Record<string, string> = {};
  for (const field of fields) {
    const val = values[field.id];
    if (field.required) {
      if (val == null || val === '' || (Array.isArray(val) && val.length === 0)) {
        errors[field.id] = t('chat.form.required');
        continue;
      }
    }
    if (val == null || val === '' || (Array.isArray(val) && val.length === 0)) continue;

    const isMulti = field.type === 'multi_select' || field.multiple;
    if (isMulti && Array.isArray(val)) {
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
