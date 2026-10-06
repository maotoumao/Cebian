/**
 * 移植自 @earendil-works/pi-agent-core@0.84.4 `src/harness/session/testing/types.ts`（MIT，许可证见同目录 LICENSE）。
 * vendor 原因、维护约定与偏离记录见 lib/shims/pi-harness/README.md。
 */
import type { SessionRepo } from '@/lib/shims/pi-harness/session/types';

/** A fresh backend instance owned by one conformance case. */
export interface SessionBackendFixture extends AsyncDisposable {
  readonly repository: SessionRepo;
}

/** Creates an isolated fixture for one conformance case. */
export type SessionBackendFixtureFactory = () => Promise<SessionBackendFixture>;

/** A runner-independent conformance case that can be registered with any test framework. */
export interface SessionBackendConformanceCase {
  readonly group: string;
  readonly name: string;
  run(): Promise<void>;
}
