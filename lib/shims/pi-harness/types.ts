/**
 * 移植自 @earendil-works/pi-agent-core@0.84.4 `src/harness/types.ts`（MIT，许可证见同目录 LICENSE）。
 * vendor 原因、维护约定与偏离记录见 lib/shims/pi-harness/README.md。
 */

/** Result of a fallible operation. Expected failures are returned as `ok: false` instead of thrown. */
export type Result<TValue, TError> = { ok: true; value: TValue } | { ok: false; error: TError };

/** Create a successful {@link Result}. */
export function ok<TValue, TError>(value: TValue): Result<TValue, TError> {
  return { ok: true, value };
}

/** Create a failed {@link Result}. */
export function err<TValue, TError>(error: TError): Result<TValue, TError> {
  return { ok: false, error };
}

/** Stable compaction error codes returned by compaction helpers. */
export type CompactionErrorCode = 'aborted' | 'summarization_failed';

/** Error returned by compaction helpers. */
export class CompactionError extends Error {
  /** Backend-independent error code. */
  public code: CompactionErrorCode;

  constructor(code: CompactionErrorCode, message: string, cause?: Error) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = 'CompactionError';
    this.code = code;
  }
}
