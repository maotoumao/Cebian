import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fakeBrowser } from 'wxt/testing/fake-browser';
import {
  BACKUP_APPLY_ABORT,
  BACKUP_APPLY_CHUNK,
  BACKUP_APPLY_COMMIT,
  type BackupResponse,
} from '@/lib/backup/sources/sessions';
import { registerBackupHandler } from './backup-handler';

type MessageListener = (
  message: unknown,
  sender: chrome.runtime.MessageSender,
  sendResponse: (response: unknown) => void,
) => boolean | undefined;

const mocks = vi.hoisted(() => ({
  applyAll: vi.fn(),
  flushAll: vi.fn(),
  acquireKeepAlive: vi.fn(),
  releaseKeepAlive: vi.fn(),
}));

vi.mock('./session-store', () => ({
  sessionStore: {
    applyAll: mocks.applyAll,
    flushAll: mocks.flushAll,
  },
}));

vi.mock('../lifecycle/keepalive', () => ({
  acquireKeepAlive: mocks.acquireKeepAlive,
  releaseKeepAlive: mocks.releaseKeepAlive,
}));

const SESSION = {
  id: '11111111-1111-4111-8111-111111111111',
  createdAt: 1,
  updatedAt: 2,
  messages: [],
};

let listener: MessageListener;

function send<T>(message: object): Promise<BackupResponse<T>> {
  return new Promise((resolve) => {
    listener(message, { id: chrome.runtime.id }, (response) => {
      resolve(response as BackupResponse<T>);
    });
  });
}

describe('registerBackupHandler keepalive', () => {
  beforeEach(() => {
    fakeBrowser.reset();
    vi.restoreAllMocks();
    vi.clearAllMocks();
    mocks.applyAll.mockResolvedValue({ written: 0, skipped: 0, cleared: false });
    vi.spyOn(chrome.runtime.onMessage, 'addListener').mockImplementation((registered) => {
      listener = registered as MessageListener;
    });
    registerBackupHandler();
  });

  it('空恢复的 commit 独立保活，并在事务完成后释放', async () => {
    const response = await send({
      type: BACKUP_APPLY_COMMIT,
      nonce: 'empty',
      expectedCount: 0,
      strategy: 'replace',
    });

    expect(response.ok).toBe(true);
    expect(mocks.applyAll).toHaveBeenCalledWith([], 'replace');
    expect(mocks.acquireKeepAlive).toHaveBeenCalledTimes(1);
    expect(mocks.releaseKeepAlive).toHaveBeenCalledTimes(1);
  });

  it('空恢复完成后拒绝同 nonce 的 commit 与 chunk 重放', async () => {
    const message = {
      type: BACKUP_APPLY_COMMIT,
      nonce: 'empty-replay',
      expectedCount: 0,
      strategy: 'replace',
    };

    expect((await send(message)).ok).toBe(true);
    expect(await send(message)).toEqual({
      ok: false,
      error: 'applyCommit: nonce has already been consumed',
    });
    expect(await send({
      type: BACKUP_APPLY_CHUNK,
      nonce: 'empty-replay',
      records: [SESSION],
    })).toEqual({
      ok: false,
      error: 'applyChunk: nonce has already been consumed',
    });
    expect(mocks.applyAll).toHaveBeenCalledTimes(1);
    expect(mocks.acquireKeepAlive).toHaveBeenCalledTimes(1);
    expect(mocks.releaseKeepAlive).toHaveBeenCalledTimes(1);
  });

  it('分块缓冲与 commit 各持有一个 token，并在 commit 后全部释放', async () => {
    await send({
      type: BACKUP_APPLY_CHUNK,
      nonce: 'complete',
      records: [SESSION],
    });

    expect(mocks.acquireKeepAlive).toHaveBeenCalledTimes(1);
    expect(mocks.releaseKeepAlive).not.toHaveBeenCalled();

    const response = await send({
      type: BACKUP_APPLY_COMMIT,
      nonce: 'complete',
      expectedCount: 1,
      strategy: 'merge',
    });

    expect(response.ok).toBe(true);
    expect(mocks.applyAll).toHaveBeenCalledWith([expect.objectContaining({ id: SESSION.id })], 'merge');
    expect(mocks.acquireKeepAlive).toHaveBeenCalledTimes(2);
    expect(mocks.releaseKeepAlive).toHaveBeenCalledTimes(2);
  });

  it('事务失败时仍释放缓冲与 commit 的两个 token', async () => {
    mocks.applyAll.mockRejectedValueOnce(new Error('transaction failed'));
    await send({
      type: BACKUP_APPLY_CHUNK,
      nonce: 'failed',
      records: [SESSION],
    });

    const response = await send({
      type: BACKUP_APPLY_COMMIT,
      nonce: 'failed',
      expectedCount: 1,
      strategy: 'replace',
    });

    expect(response).toEqual({ ok: false, error: 'transaction failed' });
    expect(mocks.acquireKeepAlive).toHaveBeenCalledTimes(2);
    expect(mocks.releaseKeepAlive).toHaveBeenCalledTimes(2);
  });

  it('commit 持有缓冲所有权期间拒绝同 nonce 的新 chunk', async () => {
    let finishTransaction!: (value: { written: number; skipped: number; cleared: boolean }) => void;
    mocks.applyAll.mockReturnValueOnce(new Promise((resolve) => {
      finishTransaction = resolve;
    }));
    await send({
      type: BACKUP_APPLY_CHUNK,
      nonce: 'committing',
      records: [SESSION],
    });

    const commit = send({
      type: BACKUP_APPLY_COMMIT,
      nonce: 'committing',
      expectedCount: 1,
      strategy: 'merge',
    });
    await vi.waitFor(() => expect(mocks.applyAll).toHaveBeenCalledTimes(1));

    const chunk = await send({
      type: BACKUP_APPLY_CHUNK,
      nonce: 'committing',
      records: [SESSION],
    });
    expect(chunk).toEqual({ ok: false, error: 'applyChunk: nonce is already committing' });
    expect(mocks.acquireKeepAlive).toHaveBeenCalledTimes(2);
    expect(mocks.releaseKeepAlive).not.toHaveBeenCalled();

    finishTransaction({ written: 1, skipped: 0, cleared: false });
    expect((await commit).ok).toBe(true);
    expect(mocks.releaseKeepAlive).toHaveBeenCalledTimes(2);
  });

  it('commit 持有缓冲所有权期间拒绝同 nonce 的重复 commit', async () => {
    let finishTransaction!: (value: { written: number; skipped: number; cleared: boolean }) => void;
    mocks.applyAll.mockReturnValueOnce(new Promise((resolve) => {
      finishTransaction = resolve;
    }));
    await send({
      type: BACKUP_APPLY_CHUNK,
      nonce: 'double-commit',
      records: [SESSION],
    });

    const firstCommit = send({
      type: BACKUP_APPLY_COMMIT,
      nonce: 'double-commit',
      expectedCount: 1,
      strategy: 'merge',
    });
    await vi.waitFor(() => expect(mocks.applyAll).toHaveBeenCalledTimes(1));

    const secondCommit = await send({
      type: BACKUP_APPLY_COMMIT,
      nonce: 'double-commit',
      expectedCount: 1,
      strategy: 'merge',
    });
    expect(secondCommit).toEqual({ ok: false, error: 'applyCommit: nonce is already committing' });
    expect(mocks.acquireKeepAlive).toHaveBeenCalledTimes(2);
    expect(mocks.releaseKeepAlive).not.toHaveBeenCalled();

    finishTransaction({ written: 1, skipped: 0, cleared: false });
    expect((await firstCommit).ok).toBe(true);
    expect(mocks.releaseKeepAlive).toHaveBeenCalledTimes(2);
  });

  it('commit 取走缓冲后旧 TTL 不会在事务期间提前释放 token', async () => {
    vi.useFakeTimers();
    try {
      let finishTransaction!: (value: { written: number; skipped: number; cleared: boolean }) => void;
      mocks.applyAll.mockReturnValueOnce(new Promise((resolve) => {
        finishTransaction = resolve;
      }));
      await send({
        type: BACKUP_APPLY_CHUNK,
        nonce: 'timer-ownership',
        records: [SESSION],
      });

      const commit = send({
        type: BACKUP_APPLY_COMMIT,
        nonce: 'timer-ownership',
        expectedCount: 1,
        strategy: 'merge',
      });
      expect(mocks.applyAll).toHaveBeenCalledTimes(1);

      await vi.advanceTimersByTimeAsync(60_000);
      expect(mocks.releaseKeepAlive).not.toHaveBeenCalled();

      finishTransaction({ written: 1, skipped: 0, cleared: false });
      expect((await commit).ok).toBe(true);
      expect(mocks.releaseKeepAlive).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('超过 256 次后仍拒绝最早已消费 nonce 的 commit 重放', async () => {
    const commit = (nonce: string) => send({
      type: BACKUP_APPLY_COMMIT,
      nonce,
      expectedCount: 0,
      strategy: 'replace',
    });

    expect((await commit('replay-lifetime-0')).ok).toBe(true);
    for (let i = 1; i <= 256; i += 1) {
      expect((await commit(`replay-lifetime-${i}`)).ok).toBe(true);
    }

    expect(await commit('replay-lifetime-0')).toEqual({
      ok: false,
      error: 'applyCommit: nonce has already been consumed',
    });
  });

  it.each([
    {
      nonce: 'invalid-strategy',
      expectedCount: 1,
      strategy: 'invalid',
      error: 'applyCommit: invalid strategy invalid',
    },
    {
      nonce: 'count-mismatch',
      expectedCount: 2,
      strategy: 'merge',
      error: 'applyCommit: expected 2 records but buffered 1',
    },
  ])('$nonce 校验失败后释放缓冲与 commit 的两个 token', async ({ nonce, expectedCount, strategy, error }) => {
    await send({
      type: BACKUP_APPLY_CHUNK,
      nonce,
      records: [SESSION],
    });

    const response = await send({
      type: BACKUP_APPLY_COMMIT,
      nonce,
      expectedCount,
      strategy,
    });

    expect(response).toEqual({ ok: false, error });
    expect(mocks.applyAll).not.toHaveBeenCalled();
    expect(mocks.acquireKeepAlive).toHaveBeenCalledTimes(2);
    expect(mocks.releaseKeepAlive).toHaveBeenCalledTimes(2);
  });

  it('abort 通过 dropBuffer 释放缓冲 token', async () => {
    await send({
      type: BACKUP_APPLY_CHUNK,
      nonce: 'aborted',
      records: [SESSION],
    });
    await send({ type: BACKUP_APPLY_ABORT, nonce: 'aborted' });

    expect(mocks.acquireKeepAlive).toHaveBeenCalledTimes(1);
    expect(mocks.releaseKeepAlive).toHaveBeenCalledTimes(1);
    expect(mocks.applyAll).not.toHaveBeenCalled();
  });

  it('TTL 到期时通过 dropBuffer 释放孤儿缓冲 token', async () => {
    vi.useFakeTimers();
    try {
      await send({
        type: BACKUP_APPLY_CHUNK,
        nonce: 'expired',
        records: [SESSION],
      });

      expect(mocks.releaseKeepAlive).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(60_000);
      expect(mocks.releaseKeepAlive).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('后续 chunk 刷新 TTL，旧截止点不会提前释放', async () => {
    vi.useFakeTimers();
    try {
      await send({
        type: BACKUP_APPLY_CHUNK,
        nonce: 'refreshed',
        records: [SESSION],
      });
      await vi.advanceTimersByTimeAsync(59_000);
      await send({
        type: BACKUP_APPLY_CHUNK,
        nonce: 'refreshed',
        records: [SESSION],
      });

      await vi.advanceTimersByTimeAsync(1_000);
      expect(mocks.releaseKeepAlive).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(59_000);
      expect(mocks.acquireKeepAlive).toHaveBeenCalledTimes(1);
      expect(mocks.releaseKeepAlive).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });
});