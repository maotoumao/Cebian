---
name: api-image-skill
description: >
  Reference example for skills that call a third-party HTTPS API with an
  API key and return a generated image. NOT meant to be installed as-is —
  the placeholder endpoint at https://api.example.com/ does not exist.
  Copy this whole folder into ~/.cebian/skills/<your-name>/ and rewrite
  for your real API.
metadata:
  author: cebian-skill-creator
  version: "0.0.1"
  permissions:
    - bgFetch:https://api.example.com/*
    - vfs.write
---

<!--
  Reference example. Demonstrates the recommended pattern for "skill calls
  an HTTPS API → produces a binary artifact → user sees it in the chat":

  1. bgFetch       — runs in the background SW, bypasses CORS, isolated
                     from any page-side scripts, so the API key never
                     leaves the extension.
  2. vfs.write     — lands the binary in /workspaces/<sessionId>/<skill>/,
                     not in the agent's context.
  3. Markdown link — the renderer recognises `#${vfs.cwd}/...` and inlines
                     the image; the agent only ever sees ~80 bytes.

  Three things to change before installing:
    - Rename the folder and the `name` frontmatter field to something
      meaningful.
    - Replace `https://api.example.com/v1/images/generate` and the
      bgFetch pattern with the real endpoint.
    - Replace `YOUR_API_KEY_HERE` in scripts/generate.js with the real key.

  See the skill-creator's references/runtime-api.md and
  references/injection-patterns.md for the full reasoning.
-->

# api-image-skill (example)

This skill generates an image via a fictional `https://api.example.com/` and
shows it inline in the chat.

## Instructions

When the user asks to generate / draw / make an image (and any
synonyms in the user's language), call:

```
run_skill(skill="api-image-skill", script="scripts/generate.js",
          args={ "prompt": "<the prompt>", "size": "1024x1024" })
```

`args.size` is optional and defaults to `1024x1024`.

The script returns a JSON object of the form:

```json
{ "markdown": "![generated image](#/workspaces/<...>/api-image-skill/<file>.png)",
  "path":     "/workspaces/<...>/api-image-skill/<file>.png" }
```

Render the `markdown` field's value to the user **as markdown** (do not
wrap it in quotes or a code fence — the renderer needs to see the bare
`![...](...)` syntax to inline the image). The `path` field is there in
case the user wants to know where the file lives.

If the script throws (network error, API auth failure, response shape
mismatch), surface the error message; do not retry without the user's
input.

## Notes

- The API endpoint is a placeholder and will not actually respond. Replace
  both the bgFetch pattern in this SKILL.md and the `ENDPOINT` constant in
  `scripts/generate.js` with your real provider before installing.
- The image is saved to the per-session workspace and is cleaned up
  automatically when the user deletes the session.
- The API key in `scripts/generate.js` is never read by the agent in
  normal operation. Do not move it into this SKILL.md body — the body is
  re-read on every invocation and ends up in the conversation log.
