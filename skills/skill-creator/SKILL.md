---
name: skill-creator
description: >
  Create new Cebian skills, edit or improve existing ones, scaffold
  multi-file skill packages, and validate them against the agentskills.io
  specification. Use when the user wants to author, refactor, or debug a
  skill (including questions like "why isn't my skill firing"), declare
  metadata.permissions for scripts that call chrome.* APIs or inject code
  into pages, or rewrite a description for better trigger accuracy.
compatibility: >
  Requires the Cebian VFS filesystem tools (fs_create_file, fs_edit_file,
  fs_mkdir, fs_rename, fs_delete, fs_read_file, fs_list, fs_search),
  ask_user, and run_skill (used to test any skill that ships scripts/).
metadata:
  author: maotoumao
  version: "1.0.0"
---

# Cebian skill-creator

A workflow for creating Cebian skills and improving them through iteration. The body below is the loop you follow; the L3 reference files are the facts you cite during each step.

## Hard rules

- **Before drafting any SKILL.md, you MUST `fs_read_file` [assets/skill-template/SKILL.md](assets/skill-template/SKILL.md) and copy its YAML frontmatter block (the `--- ... ---` header at the top) verbatim into the new file.** A SKILL.md without that YAML frontmatter is invalid and will not be indexed. Do not invent alternative formats — there is no `metadata.json`, no `package.json`, no separate manifest. All metadata lives inside the SKILL.md frontmatter.
- **Skill folder name must equal frontmatter `name` exactly.** Rules: 1–64 chars, lowercase `a–z`, digits, hyphens; no leading/trailing hyphen; no `--`. The validator does not currently reject invalid names — the skill will still index — but invalid names are not portable to other agentskills.io clients. Always follow the rules.
- **Do not invent `chrome.*` permissions.** Only the namespaces and methods in the Cebian whitelist are reachable from skill scripts. See [references/runtime-api.md](references/runtime-api.md).
- **Freeze a step into `scripts/` when its correctness depends on exact code — selectors, schemas, ordering, constants — that would drift if re-derived from prose each turn; otherwise keep it as instructions. Empty `scripts/` or unused `metadata.permissions` entries are misleading and train users to dismiss permission prompts.**
- **Index cache rules.** Writes via `fs_create_file` / `fs_edit_file` / `fs_delete` under `~/.cebian/skills/` auto-invalidate the in-memory index, so the very next user message sees the change. `fs_mkdir` and `fs_rename` do **not** invalidate — after either, follow up with an `fs_edit_file` on `SKILL.md` to force a refresh before testing.

For all frontmatter rules, indexing semantics, and Cebian-specific `metadata.*` keys see [references/agentskills-spec.md](references/agentskills-spec.md) and [references/cebian-extensions.md](references/cebian-extensions.md).

## Workflow

### Step 0 — Is this even a skill?

Skills are not free. Before scaffolding anything, eliminate cheaper alternatives:

| Situation | Use this instead of a skill |
|---|---|
| An existing skill already covers the territory | The existing skill — extend it if the gap is small |
| Reusable text template the user wants to invoke by name | A prompt under `~/.cebian/prompts/<name>.md` |
| One-off action the agent can plan and execute in a single session | The native tools directly (`execute_js`, `chrome_api`, `read_page`, etc.) |
| A single browser-API call available via `chrome_api` | `chrome_api` directly |

`fs_list ~/.cebian/skills` and check for overlaps before proceeding. See [references/injection-patterns.md](references/injection-patterns.md) for the decision matrix in detail.

If a skill is still the right answer, continue.

### Step 1 — Branch: new skill or improving an existing one?

Default to inferring intent from existing context (the user's request, attached recordings/files, the active tab). Only `ask_user` when a piece of information is **strictly required** to proceed and **genuinely missing** from context. Never ask to confirm something the user already said or implied.

#### Branch A — New skill

1. **Determine** (a) what the skill should do, (b) likely trigger phrasings, (c) output format, (d) whether scripts are needed and which `chrome.*` capabilities. Per the rule above, infer from context first; if anything is strictly required and unrecoverable, bundle every question into one `ask_user`.
2. **Choose a name** following the rules above. `fs_list ~/.cebian/skills` to check collisions.
3. **Draft the SKILL.md** starting from [assets/skill-template/SKILL.md](assets/skill-template/SKILL.md). Fill in `name`, `description` (see [references/description-tuning.md](references/description-tuning.md)), `metadata.author`, `metadata.version`, optionally `metadata.matched-url`, `metadata.permissions`, `compatibility`.
4. **Scaffold the directory** with `fs_mkdir` + `fs_create_file`. Add `references/`, `scripts/`, `assets/` only when the skill needs them.
5. Enter the **iteration loop** below.

#### Branch B — Improving / debugging an existing skill

1. **Read the current state.** `fs_read_file` the skill's `SKILL.md` and any `references/*` it cites.
2. **Diagnose** which layer is failing — this determines what to change:

   | Symptom | Likely cause | Fix |
   |---|---|---|
   | Skill never triggers on prompts that should match | `description` undertriggers | Rewrite description; re-run the trigger eval |
   | Skill triggers but agent ignores instructions | Body is unclear, contradictory, or buried under references | Tighten body; promote critical content out of L3 |
   | Skill loads but agent picks wrong reference / misses one | Reference is mistitled or under-cited from body | Improve cross-reference language in body |
   | `run_skill` fails or returns wrong shape | Script bug or wrong `metadata.permissions` | Re-read [references/runtime-api.md](references/runtime-api.md), fix script, re-test |
   | Permission prompt fires every time | Declared permission set keeps changing across runs | Stabilize `metadata.permissions` |

3. **Make the minimum edit** that addresses the diagnosis. Don't restructure unrelated parts.
4. Enter the **iteration loop** below.

### Step 2 — Iteration loop (both branches)

**First-pass skip:** if the user's request gave you enough to produce a complete, runnable skill in one shot, do so and present the result. Run the self-trigger eval and manual-run handshake below **only when the user asks to verify or reports an issue**.

Repeat until the user says it's good enough, or until both eval matrices below are clean:

#### A. Self-trigger eval

The agent can simulate the trigger surface without any infrastructure:

1. **Generate ~8 should-fire prompts** the user might realistically write to invoke this skill. Cover the synonyms and phrasings listed in `description`.
2. **Generate ~8 should-NOT-fire prompts** that are *near misses* — same domain, similar vocabulary, but actually answered by a different skill or no skill at all. Near misses are essential; "write a fibonacci function" is not a useful negative for a PDF skill.
3. For each prompt, simulate the agent's L1 decision: read **only** `name` + `description` + `metadata` (close your mental eyes to body and sources) and predict whether the skill would activate.
4. Tally:

   | | Predicted fire | Predicted no-fire |
   |---|---|---|
   | Should fire | ✓ | ❌ undertrigger |
   | Should NOT fire | ❌ overtrigger | ✓ |

5. If either off-diagonal cell is non-empty, rewrite the description per [references/description-tuning.md](references/description-tuning.md) and re-run. If the user prefers to skip the eval and just vibe, do that instead — this is guidance, not policing.

#### B. Manual run with the user

After the description-eval passes:

1. Tell the user to send a fresh message using one of the should-fire prompts.
2. Confirm in the message stream that the agent calls `fs_read_file` on the new `SKILL.md` before answering.
3. If the skill ships scripts: invoke `run_skill` with sample `args`. Expect a `permission_required` response on first use — walk the user through the three-option `ask_user` prompt (Deny / Allow once / Always allow this skill). After approval, re-invoke and verify the return value matches what the body promises. See [references/runtime-api.md](references/runtime-api.md).
4. Inspect the agent's actual output. Two failure modes to watch:
   - **Description level**: skill didn't load. Loop back to A.
   - **Body level**: skill loaded but produced wrong output. Edit the body (clarify steps, add an example, move a key fact from a reference into the body).

#### C. Revise

Pick the most concrete piece of feedback from B and make one focused edit. Avoid sweeping rewrites mid-loop. Then loop back to A.

Exit the loop when:
- Description eval is clean AND a manual run produced output the user accepts, OR
- The user explicitly says "ship it".

## References

- [references/agentskills-spec.md](references/agentskills-spec.md) — the upstream agentskills.io spec: frontmatter fields, directory conventions, name rules, progressive-disclosure model.
- [references/cebian-extensions.md](references/cebian-extensions.md) — Cebian's private `metadata.*` keys (`matched-url`, `permissions`, `disabled`), what's enforced vs documentation-only, and storage layout.
- [references/runtime-api.md](references/runtime-api.md) — skill script execution: sandbox globals, the `chrome.*` whitelist, `page.executeJs` / `executeInPage`, the user-permission flow, error semantics.
- [references/injection-patterns.md](references/injection-patterns.md) — `executeInPage` vs `execute_js`, the cookie matrix, and when **not** to ship a skill.
- [references/description-tuning.md](references/description-tuning.md) — anatomy of a good description, before/after rewrites, anti-patterns.
- [assets/skill-template/](assets/skill-template/) — copy-paste starting point for a new skill.

