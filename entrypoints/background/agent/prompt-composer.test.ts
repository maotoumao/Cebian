import { describe, it, expect, beforeEach, vi } from 'vitest';
import { fakeBrowser } from 'wxt/testing/fake-browser';
import { buildSkillsBlock } from '@/lib/ai-config/scanner';
import { memorySettings, userInstructions } from '@/lib/persistence/storage';
import { composeSystemPrompt } from './prompt-composer';

// skills 索引扫描要读 VFS（IndexedDB），与本文件要验的「拼接 + 占位符替换」无关，
// 故整模块打桩，让每个用例自己决定 skills 块内容。
vi.mock('@/lib/ai-config/scanner', () => ({
  scanSkillIndex: vi.fn(async () => []),
  buildSkillsBlock: vi.fn(() => ''),
}));

describe('composeSystemPrompt', () => {
  beforeEach(() => {
    fakeBrowser.reset();
    vi.mocked(buildSkillsBlock).mockReturnValue('');
  });

  // 最重要的一条：base prompt 里新增 `{{KEY}}` 占位符却忘了在 composeSystemPrompt
  // 的变量表里给值时，替换会静默保留原文并把 `{{KEY}}` 原样发给模型——不抛错、
  // 本地和 CI 都看不出来。这条断言是唯一的拦截点。
  it.each([true, false])('产出不残留任何 {{占位符}}（memory=%s）', async (enabled) => {
    const prompt = await composeSystemPrompt('sess-1', enabled);
    expect(prompt).not.toMatch(/\{\{\w+\}\}/);
  });

  it('SESSION_ID 替换成传入的会话 id', async () => {
    const prompt = await composeSystemPrompt('abc-123', false);
    expect(prompt).toContain('/workspaces/abc-123/');
  });

  it('memory 开启 → 注入记忆指引段与「有跨会话记忆」的 limitation 措辞', async () => {
    const prompt = await composeSystemPrompt('s', true);
    expect(prompt).toContain('## Cross-conversation Memory');
    expect(prompt).toContain('You retain memory across conversations');
  });

  it('memory 关闭 → 不注入记忆指引段，limitation 回到「每次会话独立」', async () => {
    const prompt = await composeSystemPrompt('s', false);
    expect(prompt).not.toContain('## Cross-conversation Memory');
    expect(prompt).toContain('Each session is independent');
  });

  it('memoryEnabled 省略 → 回退读 memorySettings 存储项', async () => {
    await memorySettings.setValue({ enabled: true });
    const prompt = await composeSystemPrompt('s');
    expect(prompt).toContain('## Cross-conversation Memory');
  });

  it('用户指令为空 → 不追加 <user-instructions> 段', async () => {
    const prompt = await composeSystemPrompt('s', false);
    // base prompt 正文里本就提到 `<user-instructions>` 这个标签名（告诉模型怎么对待它），
    // 故不能用裸的 not.toContain；这里断言的是「没有以成段形式被包裹追加」。
    expect(prompt).not.toMatch(/<user-instructions>\n/);
  });

  it('用户指令非空 → 包成 <user-instructions> 段并去除首尾空白', async () => {
    await userInstructions.setValue('  always answer in Chinese  ');
    const prompt = await composeSystemPrompt('s', false);
    expect(prompt).toContain('<user-instructions>\nalways answer in Chinese\n</user-instructions>');
  });

  it('skills 块位于 base prompt 之后、用户指令之前', async () => {
    vi.mocked(buildSkillsBlock).mockReturnValue('<skills>\nfoo\n</skills>');
    await userInstructions.setValue('bar');
    const prompt = await composeSystemPrompt('s', false);
    expect(prompt.indexOf('<skills>')).toBeGreaterThan(0);
    expect(prompt.indexOf('<skills>')).toBeLessThan(prompt.indexOf('<user-instructions>'));
  });

  it('skills 与用户指令都为空 → 段间不出现三连以上换行', async () => {
    const prompt = await composeSystemPrompt('s', false);
    expect(prompt).not.toMatch(/\n{3,}/);
  });
});
