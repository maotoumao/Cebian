// fake-indexeddb 必须先于 lightning-fs 首次触碰 indexedDB 注入全局。
import 'fake-indexeddb/auto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { discardRecordingHars, saveRecordingHars } from './recording-har';
import { sessionStore } from './session-store';
import type { Attachment, RecordingAttachment } from '@/lib/agent/attachments';
import { vfs } from '@/lib/persistence/vfs';
import { randomId } from '@/lib/utils';

// 随机后缀可控：默认走真实实现，个别用例固定返回值来制造后缀相撞
vi.mock('@/lib/utils', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/utils')>();
  return { ...actual, randomId: vi.fn(actual.randomId) };
});

const decoder = new TextDecoder();
async function readText(path: string): Promise<string> {
  const raw = await vfs.readFile(path, 'utf8');
  return typeof raw === 'string' ? raw : decoder.decode(raw as Uint8Array);
}

/** 每个用例用自己的会话 id（lightning-fs 库名固定，靠不同工作目录隔离）。 */
const sid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

const recording = (overrides: Partial<RecordingAttachment> = {}): RecordingAttachment => ({
  type: 'recording',
  name: 'recording-20260101-120000-abcd.json',
  sizeBytes: 2,
  eventCount: 1,
  durationMs: 100,
  json: '{}',
  networkCount: 1,
  har: { name: 'recording-20260101-120000-abcd.har', json: '{\n  "log": {}\n}' },
  ...overrides,
});

afterEach(() => {
  vi.restoreAllMocks();
  // 用例中途失败时也把固定的随机后缀恢复成真实实现
  vi.mocked(randomId).mockReset();
});

describe('saveRecordingHars', () => {
  it('把 HAR 写进会话工作目录 recordings/，附件换成相对路径、不再携带 HAR 内容', async () => {
    const element = { type: 'element', selector: '#a', path: 'a', tagName: 'div', attributes: {} } as Attachment;
    const { attachments: out, written } = await saveRecordingHars(sid(1), [element, recording()]);
    expect(out[0]).toBe(element);
    const saved = out[1] as RecordingAttachment;
    expect(saved.har).toBeUndefined();
    expect(saved.harPath).toBe('recordings/recording-20260101-120000-abcd.har');
    expect(written).toEqual([`/workspaces/${sid(1)}/recordings/recording-20260101-120000-abcd.har`]);
    expect(await readText(written[0])).toBe('{\n  "log": {}\n}');
  });

  it('没有 HAR 的附件不写任何文件', async () => {
    const plain = recording({ har: undefined, networkCount: undefined });
    const { attachments: out, written } = await saveRecordingHars(sid(2), [plain]);
    expect(out).toEqual([plain]);
    expect(written).toEqual([]);
    expect(await vfs.exists(`/workspaces/${sid(2)}`)).toBe(false);
  });

  it('不信任传进来的 harPath / harFailed，只由这次写入决定', async () => {
    const forged = recording({ har: undefined, harPath: '../../home/user/.cebian/skills/x/SKILL.md', harFailed: true });
    const { attachments: [out], written } = await saveRecordingHars(sid(2), [forged]);
    expect(out).not.toHaveProperty('harPath');
    expect(out).not.toHaveProperty('harFailed');
    expect(written).toEqual([]);
  });

  it('文件名里的目录与特殊字符被清理，不会写出 recordings/ 之外', async () => {
    const { attachments: [out] } = await saveRecordingHars(sid(3), [recording({ har: { name: '../../evil name.har', json: '{}' } })]);
    expect((out as RecordingAttachment).harPath).toBe('recordings/evil_name.har');
    expect(await readText(`/workspaces/${sid(3)}/recordings/evil_name.har`)).toBe('{}');
  });

  it('同一份录制重复提交（含并发）各写各的文件，不互相覆盖', async () => {
    const first = await saveRecordingHars(sid(8), [recording()]);
    const [second, third] = await Promise.all([
      saveRecordingHars(sid(8), [recording({ har: { name: 'recording-20260101-120000-abcd.har', json: '"2"' } })]),
      saveRecordingHars(sid(8), [recording({ har: { name: 'recording-20260101-120000-abcd.har', json: '"3"' } })]),
    ]);
    const paths = [first, second, third].map((r) => r.written[0]);
    expect(new Set(paths).size).toBe(3);
    expect(await readText(paths[0])).toBe('{\n  "log": {}\n}');
    expect(await readText(paths[1])).toBe('"2"');
    expect(await readText(paths[2])).toBe('"3"');
    expect((second.attachments[0] as RecordingAttachment).harPath).toMatch(/^recordings\/recording-20260101-120000-abcd-[0-9a-f]{6}\.har$/);
  });

  it('随机后缀相撞时继续换名（先后与并发都不覆盖），撞到上限按写入失败处理', async () => {
    vi.mocked(randomId).mockReturnValueOnce('aaaaaa').mockReturnValueOnce('aaaaaa').mockReturnValueOnce('bbbbbb')
      .mockReturnValueOnce('aaaaaa').mockReturnValueOnce('bbbbbb').mockReturnValueOnce('cccccc');
    const har = (json: string) => recording({ har: { name: 'x.har', json } });
    const first = await saveRecordingHars(sid(10), [har('"1"')]);
    const second = await saveRecordingHars(sid(10), [har('"2"')]);
    // 第三次：原名已存在、aaaaaa 已存在，bbbbbb 与并发的第四次撞上占位
    const [third, fourth] = await Promise.all([saveRecordingHars(sid(10), [har('"3"')]), saveRecordingHars(sid(10), [har('"4"')])]);
    const names = [first, second, third, fourth].map((r) => r.written[0].split('/').pop());
    expect(new Set(names).size).toBe(4);
    expect(names.slice(0, 2)).toEqual(['x.har', 'x-aaaaaa.har']);
    for (const [r, json] of [[first, '"1"'], [second, '"2"'], [third, '"3"'], [fourth, '"4"']] as const) {
      expect(await readText(r.written[0])).toBe(json);
    }

    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.mocked(randomId).mockReturnValue('aaaaaa');
    const stuck = await saveRecordingHars(sid(10), [har('"5"')]);
    expect(stuck.written).toEqual([]);
    expect(stuck.attachments[0]).toMatchObject({ harFailed: true });
    expect(await readText(`/workspaces/${sid(10)}/recordings/x-aaaaaa.har`)).toBe('"2"');
  });

  it.each(['../home/user/.cebian', 'a/b', '', 'not-a-uuid'])('会话 id 不合法（%j）时不写文件，标记 harFailed', async (bad) => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const writeFile = vi.spyOn(vfs, 'writeFile');
    const { attachments: [saved], written } = await saveRecordingHars(bad, [recording()]);
    expect(writeFile).not.toHaveBeenCalled();
    expect(written).toEqual([]);
    expect(saved).toMatchObject({ harFailed: true });
    expect(saved).not.toHaveProperty('har');
    expect(saved).not.toHaveProperty('harPath');
  });

  it('写入失败时标记 harFailed，去掉 HAR 内容，不抛错', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(vfs, 'writeFile').mockRejectedValueOnce(new Error('quota'));
    const { attachments: [saved], written } = await saveRecordingHars(sid(4), [recording()]);
    expect(written).toEqual([]);
    expect(saved).toMatchObject({ harFailed: true });
    expect(saved).not.toHaveProperty('har');
    expect(saved).not.toHaveProperty('harPath');
  });
});

describe('discardRecordingHars', () => {
  const keepSession = () =>
    vi.spyOn(sessionStore, 'loadMeta').mockResolvedValue({ id: 'x' } as Awaited<ReturnType<typeof sessionStore.loadMeta>>);

  it('会话还在：只删掉这次写下的 HAR，工作目录里其它文件（含之前的 HAR）保留', async () => {
    keepSession();
    await vfs.writeFile(`/workspaces/${sid(5)}/notes.md`, 'keep');
    const earlier = await saveRecordingHars(sid(5), [recording()]);
    const { written } = await saveRecordingHars(sid(5), [recording()]);
    await discardRecordingHars(sid(5), written);
    expect(await vfs.exists(written[0])).toBe(false);
    expect(await vfs.exists(earlier.written[0])).toBe(true);
    expect(await readText(`/workspaces/${sid(5)}/notes.md`)).toBe('keep');
  });

  it('只删该会话 recordings/ 下的路径', async () => {
    keepSession();
    const keep = [
      `/workspaces/${sid(9)}/notes.md`,
      `/workspaces/${sid(9)}/recordings/sub/x.har`,
      `/workspaces/${sid(11)}/recordings/other.har`,
    ];
    for (const path of keep) await vfs.writeFile(path, 'keep');
    await discardRecordingHars(sid(9), keep);
    for (const path of keep) expect(await readText(path)).toBe('keep');
  });

  it('写入期间会话被删除：连同被写入重建的工作目录一起删掉', async () => {
    vi.spyOn(sessionStore, 'loadMeta').mockResolvedValue(undefined);
    const { written } = await saveRecordingHars(sid(6), [recording()]);
    await discardRecordingHars(sid(6), written);
    expect(await vfs.exists(`/workspaces/${sid(6)}`)).toBe(false);
  });

  it('这次没写下文件时什么都不做', async () => {
    const loadMeta = vi.spyOn(sessionStore, 'loadMeta');
    const rm = vi.spyOn(vfs, 'rm');
    await discardRecordingHars(sid(7), []);
    expect(loadMeta).not.toHaveBeenCalled();
    expect(rm).not.toHaveBeenCalled();
  });
});
