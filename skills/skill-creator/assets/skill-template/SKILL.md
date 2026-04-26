---
name: my-skill
description: >
  Replace this with 1–1024 characters describing what the skill does AND
  when to use it. Include synonyms a user might say (e.g. "summarize",
  "digest", "tl;dr"). See the description-tuning reference in the
  skill-creator skill for guidance.
metadata:
  author: ""
  version: "0.1.0"
  # Optional Cebian extensions — uncomment as needed:
  # matched-url: "https://example.com/**"
  # permissions:
  #   - chrome.bookmarks
  #   - page.executeJs
# Optional upstream field — uncomment if the skill needs specific tooling:
# compatibility: >
#   Requires <tool/runtime/etc>.
---

<!--
  Starter template for a Cebian skill. To use:
    1. Copy this file to ~/.cebian/skills/<your-skill-name>/SKILL.md
       (the directory name must equal the frontmatter `name`).
    2. Replace `name`, `description`, and `metadata.author`. Bump
       `metadata.version` whenever you ship updates.
    3. Replace this comment and the body below with real instructions.
    4. Add scripts/ and references/ subdirectories only if you actually use them.
-->

# my-skill

Short overview of what this skill does, in one or two sentences. Keep it
focused — anything about *when* to use the skill belongs in `description`,
not here.

## Instructions

Step-by-step workflow the agent should follow when this skill activates.
Use imperative form.

1.
2.
3.

## Examples

Optional. Show one or two concrete input → output pairs so the agent
calibrates against your intent. Drop this section entirely if there are
no examples.

## References

Link to detail-heavy material the agent should load on demand:

- `references/REFERENCE.md` — (create when needed)

Drop this section entirely if there are no `references/` files.
