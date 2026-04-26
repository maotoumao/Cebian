# agentskills.io specification reference

Mirror of the upstream [agentskills.io specification](https://agentskills.io/specification), focused on the parts a skill author needs while writing a `SKILL.md`. Cebian's parser implements this spec; deviations and extensions are listed in [cebian-extensions.md](cebian-extensions.md).

## Directory structure

A skill is a directory containing at minimum a `SKILL.md` file:

```
skill-name/
├── SKILL.md          # required: metadata + instructions
├── scripts/          # optional: executable code
├── references/       # optional: documentation read on demand
├── assets/           # optional: templates, fixtures, lookup tables
└── ...               # any additional files or directories
```

The directory name must match the frontmatter `name` exactly.

## SKILL.md format

YAML frontmatter delimited by `---`, followed by Markdown content.

### Frontmatter fields

| Field | Required | Type | Rules |
|---|---|---|---|
| `name` | Yes | string | 1–64 chars. Lowercase `a-z`, digits `0-9`, hyphens `-` only. No leading or trailing hyphen. No consecutive `--`. Must equal the parent directory name. |
| `description` | Yes | string | 1–1024 chars. Non-empty. Should describe **what** the skill does AND **when** to use it. Should include keywords that help agents identify relevant tasks. |
| `license` | No | string | License name or reference to a bundled license file. |
| `compatibility` | No | string | ≤ 500 chars. Environment requirements (intended product, system packages, network access, etc.). Most skills do not need this. |
| `metadata` | No | map | Arbitrary key→value mapping. The spec says values should be strings; in practice agents (including Cebian) accept arrays and nested maps. Use reasonably unique key names to avoid conflicts across clients. |
| `allowed-tools` | No | string | **Experimental.** Space-separated list of pre-approved tool names. Support varies between agent implementations. Cebian parses this field but does not currently enforce it. |

### Minimal example

```yaml
---
name: skill-name
description: A description of what this skill does and when to use it.
---

Skill body here.
```

### Example with optional fields

```yaml
---
name: pdf-processing
description: Extract PDF text, fill forms, merge files. Use when handling PDFs.
license: Apache-2.0
metadata:
  author: example-org
  version: "1.0"
---
```

### `name` field

- 1–64 characters.
- Unicode lowercase alphanumeric (`a-z`, `0-9`) and hyphens (`-`).
- No leading or trailing hyphen.
- No consecutive hyphens (`--`).
- Must match the parent directory name.

Valid: `pdf-processing`, `data-analysis`, `code-review`.

Invalid: `PDF-Processing` (uppercase), `-pdf` (leading hyphen), `pdf--processing` (consecutive hyphens).

### `description` field

The single most important field for triggering. The agent only sees `name` and `description` at L1 — full body load only happens after the agent decides the skill applies.

- 1–1024 characters.
- Should describe both **what** the skill does and **when** to use it.
- Should include specific keywords / synonyms that help agents identify relevant tasks.

Good:

```
description: Extracts text and tables from PDF files, fills PDF forms, and merges multiple PDFs. Use when working with PDF documents or when the user mentions PDFs, forms, or document extraction.
```

Poor:

```
description: Helps with PDFs.
```

See [description-tuning.md](description-tuning.md) for rewrite techniques.

### `license` field

Optional. Either a short name (e.g. `Apache-2.0`, `Proprietary`) or a reference to a bundled file:

```
license: Proprietary. LICENSE.txt has complete terms
```

### `compatibility` field

Optional, ≤ 500 chars. Only include if your skill has specific environment requirements.

```
compatibility: Designed for Claude Code (or similar products)
compatibility: Requires git, docker, jq, and access to the internet
compatibility: Requires Python 3.14+ and uv
```

Most skills do not need this field.

### `metadata` field

A map of additional properties not defined by the core spec. Clients may attach client-specific keys here. Use unique-ish key names so different clients do not collide.

```yaml
metadata:
  author: example-org
  version: "1.0"
```

For Cebian's recognized `metadata.*` keys (`matched-url`, `permissions`, `disabled`), see [cebian-extensions.md](cebian-extensions.md).

### `allowed-tools` field

**Experimental.** Space-separated string of tools that are pre-approved to run. Examples from the spec:

```
allowed-tools: Bash(git:*) Bash(jq:*) Read
```

Cebian does not currently recognize or enforce this field; it is preserved as-is in the frontmatter for forward compatibility.

## Body content

The Markdown body after the frontmatter contains the skill instructions. There are no format restrictions, but recommended sections:

- Step-by-step instructions
- Examples of inputs and outputs
- Common edge cases

Note that the agent loads the entire body once it activates the skill. Keep `SKILL.md` under ~500 lines and split detail-heavy material into `references/`.

## Optional directories

### `scripts/`

Executable code agents can run. Scripts should be self-contained or clearly document dependencies, include helpful error messages, and handle edge cases gracefully. Supported languages depend on the agent. For Cebian see [runtime-api.md](runtime-api.md).

### `references/`

Additional documentation agents read on demand. Keep individual files focused so the agent loads only what it needs. Examples:

- `REFERENCE.md` — detailed technical reference
- `FORMS.md` — form templates or structured data formats
- Domain-specific files (`finance.md`, `legal.md`, etc.)

### `assets/`

Static resources: templates, images, data files, lookup tables, schemas.

## Progressive disclosure

Agents load skills in three stages:

1. **Metadata** (~100 tokens) — `name` and `description` of every skill at startup.
2. **Instructions** (< 5000 tokens recommended) — full `SKILL.md` body when the skill activates.
3. **Resources** — files in `scripts/`, `references/`, `assets/` only when needed.

Keep `SKILL.md` under 500 lines. Move detailed reference material to separate files.

## File references

When referencing other files in your skill, use relative paths from the skill root:

```markdown
See [the reference guide](references/REFERENCE.md) for details.

Run the extraction script: scripts/extract.js
```

Keep file references one level deep from `SKILL.md`. Avoid deeply nested reference chains.

## Validation

The upstream `skills-ref` CLI ([github.com/agentskills/agentskills](https://github.com/agentskills/agentskills)) validates frontmatter and naming conventions:

```
skills-ref validate ./my-skill
```

Cebian validates the `name` rules at install time and silently skips user skills whose `SKILL.md` fails to parse. To verify a freshly authored skill is being indexed, see the manual-test step in the parent `SKILL.md`.
