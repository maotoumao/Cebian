import { useState, useCallback, useMemo } from 'react';
import { ClipboardList, ChevronLeft, ChevronRight, Send, CheckCircle } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Label } from '@/components/ui/label';
import type { AskUserQuestion, AskUserAnswer, AskUserResponse } from '@/lib/tools/ask-user';
import { t } from '@/lib/i18n';

// ─── Types ───

interface WizardBlockProps {
  request: {
    title?: string;
    description?: string;
    submit_label?: string;
    pagination?: {
      type: 'wizard';
      show_progress?: boolean;
      allow_skip?: boolean;
      allow_review?: boolean;
    };
    questions: AskUserQuestion[];
  };
  answered: boolean;
  onResolve?: (response: AskUserResponse) => void;
}

// ─── Step grouping ───

interface WizardStep {
  index: number;     // 0-based
  number: number;    // 1-based display
  title: string;
  fields: AskUserQuestion[];
}

function groupSteps(questions: AskUserQuestion[]): WizardStep[] {
  const stepMap = new Map<number, AskUserQuestion[]>();
  for (const q of questions) {
    const step = q.step ?? 1;
    if (!stepMap.has(step)) stepMap.set(step, []);
    stepMap.get(step)!.push(q);
  }
  // Sort by step number, collect titles (use first field's step_title or default)
  const sorted = Array.from(stepMap.entries()).sort((a, b) => a[0] - b[0]);
  return sorted.map(([stepNum, fields], idx) => {
    const firstTitle = fields.find(f => f.step_title)?.step_title;
    return {
      index: idx,
      number: stepNum,
      title: firstTitle || `${t('chat.wizard.step')} ${stepNum}`,
      fields,
    };
  });
}

// ─── Field value type ───

type FieldValue = string | string[] | null;

// ─── Component ───

export function WizardBlock({ request, answered, onResolve }: WizardBlockProps) {
  const { title, description, submit_label, pagination } = request;
  const questions = request.questions;
  const showProgress = pagination?.show_progress !== false;
  const allowSkip = pagination?.allow_skip === true;
  const allowReview = pagination?.allow_review !== false;

  // Group into steps
  const steps = useMemo(() => groupSteps(questions), [questions]);

  // Add review step if enabled
  const allSteps: (WizardStep | 'review')[] = useMemo(
    () => (allowReview ? [...steps, 'review' as const] : steps),
    [steps, allowReview],
  );

  const [currentStepIndex, setCurrentStepIndex] = useState(0);
  const [values, setValues] = useState<Record<string, FieldValue>>(() => {
    const init: Record<string, FieldValue> = {};
    for (const q of questions) {
      const isMulti = q.type === 'multi_select' || q.multiple;
      init[q.id] = isMulti ? [] : null;
    }
    return init;
  });

  const setFieldValue = useCallback((id: string, val: FieldValue) => {
    setValues(prev => ({ ...prev, [id]: val }));
  }, []);

  const toggleMultiSelect = useCallback((id: string, val: string) => {
    setValues(prev => {
      const cur = (prev[id] as string[]) || [];
      const next = cur.includes(val) ? cur.filter(v => v !== val) : [...cur, val];
      return { ...prev, [id]: next };
    });
  }, []);

  const isReviewStep = allSteps[currentStepIndex] === 'review';
  const currentStep = allSteps[currentStepIndex];
  const currentFields = isReviewStep ? [] : (currentStep as WizardStep).fields;

  // Validate current step
  const stepErrors = useMemo(() => {
    const errs: Record<string, string> = {};
    for (const field of currentFields) {
      const val = values[field.id];
      if (field.required) {
        if (val == null || val === '' || (Array.isArray(val) && val.length === 0)) {
          errs[field.id] = t('chat.form.required');
          continue;
        }
      }
      if (val == null || val === '' || (Array.isArray(val) && val.length === 0)) continue;
      const isMulti = field.type === 'multi_select' || field.multiple;
      if (isMulti && Array.isArray(val)) {
        if (field.min_select != null && val.length < field.min_select) {
          errs[field.id] = t('chat.form.minSelect', [String(field.min_select)]);
        }
        if (field.max_select != null && val.length > field.max_select) {
          errs[field.id] = t('chat.form.maxSelect', [String(field.max_select)]);
        }
      }
    }
    return errs;
  }, [currentFields, values]);

  const hasErrors = Object.values(stepErrors).some(e => !!e);
  const isFirstStep = currentStepIndex === 0;
  const isLastStep = currentStepIndex === allSteps.length - 1;

  const canAdvance = isReviewStep || (allowSkip && currentFields.every(f => !f.required)) || (!hasErrors && currentFields.length > 0);

  const handleNext = () => {
    if (isLastStep) {
      handleSubmit();
    } else {
      setCurrentStepIndex(prev => prev + 1);
    }
  };

  const handlePrev = () => {
    if (!isFirstStep) {
      setCurrentStepIndex(prev => prev - 1);
    }
  };

  const handleStepClick = (idx: number) => {
    // Allow clicking back to any completed step or the next uncompleted one
    if (idx <= currentStepIndex) {
      setCurrentStepIndex(idx);
    }
  };

  const handleSubmit = () => {
    if (!onResolve) return;
    const answers: Record<string, AskUserAnswer> = {};
    for (const q of questions) {
      const val = values[q.id];
      if (val == null || val === '' || (Array.isArray(val) && val.length === 0)) {
        answers[q.id] = { value: null };
      } else {
        answers[q.id] = { value: val };
      }
    }
    onResolve({ answers });
  };

  if (answered) {
    return (
      <div className="relative mt-3 p-3.5 border border-primary/20 bg-primary/5 rounded-lg opacity-60">
        <div className="flex items-start gap-2 text-primary font-medium text-[0.85rem]">
          <CheckCircle className="size-4.5 shrink-0 mt-0.5" />
          <span>{title || t('chat.form.title')}</span>
        </div>
      </div>
    );
  }

  return (
    <div className="relative mt-3 p-3.5 border border-primary/20 bg-primary/5 rounded-lg">
      {/* Header */}
      <div className="flex items-start gap-2 text-primary font-medium text-[0.85rem] mb-3">
        <ClipboardList className="size-4.5 shrink-0 mt-0.5" />
        <div className="flex-1">
          <span className="whitespace-pre-wrap">{title || t('chat.form.title')}</span>
          {description && (
            <p className="text-[0.75rem] text-muted-foreground font-normal mt-0.5 whitespace-pre-wrap">
              {description}
            </p>
          )}
        </div>
        {/* Step counter */}
        <span className="text-[0.7rem] text-muted-foreground shrink-0 mt-0.5">
          {t('chat.wizard.stepOf', [String(currentStepIndex + 1), String(allSteps.length)])}
        </span>
      </div>

      {/* Progress indicator */}
      {showProgress && allSteps.length > 1 && (
        <div className="flex items-center gap-1 mb-3">
          {allSteps.map((step, idx) => {
            const isReview = step === 'review';
            const stepData = isReview ? null : step as WizardStep;
            const isActive = idx === currentStepIndex;
            const isDone = idx < currentStepIndex;

            return (
              <div key={idx} className="flex items-center gap-1 flex-1 min-w-0">
                {/* Connector before (except first) */}
                {idx > 0 && (
                  <div className={`h-0.5 flex-1 rounded-full ${isDone ? 'bg-primary' : 'bg-border'}`} />
                )}
                {/* Step dot + label */}
                <button
                  type="button"
                  disabled={idx > currentStepIndex}
                  onClick={() => handleStepClick(idx)}
                  className={`flex items-center gap-1 px-1.5 py-0.5 rounded text-[0.65rem] font-medium transition-colors shrink-0 ${
                    isActive
                      ? 'bg-primary text-primary-foreground'
                      : isDone
                        ? 'text-primary cursor-pointer hover:bg-primary/10'
                        : 'text-muted-foreground cursor-default'
                  }`}
                >
                  {isDone ? (
                    <CheckCircle className="size-3" />
                  ) : (
                    <span className="size-3 rounded-full border border-current flex items-center justify-center text-[0.5rem] leading-none">
                      {isReview ? 'R' : (stepData?.number ?? idx + 1)}
                    </span>
                  )}
                  <span className="truncate max-w-[60px]">
                    {isReview ? t('chat.wizard.review') : (stepData?.title ?? '')}
                  </span>
                </button>
                {/* Connector after (except last) */}
                {idx < allSteps.length - 1 && (
                  <div className={`h-0.5 flex-1 rounded-full ${isDone ? 'bg-primary' : 'bg-border'}`} />
                )}
              </div>
            );
          })}
        </div>
      )}

      {/* Current step title */}
      {!isReviewStep && currentStep && (
        <p className="text-[0.8rem] font-medium text-foreground mb-3">
          {(currentStep as WizardStep).title}
        </p>
      )}

      {/* Review step */}
      {isReviewStep && (
        <div className="space-y-2 mb-3">
          <p className="text-[0.8rem] font-medium text-foreground">{t('chat.wizard.review')}</p>
          <p className="text-[0.7rem] text-muted-foreground mb-2">{t('chat.wizard.reviewDesc')}</p>
          {steps.map(step => (
            <div key={step.number} className="rounded border border-border p-2.5">
              <p className="text-[0.7rem] font-medium text-muted-foreground mb-1.5">{step.title}</p>
              {step.fields.map(field => {
                const val = values[field.id];
                const display = val == null || val === '' || (Array.isArray(val) && val.length === 0)
                  ? <span className="text-muted-foreground italic">{t('chat.wizard.notFilled')}</span>
                  : Array.isArray(val)
                    ? val.join(', ')
                    : String(val);
                return (
                  <div key={field.id} className="flex gap-2 text-[0.75rem] py-0.5">
                    <span className="text-muted-foreground shrink-0">{field.question}:</span>
                    <span className="text-foreground">{display}</span>
                  </div>
                );
              })}
            </div>
          ))}
        </div>
      )}

      {/* Fields for current step */}
      {!isReviewStep && currentFields.length > 0 && (
        <div className="space-y-3.5 mb-3">
          {currentFields.map(field => (
            <WizardFieldWidget
              key={field.id}
              field={field}
              value={values[field.id]}
              error={stepErrors[field.id]}
              disabled={!onResolve}
              onChange={val => setFieldValue(field.id, val)}
              onToggleMulti={val => toggleMultiSelect(field.id, val)}
            />
          ))}
        </div>
      )}

      {/* Navigation */}
      {onResolve && (
        <div className="flex justify-between items-center mt-3 pt-3 border-t border-border/50">
          <div>
            {!isFirstStep && (
              <Button variant="ghost" size="sm" onClick={handlePrev}>
                <ChevronLeft className="size-3.5 mr-1" />
                {t('chat.wizard.prev')}
              </Button>
            )}
          </div>
          <div className="flex items-center gap-2">
            {allowSkip && !isReviewStep && !isLastStep && (
              <Button variant="ghost" size="sm" onClick={handleNext}>
                {t('chat.wizard.skip')}
              </Button>
            )}
            <Button size="sm" disabled={!canAdvance && !isReviewStep} onClick={handleNext}>
              {isLastStep ? (
                <>
                  <Send className="size-3.5 mr-1.5" />
                  {submit_label || t('chat.form.submit')}
                </>
              ) : (
                <>
                  {t('chat.wizard.next')}
                  <ChevronRight className="size-3.5 ml-1" />
                </>
              )}
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}

// ─── Field widget (same as FormBlock's FormFieldWidget) ───

function WizardFieldWidget({
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

      {/* Text */}
      {type === 'text' && (
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
