# The preview sandbox

Facts about where an artifact lives and how Cebian renders it. Everything here follows from the extension's architecture; when a page misbehaves, the cause is almost always one of these.

## Where the file goes and how the user opens it

- Write to the session workspace named in your system prompt: `/workspaces/<session-id>/<name>.html`. Use `fs_create_file` for the first version and `fs_edit_file` for every revision.
- Link it with a hash-only href, exactly as the system prompt describes: `[Title](#/workspaces/<session-id>/name.html)`. The chat UI turns this into the extension's file-browser URL; never write a `chrome-extension://` prefix yourself.
- Clicking the link opens the VFS file browser in a new tab. For `.html` files it shows the rendered page by default. The header offers a **Preview / Source** toggle, **Copy path**, **Copy** (copies the source) and **Download**. The file name shows in the breadcrumb; the page's `<title>` is what names the file once the user downloads it and opens or shares it on its own.

## How the page is rendered

On Chromium the file browser hosts a dedicated sandbox page, which in turn hosts your HTML in an inner iframe. Consequences:

| Fact | What it means for the page you write |
|---|---|
| Your page runs in its **own opaque origin** | `location.origin` is `"null"`. There is no extension API, no access to Cebian data, no cookies. |
| **Storage APIs throw** `SecurityError` | `localStorage`, `sessionStorage`, `document.cookie`, `indexedDB` — reading or writing, synchronously. One unguarded call at the top of a script aborts that script (`caches.open()` rejects asynchronously instead). Keep state in JS variables; if you must feature-detect, wrap in `try/catch`. |
| **Inline `<script>` and `<style>` run** | Write everything inline. |
| **External scripts, styles, fonts, images, `fetch()` are allowed only from `https://`** (plus `data:` for images, media, fonts and scripts; `blob:` for images, media and scripts; `wss:` for sockets) | Use absolute `https://` URLs for CDNs (cdnjs, jsDelivr, unpkg, esm.sh all work) and any `https://` font host such as Google Fonts. `http://` is blocked. |
| **Relative URLs are never resolved** | The page is delivered as a string, not from a directory. `src="chart.png"`, `href="style.css"`, `fetch("./data.json")` all fail. Inline the CSS, inline the data, embed small images as `data:` URIs, or point at an `https://` URL. |
| `eval` / `new Function` work | Frameworks that need them (Vue's runtime compiler, some template engines) are fine. |
| **No top-level navigation** | `window.top.location = …` and `target="_top"` are blocked. `target="_blank"` opens a new tab, which inherits the sandbox. |
| Links to other VFS files do not work from inside the page | Build one page with sections/tabs rather than several linked pages. |
| Forms may submit, dialogs (`alert` / `confirm` / `prompt`) work | Fine for small tools; nothing persists. |

On **Firefox** there is no sandbox page. The file browser renders the HTML in a plain iframe with scripts disabled: CSS and images work, JavaScript does not. This is why the page must read correctly with static HTML alone — content in the markup, scripts as enhancement. The preview header shows a "Static preview" badge there.

The preview is **not themed by Cebian**. Your page paints its own background and colors; respect the reader's `prefers-color-scheme` yourself (the starter does).

## Size and performance

- The file browser refuses to preview files over 50 MB. Stay well under 2 MB; a page with a few `data:` images and one CDN library is typically 50–300 KB.
- Large inline datasets: keep raw data as a compact JSON array in one `<script type="application/json">` block and render from it; do not repeat it in the markup.
- Every preview/source toggle or link re-open loads the page fresh. State resets. Heavy pages should render their first screen synchronously and defer the rest.

## Iterating

- Edit the **same** file with `fs_edit_file`; the user's link stays valid. Creating `-v2` files leaves stale links in the conversation.
- If the file is large and the change is small, prefer `fs_edit_file` with a precise search string over rewriting the whole file.
- After editing, tell the user to re-open the link (or refresh the file-browser tab). You cannot push the change to an already-open tab.

## Troubleshooting

| The user says | Likely cause | Fix |
|---|---|---|
| "The page is blank / only the background shows" | A script threw before rendering — most often a storage API call, or content that is only produced by JS | Put the content in the HTML; wrap storage access in `try/catch` or remove it; check the browser console message they see |
| "No styling, just text" | CSS loaded from a relative path or an `http://` URL | Inline the CSS or use an `https://` URL |
| "The chart / map / library part is empty" | Library URL is `http://` or relative; the library is loaded after the script that uses it; the library needs a global that a different build exposes | Use an `https://` UMD build placed before your script; check the global name; render a static fallback in the markup |
| "It works in Chrome but not Firefox" | Scripts are disabled in the Firefox preview | Make sure the static HTML already shows the essential content; treat interactivity as a bonus |
| "My input disappeared" | Nothing persists across reloads or toggles | Say so up front; offer "copy" or "download" buttons for results |
| "Fonts look wrong" | Font loaded from a non-`https://` source, or no fallback stack | Use Google Fonts over `https://` and always declare a fallback stack |
| "Images are broken" | Relative `src` | Embed as `data:` URI or use an `https://` URL |
| "The file browser says it's too large" | Over 50 MB, usually giant embedded images | Downscale / compress images, or load them from an `https://` URL |
