import { describe, expect, it } from 'vitest';
import { classifyFile, codeLanguageOf, dualViewTypeOf, sessionUuidOf, workspaceUuidOf } from '@/entrypoints/vfs/lib/path-utils';
import type { FileMedia } from '@/entrypoints/vfs/types';

const UUID = '3f2a9c1e-7b4d-4e8a-9f0c-1a2b3c4d5e6f';

describe('classifyFile', () => {
  it.each([
    ['report.md', 'markdown'],
    ['README.markdown', 'markdown'],
    ['classify.ts', 'code'],
    ['index.html', 'html'],
    ['page.HTM', 'html'],
    ['config.YAML', 'code'],
    ['chart.svg', 'svg'],
    ['feed.xml', 'code'],
    ['photo.PNG', 'image'],
    ['clip.mp4', 'video'],
    ['voice.m4a', 'audio'],
    ['paper.pdf', 'pdf'],
    ['bundle.zip', 'binary'],
    ['notes.txt', 'text'],
    ['data.csv', 'text'],
    ['app.log', 'text'],
    ['Makefile', 'text'],
    ['.gitignore', 'text'],
  ] as const)('%s → %s', (name, expected) => {
    expect(classifyFile(name)).toBe(expected);
  });

  it('原型链上的键不是源码扩展名（`in` 会误判，`Object.hasOwn` 不会）', () => {
    expect(codeLanguageOf('constructor')).toBeNull();
    expect(codeLanguageOf('__proto__')).toBeNull();
    expect(codeLanguageOf('toString')).toBeNull();
    expect(classifyFile('weird.constructor')).toBe('text');
    expect(classifyFile('weird.__proto__')).toBe('text');
  });
});

describe('sessionUuidOf / workspaceUuidOf', () => {
  it('工作区下任意深度都能取到会话 UUID；工作区目录本身只有 workspaceUuidOf 认', () => {
    expect(sessionUuidOf(`/workspaces/${UUID}`)).toBe(UUID);
    expect(sessionUuidOf(`/workspaces/${UUID}/a/b/c.md`)).toBe(UUID);
    expect(workspaceUuidOf(`/workspaces/${UUID}`)).toBe(UUID);
    expect(workspaceUuidOf(`/workspaces/${UUID}/a`)).toBeNull();
  });

  it('工作区根、其他路径、非法会话 ID 都返回 null', () => {
    expect(sessionUuidOf('/workspaces')).toBeNull();
    expect(sessionUuidOf('/workspaces/readme.md')).toBeNull();
    expect(sessionUuidOf('/workspaces/not-a-uuid/x')).toBeNull();
    expect(sessionUuidOf('/home/user/.cebian/prompts')).toBeNull();
    expect(sessionUuidOf('/workspacesfoo/x')).toBeNull();
  });
});

describe('dualViewTypeOf', () => {
  const text = { content: '', lines: 0, size: 0 };
  it.each<[FileMedia, string | null]>([
    [{ type: 'markdown', ...text }, 'markdown'],
    [{ type: 'html', ...text }, 'html'],
    [{ type: 'svg', ...text, url: 'blob:x' }, 'svg'],
    [{ type: 'code', lang: 'typescript', ...text }, null],
    [{ type: 'text', ...text }, null],
    [{ type: 'image', mime: 'image/png', size: 0, url: 'blob:x' }, null],
    [{ type: 'binary', size: 0 }, null],
  ])('%o → %s', (media, expected) => {
    expect(dualViewTypeOf(media)).toBe(expected);
  });
});
