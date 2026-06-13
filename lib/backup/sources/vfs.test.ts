import { describe, it, expect } from 'vitest';
import { planVfsWrites, type VfsIndex } from '@/lib/backup/sources/vfs';
import { VFS_PREFIX } from '@/lib/backup/payload-format';

const SKILLS = '/home/user/.cebian/skills';
const PROMPTS = '/home/user/.cebian/prompts';
const WORKSPACES = '/workspaces';

/** 构造 bundle key（`/abs` → `vfs/abs`）。 */
function k(abs: string): string {
  return VFS_PREFIX + abs.replace(/^\//, '');
}

/** 大多数用例本地无目录冲突，用一个空集占位 localDirs 参数。 */
const NO_DIRS = new Set<string>();

describe('planVfsWrites — root 过滤', () => {
  it('只处理落在选中 roots 下的文件', () => {
    const keys = [
      k(`${SKILLS}/a/SKILL.md`),
      k(`${PROMPTS}/p.md`),
      k(`${WORKSPACES}/s1/out.txt`),
    ];
    const index: VfsIndex = Object.fromEntries(keys.map((key) => [key, 100]));
    // 只恢复技能 + 提示词，不含工作区。
    const plan = planVfsWrites(keys, index, {}, NO_DIRS, [SKILLS, PROMPTS], 'merge');
    expect(plan.toWrite.sort()).toEqual([k(`${SKILLS}/a/SKILL.md`), k(`${PROMPTS}/p.md`)].sort());
    // 工作区文件不在选中 roots，被忽略。
    expect(plan.toWrite).not.toContain(k(`${WORKSPACES}/s1/out.txt`));
  });

  it('前缀匹配不误伤相邻同名前缀目录', () => {
    // /workspaces-bak 不应被 /workspaces 命中。
    const keys = [k('/workspaces/a.txt'), k('/workspaces-bak/b.txt')];
    const index: VfsIndex = { [keys[0]]: 1, [keys[1]]: 1 };
    const plan = planVfsWrites(keys, index, {}, NO_DIRS, [WORKSPACES], 'replace');
    expect(plan.toWrite).toEqual([k('/workspaces/a.txt')]);
  });
});

describe('planVfsWrites — replace', () => {
  it('clearRoots = 全部 roots，toWrite = 该 roots 下全部文件', () => {
    const keys = [k(`${WORKSPACES}/s1/a.txt`), k(`${WORKSPACES}/s2/b.txt`)];
    const index: VfsIndex = { [keys[0]]: 1, [keys[1]]: 1 };
    const plan = planVfsWrites(keys, index, {}, NO_DIRS, [WORKSPACES], 'replace');
    expect(plan.clearRoots).toEqual([WORKSPACES]);
    expect(plan.toWrite.sort()).toEqual(keys.sort());
    expect(plan.toSkip).toEqual([]);
  });

  it('replace 不看本地 mtime（即便本地更新也照搬）', () => {
    const key = k(`${SKILLS}/a/SKILL.md`);
    const index: VfsIndex = { [key]: 50 }; // 备份更旧
    const local = { [key]: 999 }; // 本地更新
    const plan = planVfsWrites([key], index, local, NO_DIRS, [SKILLS], 'replace');
    expect(plan.toWrite).toEqual([key]);
  });
});

describe('planVfsWrites — merge（path + mtime LWW）', () => {
  const key = k(`${SKILLS}/a/SKILL.md`);

  it('本地缺失 → 写入', () => {
    const plan = planVfsWrites([key], { [key]: 100 }, {}, NO_DIRS, [SKILLS], 'merge');
    expect(plan.toWrite).toEqual([key]);
    expect(plan.toSkip).toEqual([]);
  });

  it('备份更新（mtime 更大）→ 写入覆盖', () => {
    const plan = planVfsWrites([key], { [key]: 200 }, { [key]: 100 }, NO_DIRS, [SKILLS], 'merge');
    expect(plan.toWrite).toEqual([key]);
  });

  it('备份更旧 → 跳过（不覆盖更新的本地文件）', () => {
    const plan = planVfsWrites([key], { [key]: 50 }, { [key]: 100 }, NO_DIRS, [SKILLS], 'merge');
    expect(plan.toWrite).toEqual([]);
    expect(plan.toSkip).toEqual([key]);
  });

  it('mtime 相等 → 跳过', () => {
    const plan = planVfsWrites([key], { [key]: 100 }, { [key]: 100 }, NO_DIRS, [SKILLS], 'merge');
    expect(plan.toSkip).toEqual([key]);
  });

  it('merge 不清空任何 root（只增不减）', () => {
    const plan = planVfsWrites([key], { [key]: 100 }, {}, NO_DIRS, [SKILLS], 'merge');
    expect(plan.clearRoots).toEqual([]);
  });

  it('本地缺失 + 备份缺 index mtime → 仍写入（补缺优先）', () => {
    const plan = planVfsWrites([key], {}, {}, NO_DIRS, [SKILLS], 'merge');
    expect(plan.toWrite).toEqual([key]);
  });

  it('本地已有 + 备份缺 index mtime → 跳过（不敢覆盖更新的本地）', () => {
    const plan = planVfsWrites([key], {}, { [key]: 100 }, NO_DIRS, [SKILLS], 'merge');
    expect(plan.toWrite).toEqual([]);
    expect(plan.toSkip).toEqual([key]);
  });
});

describe('planVfsWrites — 结构红线', () => {
  it('红线1：路径正好等于受保护根的条目两种模式都跳过', () => {
    // 构造一个 key 恰好映射到 /workspaces（受保护根本身），不能被当文件写入。
    const evil = k(WORKSPACES);
    const good = k(`${WORKSPACES}/s1/a.txt`);
    const keys = [evil, good];
    const index: VfsIndex = { [evil]: 1, [good]: 1 };

    const rep = planVfsWrites(keys, index, {}, NO_DIRS, [WORKSPACES], 'replace');
    expect(rep.toWrite).toEqual([good]);
    expect(rep.toSkip).toEqual([evil]);

    const mer = planVfsWrites(keys, index, {}, NO_DIRS, [WORKSPACES], 'merge');
    expect(mer.toWrite).toEqual([good]);
    expect(mer.toSkip).toContain(evil);
  });

  it('红线1：技能 / 提示词根本身也跳过', () => {
    const keys = [k(SKILLS), k(PROMPTS), k(`${SKILLS}/a/SKILL.md`)];
    const index: VfsIndex = Object.fromEntries(keys.map((key) => [key, 1]));
    const plan = planVfsWrites(keys, index, {}, NO_DIRS, [SKILLS, PROMPTS], 'replace');
    expect(plan.toWrite).toEqual([k(`${SKILLS}/a/SKILL.md`)]);
    expect(plan.toSkip.sort()).toEqual([k(SKILLS), k(PROMPTS)].sort());
  });

  it('红线2：merge 下本地同名目录的文件被跳过', () => {
    const key = k(`${WORKSPACES}/s1/report`);
    const abs = `${WORKSPACES}/s1/report`; // 本地这是个目录
    const plan = planVfsWrites([key], { [key]: 999 }, {}, new Set([abs]), [WORKSPACES], 'merge');
    expect(plan.toWrite).toEqual([]);
    expect(plan.toSkip).toEqual([key]);
  });

  it('红线2：replace 不受本地同名目录影响（根已整体清空）', () => {
    const key = k(`${WORKSPACES}/s1/report`);
    const abs = `${WORKSPACES}/s1/report`;
    const plan = planVfsWrites([key], { [key]: 1 }, {}, new Set([abs]), [WORKSPACES], 'replace');
    expect(plan.toWrite).toEqual([key]);
  });
});

describe('planVfsWrites — 命名空间守卫', () => {
  it('忽略非 vfs/ 前缀的 key（不会被误映射进选中 root）', () => {
    // `xxxworkspaces/a.txt` slice 后会变 `/workspaces/a.txt`，必须先被前缀守卫挡掉。
    const stray = 'xxxworkspaces/a.txt';
    const config = 'config.json';
    const good = k(`${WORKSPACES}/s1/out.txt`);
    const keys = [stray, config, good];
    const index: VfsIndex = { [good]: 1 };
    const plan = planVfsWrites(keys, index, {}, NO_DIRS, [WORKSPACES], 'replace');
    expect(plan.toWrite).toEqual([good]);
  });
});
