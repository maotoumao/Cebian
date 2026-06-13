import { describe, it, expect } from 'vitest';
import {
  sessionFileKey,
  sessionIdFromFileKey,
  SESSIONS_DIR,
} from '@/lib/backup/payload-format';

const UUID = '6f9619ff-8b86-d011-b42d-00cf4fc964ff';

describe('备份 payload-format — 会话文件 key', () => {
  it('sessionFileKey 生成 sessions/{id}.json', () => {
    expect(sessionFileKey(UUID)).toBe(`sessions/${UUID}.json`);
    expect(sessionFileKey(UUID).startsWith(SESSIONS_DIR)).toBe(true);
  });

  it('sessionIdFromFileKey 从合法会话文件提取 UUID', () => {
    expect(sessionIdFromFileKey(`sessions/${UUID}.json`)).toBe(UUID);
    expect(sessionIdFromFileKey(sessionFileKey(UUID))).toBe(UUID);
  });

  it('sessionIdFromFileKey 拒绝非会话 / 畸形 key', () => {
    expect(sessionIdFromFileKey('config.json')).toBeNull();
    expect(sessionIdFromFileKey('vfs/workspaces/s1/sessions/x.json')).toBeNull();
    expect(sessionIdFromFileKey('sessions/readme.txt')).toBeNull();
    expect(sessionIdFromFileKey('sessions/')).toBeNull();
    // 非 UUID 的 stem（即便在 sessions/ 下）被拒绝。
    expect(sessionIdFromFileKey('sessions/not-a-uuid.json')).toBeNull();
    // 嵌套段被拒绝。
    expect(sessionIdFromFileKey(`sessions/sub/${UUID}.json`)).toBeNull();
    expect(sessionIdFromFileKey('sessions/index.json')).toBeNull();
  });
});

