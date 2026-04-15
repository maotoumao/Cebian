/**
 * Skill name validator — implements agentskills.io naming rules.
 *
 * Rules:
 * - 1-64 characters
 * - Only lowercase letters (a-z), digits (0-9), and hyphens (-)
 * - Cannot start or end with a hyphen
 * - Cannot contain consecutive hyphens (--)
 */

export interface ValidationResult {
  valid: boolean;
  error?: string;
}

export function validateSkillName(name: string): ValidationResult {
  if (!name) {
    return { valid: false, error: 'Name is required' };
  }

  if (name.length > 64) {
    return { valid: false, error: 'Name must be 64 characters or less' };
  }

  if (!/^[a-z0-9-]+$/.test(name)) {
    return { valid: false, error: 'Name may only contain lowercase letters (a-z), digits, and hyphens' };
  }

  if (name.startsWith('-')) {
    return { valid: false, error: 'Name must not start with a hyphen' };
  }

  if (name.endsWith('-')) {
    return { valid: false, error: 'Name must not end with a hyphen' };
  }

  if (name.includes('--')) {
    return { valid: false, error: 'Name must not contain consecutive hyphens (--)' };
  }

  return { valid: true };
}
