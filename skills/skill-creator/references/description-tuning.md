# Description tuning

The `description` field is the primary triggering signal. The agent only sees `name`, `description`, `metadata`, and the file path for every skill on every user message — it does not load the body until it has already decided to activate the skill. A vague or under-keyworded description means the skill silently never fires.

This reference covers how to write and rewrite descriptions so the agent picks the skill up reliably.

## Anatomy of a good description

A strong description has three parts, in this order:

1. **What** the skill does — verb + object, in one short clause.
2. **When** to use it — concrete user phrasings, contexts, page types, problem shapes.
3. **Synonyms / alternate framings** — words and phrases the user might say instead of the obvious term.

Example, parts annotated:

> *Extract text and tables from PDF files, fill PDF forms, and merge multiple PDFs.* **(what)** *Use when working with PDF documents,* **(when)** *or when the user mentions PDFs, forms, document extraction, or scanned files.* **(synonyms)**

Aim for a single dense paragraph. Hard limit per the upstream spec is 1024 characters; a healthy range is 150–500.

## Write `description`, not the SKILL body

Anything that helps the agent *decide whether to activate* belongs in `description`. Anything that explains *how to perform the work* belongs in the body. A common mistake is moving "when to use" hints into the body — the agent has not loaded the body yet when it makes that decision.

| Goes in `description` | Goes in body |
|---|---|
| Triggers, contexts, synonyms, page patterns | Step-by-step workflow |
| Capability summary (verb + object) | Code samples, output formats |
| User intents the skill handles | Edge cases, error handling |
| Anti-triggers ("not for X") if a sibling skill exists | Tool / API specifics |

## Before / after

### Example 1 — Vague → concrete

Before:

> Helps with web pages.

After:

> Summarize the current web page into structured notes (key points, action items, quotes). Use when the user asks to summarize, digest, or extract takeaways from the current article, blog post, or documentation page.

### Example 2 — Capability-only → capability + triggers

Before:

> Translates text using DeepL.

After:

> Translate selected page text or the user's clipboard between any of the languages DeepL supports. Use when the user asks to translate, render in another language, or "say this in <language>", whether they have a selection on the page or paste text into the chat.

### Example 3 — Implementation-leaking → trigger-focused

Before:

> Calls the GitHub REST API with an OAuth token to fetch issue, PR, and review data, then pipes the JSON through a markdown renderer.

After:

> Look up GitHub issues, pull requests, and reviews for any repository the user mentions, and render them as readable markdown. Use when the user asks about an issue or PR by number, by URL, or by topic ("any open issues about login bugs?"), or wants a quick status summary of a repository.

The "before" describes how the skill works; the "after" describes when to use it. Internal mechanics belong in the body.

## Anti-patterns

- **Too short.** "Helps with X." Gives the agent nothing to match user intent against.
- **Too implementation-heavy.** "Uses XPath selectors and a regex to…" — the agent does not pick skills based on implementation.
- **Pure capability, no triggers.** "Translates text." The agent knows what *translate* means but does not know *when this particular skill should run*.
- **Overlapping with another skill.** Before writing a new skill, scan `~/.cebian/skills/` for any existing skill that already covers the territory. Two skills with overlapping descriptions both undertrigger.
- **Hostile pushiness.** Padding the description with imperatives like "ALWAYS USE THIS SKILL" or "MUST RUN ON EVERY MESSAGE" hurts more than it helps — the agent recognizes this pattern as a bid for attention and may downweight it. Earn the activation by writing better triggers.
- **Stale `metadata.matched-url`.** A `matched-url` glob narrows the agent's mental model of when the skill applies. If the glob is wrong (typo, outdated domain), the skill silently never matches. Verify against actual current page URLs.

## Rewriting an existing description

If a user reports the skill "isn't being picked up":

1. Read the current `description` and brainstorm 5–10 plausible user prompts that *should* fire it.
2. For each prompt, ask: would a reader of just `name` + `description` + `metadata` reasonably conclude this skill applies?
3. Where the answer is "no" or "maybe", note the missing keyword/phrasing/context and add it.
4. Rewrite the description in one paragraph using the three-part structure above.
5. Test with the user: have them open a new message in an existing session (any `fs_edit_file` / `fs_create_file` / `fs_delete` write under `~/.cebian/skills/` invalidates the index cache automatically) and run two or three of the candidate prompts. Confirm the agent reads the `SKILL.md` via `fs_read_file` before responding.
6. If the skill still does not fire, revisit `metadata.matched-url` — an over-restrictive glob is the second-most-common cause after weak descriptions.

## Length and formatting

- Single paragraph, no bullets, no headings inside the value.
- 150–500 characters is a healthy range; 1024 is the upstream hard cap.
- YAML folded scalars (`description: >`) are fine and recommended for anything over ~100 characters — they keep the source readable without changing what the agent sees.

```yaml
description: >
  Extract text and tables from PDF files, fill PDF forms, and merge multiple
  PDFs. Use when working with PDF documents, or when the user mentions PDFs,
  forms, document extraction, or scanned files.
```

The agent receives the folded value as a single line; the source stays scannable.
