/** Skill 授权时绑定的不可变输入。摘要覆盖权限声明、SKILL.md 原文与目标脚本，
 * 任何一项在用户确认期间发生变化，执行阶段都能检测到。 */
interface SkillSnapshotInput {
  permissions: readonly string[];
  skillMd: string;
  scriptPath: string;
  script: string;
}

interface SkillSnapshot {
  permissions: string[];
  digest: string;
}

class SkillSnapshotRegistry {
  private readonly snapshots = new Map<string, SkillSnapshot>();

  set(toolCallId: string, snapshot: SkillSnapshot): void {
    this.snapshots.set(toolCallId, snapshot);
  }

  get(toolCallId: string): SkillSnapshot {
    const snapshot = this.snapshots.get(toolCallId);
    if (!snapshot) {
      throw new Error('Skill execution has no authorization snapshot. Request permission again.');
    }
    return snapshot;
  }

  take(toolCallId: string): SkillSnapshot {
    const snapshot = this.get(toolCallId);
    this.snapshots.delete(toolCallId);
    return snapshot;
  }

  assertMatch(toolCallId: string, current: SkillSnapshot): SkillSnapshot {
    const approved = this.take(toolCallId);
    if (approved.digest !== current.digest) {
      throw new Error('Skill changed while permission approval was pending. Request permission again.');
    }
    return approved;
  }

  delete(toolCallId: string): void {
    this.snapshots.delete(toolCallId);
  }
}

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

async function createSkillSnapshot(input: SkillSnapshotInput): Promise<SkillSnapshot> {
  const permissions = [...input.permissions];
  const payload = JSON.stringify([
    permissions,
    input.skillMd,
    input.scriptPath,
    input.script,
  ]);
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(payload));
  return { permissions, digest: bytesToHex(new Uint8Array(digest)) };
}

export type { SkillSnapshot, SkillSnapshotInput };
export { SkillSnapshotRegistry, createSkillSnapshot };
