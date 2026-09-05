---
name: artifact
description: >
  Build a standalone, single-file HTML page the user can open and use — a report,
  dashboard, data visualization, interactive tool or calculator, mockup, landing
  page, poster/one-pager, or small game — write it into the session workspace and
  hand back a link that renders it in Cebian's file preview. Use when the user asks
  for a web page, dashboard, chart, visualization, interactive demo, prototype,
  "something I can open / click / share", or to "render this as HTML"; also when a
  plain-text answer would be a poor fit for the content (tabular data to explore,
  a layout to judge, a UI to try). Not for ordinary answers, Markdown notes, or
  edits to files that are not HTML.
compatibility: >
  Requires the Cebian VFS tools (fs_create_file, fs_edit_file, fs_read_file) and
  the VFS file preview page, which renders .html files inside a sandbox.
metadata:
  author: cebian
  version: "1.0.0"
---

# artifact

An artifact is one self-contained `.html` file in the session workspace. The user opens it from a link in your reply; Cebian renders it as a live web page in a sandbox, with a Preview / Source toggle, copy and download in the header. You iterate by editing the same file.

## When to reach for an artifact

| The user wants… | Deliver |
|---|---|
| An answer, explanation, list, or comparison they will read once | A normal reply (no artifact) |
| Notes, a plan, a document to keep and re-read | A `.md` file in the workspace |
| Something to **look at**: a page, poster, one-pager, mockup, slide-like summary | Artifact |
| Something to **explore or operate**: dashboard, chart, table with filters, calculator, form, game | Artifact |
| A visual judgment: "does this layout work", "compare these two designs" | Artifact |

If in doubt, ask yourself whether the value is in the rendered result rather than the words. Only then build an artifact.

## Hard rules

Read [references/sandbox.md](references/sandbox.md) once per session before writing your first artifact. The short version:

- **One file, self-contained.** Inline all CSS and JS. Relative paths are never resolved — `./chart.png`, `styles.css`, `../data.json` will 404. Embed small assets as `data:` URIs; load libraries and fonts only from absolute `https://` URLs.
- **No browser storage.** `localStorage`, `sessionStorage`, `document.cookie`, IndexedDB and `caches` all throw `SecurityError` in the sandbox. Keep state in memory. A single uncaught call at the top of a script kills the whole script.
- **Show the page at rest.** Everything worth reading must be visible in plain HTML once loaded, before any script runs: Firefox renders artifacts without JavaScript, and a chart that only appears after JS runs is an empty box there. Put the content in the markup itself; let scripts enhance it.
- **A real `<title>`.** Two to four words naming the thing, like a product or document name — not a description.
- **Real content, never lorem ipsum.** Use the user's data and words. Mark anything you invented as an example.
- **Stable filename.** `kebab-case.html`, chosen once. Edit the same file on every iteration so the user's link keeps working.
- **Keep it small.** Aim for well under 2 MB; the preview refuses files over 50 MB and large `data:` images count.

## Workflow

1. **Pin the subject.** One concrete subject, its audience, and the page's single job. If the request is ambiguous in a way that changes the page materially, ask; otherwise decide and note your assumption in the reply.
2. **Choose the treatment** using [references/design.md](references/design.md): utilitarian (a report, a tool, a dashboard — polished, restrained) or editorial (a landing page, a poster, something meant to be shared — opinionated, one deliberate risk). Most requests are utilitarian.
3. **Write a three-line design plan** before any code: palette (4–6 named colors, light and dark), type (a display face and a body face, with fallbacks), layout (one sentence). Then build from that plan — every color and size in the file should trace back to it.
4. **Start from [assets/starter.html](assets/starter.html).** It carries the token structure, type scale, container, `prefers-color-scheme` handling and `prefers-reduced-motion` respect. Replace the placeholder content; keep the structure.
5. **Write the file** with `fs_create_file` into the session workspace path given in your system prompt (`/workspaces/<session-id>/<name>.html`). Do not put it anywhere else.
6. **Reply with the link and one sentence.** Use the hash-only href form from your system prompt: `[Quarterly dashboard](#/workspaces/<session-id>/quarterly-dashboard.html)`. Say what the page shows and which parts are interactive; mention assumptions and any example data you made up.
7. **Iterate in place.** For every follow-up, `fs_edit_file` the same file — never create `v2.html`. Re-read the file first if the conversation has moved on. Tell the user to re-open or refresh the link.
8. **When the user reports a problem** ("blank", "no style", "chart missing", "nothing happens"), run through the troubleshooting table in [references/sandbox.md](references/sandbox.md) before guessing.

## What an artifact is not

- Not a multi-page site. Links between artifacts do not work inside the preview; put sections, tabs or a sidebar in one page instead.
- Not a place to persist user input. Nothing the user types survives a refresh; say so if the page collects input, or offer a "copy results" button.
- Not a substitute for the conversation. Conclusions, caveats and next steps still belong in your reply.

## References

- [references/sandbox.md](references/sandbox.md) — exactly what the preview sandbox allows and blocks, how links and iteration work, and a troubleshooting table.
- [references/design.md](references/design.md) — design fundamentals for the page: treatment, type, color, layout, charts, copy, and the AI-template look to avoid.
- [assets/starter.html](assets/starter.html) — the skeleton to start every artifact from.
