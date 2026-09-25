import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fakeBrowser } from 'wxt/testing/fake-browser';
import { getSkillGrant } from '@/lib/ai-config/skill-grants';
import { vfs } from '@/lib/persistence/vfs';
import { CEBIAN_SKILLS_DIR } from '@/lib/persistence/vfs-paths';
import { createSessionRunSkillTool, runSkillGate } from '@/lib/tools/run-skill';
import { runInSandbox } from '@/lib/tools/sandbox-rpc';

vi.mock('@/lib/i18n', () => ({
  t: (key: string) => key,
}));

vi.mock('@/lib/tools/sandbox-rpc', () => ({
  runInSandbox: vi.fn(async () => ({ ok: true })),
}));

const SKILL = 'snapshot-test';
const SKILL_DIR = `${CEBIAN_SKILLS_DIR}/${SKILL}`;
const SCRIPT = 'scripts/run.js';

function skillMd(permission: string): string {
  return `---\nname: ${SKILL}\ndescription: test\nmetadata:\n  permissions:\n    - ${permission}\n---\nTest`;
}

async function writeSkill(permission: string, script: string): Promise<void> {
  await vfs.rm(SKILL_DIR, { recursive: true, force: true });
  await vfs.mkdir(`${SKILL_DIR}/scripts`, { recursive: true });
  await vfs.writeFile(`${SKILL_DIR}/SKILL.md`, skillMd(permission));
  await vfs.writeFile(`${SKILL_DIR}/${SCRIPT}`, script);
}

describe('runSkillGate 快照绑定', () => {
  beforeEach(async () => {
    fakeBrowser.reset();
    vi.mocked(runInSandbox).mockClear();
    await writeSkill('vfs.read', 'module.exports = "before";');
  });

  it('授权检查后脚本变化则执行失败关闭', async () => {
    const args = { skill: SKILL, script: SCRIPT, args: {}, tabId: 1 };
    const checked = await runSkillGate.check(args, 'call-script-changed');
    expect(checked.needsGrant).toBe(true);
    await vfs.writeFile(`${SKILL_DIR}/${SCRIPT}`, 'module.exports = "after";');

    const tool = createSessionRunSkillTool('session-1');
    await expect(tool.execute('call-script-changed', args)).rejects.toThrow(
      /changed while permission approval was pending/i,
    );
  });

  it('always 只持久化授权卡片展示的权限集合', async () => {
    const args = { skill: SKILL, script: SCRIPT, args: {}, tabId: 1 };
    await runSkillGate.check(args, 'call-always');
    await vfs.writeFile(`${SKILL_DIR}/SKILL.md`, skillMd('chrome.cookies'));

    await runSkillGate.persistGrant(args, 'call-always');

    expect((await getSkillGrant(SKILL))?.permissions).toEqual(['vfs.read']);
    runSkillGate.discard?.('call-always');
  });

  it('授权检查后权限变化则执行失败关闭', async () => {
    const args = { skill: SKILL, script: SCRIPT, args: {}, tabId: 1 };
    await runSkillGate.check(args, 'call-permission-changed');
    await vfs.writeFile(`${SKILL_DIR}/SKILL.md`, skillMd('chrome.cookies'));

    const tool = createSessionRunSkillTool('session-1');
    await expect(tool.execute('call-permission-changed', args)).rejects.toThrow(
      /changed while permission approval was pending/i,
    );
    expect(runInSandbox).not.toHaveBeenCalled();
  });

  it('授权检查后改用另一脚本则执行失败关闭', async () => {
    const checkedArgs = { skill: SKILL, script: SCRIPT, args: {}, tabId: 1 };
    await runSkillGate.check(checkedArgs, 'call-script-path-changed');
    await vfs.writeFile(`${SKILL_DIR}/scripts/other.js`, 'module.exports = "before";');

    const tool = createSessionRunSkillTool('session-1');
    await expect(tool.execute('call-script-path-changed', {
      ...checkedArgs,
      script: 'scripts/other.js',
    })).rejects.toThrow(/changed while permission approval was pending/i);
    expect(runInSandbox).not.toHaveBeenCalled();
  });

  it('内容未变化时正常进入沙箱，并且快照不可重放', async () => {
    const args = { skill: SKILL, script: SCRIPT, args: { value: 1 }, tabId: 1 };
    await runSkillGate.check(args, 'call-unchanged');
    const tool = createSessionRunSkillTool('session-1');

    const result = await tool.execute('call-unchanged', args);

    expect(result.content).toEqual([{ type: 'text', text: '{\n  "ok": true\n}' }]);
    expect(runInSandbox).toHaveBeenCalledTimes(1);
    await expect(tool.execute('call-unchanged', args)).rejects.toThrow(
      /no authorization snapshot/i,
    );
    expect(runInSandbox).toHaveBeenCalledTimes(1);
  });
});
