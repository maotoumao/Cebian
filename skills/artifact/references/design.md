# Design fundamentals for artifacts

Approach every artifact as a designer with range: give each page a visual identity pitched at the treatment the request actually calls for, make deliberate choices about palette, type and layout that are specific to the subject, and avoid templated output.

## Read the request first

Calibrate the **treatment**, not whether to design. A report deserves the same craft as a landing page; what changes is how loudly the craft speaks.

- **Utilitarian** (most requests): a report, a dashboard, a tool, a comparison, a plan. Polished — real typographic hierarchy, considered spacing, a proper palette — but restrained. No giant hero, no flourishes beyond one or two tasteful details.
- **Editorial** (when the page itself is the thing being shared or kept): a landing page, a poster, a game, an app the user will show to others. Opinionated choices, one real aesthetic risk, everything around it quiet.

When unsure, a well-composed utilitarian page is never wrong; an over-designed one sometimes is.

## Ground it in the subject

Pin one concrete subject, its audience, and the page's single job. The subject's own world — its materials, instruments, vernacular, units, document conventions — is where distinctive choices come from. Carry at least one detail only this subject would have, as content rather than ornament. Build with real content throughout; if you must invent example data, label it as an example.

## Type

Typography carries the page even when the page is not about typography.

- Pair two faces: a display face used with restraint for headings, and a body face for running text. Add a utility face for captions or tabular figures when there is data.
- Any `https://` font host works in the sandbox; Google Fonts is the convenient one: `<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=…&display=swap">`. Always declare a real fallback stack so the page reads correctly if the font never arrives (Firefox static preview still loads fonts; a blocked network does not).
- Keep running text near 65 characters wide. Set a type scale (for example 12 / 13 / 15 / 18 / 24 / 32) and stay on it. Give headings `text-wrap: balance`, uppercase labels a touch of `letter-spacing`, and body text room to breathe (`line-height` 1.5–1.7).
- Avoid the reflex choices — Inter or Space Grotesk as the "safe" face on every page. Pick for the subject.

## Color

- Describe the palette as 4–6 named values before writing CSS, and derive every color in the file from them via CSS custom properties.
- **Choose neutrals; do not default to them.** A pure mid-grey reads as unconsidered; a grey with a slight bias toward the accent reads as chosen. Pure white and near-black are fine grounds when they suit the subject.
- **Design both themes.** Define the complete light palette on `:root`, redefine only the tokens under `@media (prefers-color-scheme: dark)`, and never give a color its only definition inside the media query. Give `body` an explicit `background` from a token. A design that deliberately commits to one look (a neon arcade screen, a letterpress card) may stay single-theme, but then paint every color explicitly.
- Semantic colors (good / warning / critical) are separate from the accent and do not count as the accent.
- Spend boldness in one place; keep everything around it quiet. If the accent fights the ground, shift it toward analogous or drop saturation rather than swapping it.

## Layout and spacing

- Lay out sibling groups with flex or grid and `gap`, not per-element margins that collapse or double.
- Compose repeated things as one object: cards in a row, label/value pairs down a list, badges on siblings share edges, baselines and inner padding, and a recurring element sits in the same place on each. Let content set a container's height; pick a column count the items fill.
- **Not everything is a card.** Border, fill, radius and shadow each say "separate object" — spend them by role, lifting the one thing that needs it. One radius and one shadow stamped on every block flattens the hierarchy.
- Wide content (tables, code, diagrams) scrolls inside its own `overflow-x: auto` container; the page body never scrolls sideways. Use `max-width: 100%` on images.
- `font-variant-numeric: tabular-nums` wherever digits line up in columns.
- Text that can outgrow its track wraps or scrolls in its own container; clipped text is a bug.

## Charts and data

- Draw to one scale: marks, ticks and labels come from the same scale, every label names a value the chart reaches, and marks stay clear of one another and inside the drawing's bounds. In SVG, leave room in the `viewBox` for the outermost labels and give every drawn shape an explicit fill.
- Chart text takes its color from the theme tokens so it reads in both themes.
- Give charts the same care as type: an area fill, a faint grid, an emphasized endpoint, a legend only when there is more than one series.
- Prefer inline SVG drawn from the data for small charts (works with scripts disabled). Reach for a charting library only when it carries real weight (many series, zoom, tooltips), load its UMD build from an `https://` CDN with a pinned version, and still render a static summary (headline numbers, a table) in the markup so Firefox readers are not left with an empty box.

## Show the page at rest

The first still frame — what the user sees on open, what a screenshot captures, what Firefox shows without scripts — must already be the page. Everything meant to be read is visible without scrolling to trigger it or waiting for a script. A section may animate in from a visible resting state, never parked at `opacity: 0`. Size a hero to what it holds, not to the viewport. A tool opens in a realistic working state with example rows, plainly marked as examples, rather than an empty shell.

## Libraries

Most pages need no library. When one carries real weight (a charting library, a syntax highlighter, React for a genuinely stateful tool), load its UMD build from `https://cdnjs.cloudflare.com/ajax/libs/<lib>/<exact version>/<file>` or another `https://` CDN, placed before the inline script that uses its global. Pin exact versions. Inline the library's stylesheet if it has one. Never paste a library's source into the file.

## Motion

Use motion deliberately: a page-load sequence or a hover micro-interaction only where it serves the subject. Respect `prefers-reduced-motion: reduce` by disabling transitions and animations. Scattered animation reads as generated; one orchestrated moment lands harder.

## Copy

Words are design material. Write from the user's side of the screen — name things by what people recognize, not how the page is built. Active voice; a control says exactly what happens ("Export CSV"). Errors say what went wrong and how to fix it. Specific beats clever. Structural devices (numbering, eyebrows, dividers) must encode something true about the content: number steps only if order matters.

## Name the page

The `<title>` is the page's name when the user downloads the file and opens or shares it on its own, and the first line a reader sees in Source view. Give it a real name: a short noun phrase, two to four words, specific to the subject ("Q3 Renewal Dashboard", "Sourdough Timing Calculator"), never a category label ("Dashboard") and never a name with an appended explainer after a dash or colon.

## The look to avoid

Generated pages cluster around a few looks: warm cream `#F4F1EA` with a serif display and terracotta accent; near-black with a lone acid-green or vermilion pop; hairline broadsheet rules with dense columns; a purple-to-blue gradient hero on white; Inter or Space Grotesk everywhere; emoji as section markers; everything centered; the same rounded card with an accent rail repeated down the page. Where the user asks for one of these, do it well. Where nothing is specified, do not spend the freedom on a default.

## Build cleanly

Watch for overlapping elements, cascade collisions between a type-based selector and an element one, and silent font fallbacks. Close every non-void element, double-quote attributes, give keyboard focus a visible state. For generative or decorative graphics, use Canvas rather than hand-authoring long SVG path data — and because Canvas needs a script, keep such graphics decorative with a static fallback, never the only carrier of content.
