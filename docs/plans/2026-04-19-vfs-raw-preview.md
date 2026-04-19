# VFS Browser: Raw Preview Mode Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let users preview SVG, raster images, and PDF files inside the VFS browser (`vfs.html`) instead of seeing only their text/binary representation. Today, an `.svg` file shows raw XML in a `<pre>`, and `.png` shows a "Binary file — N KB" placeholder.

**Architecture:** `FileView` gains an internal `mode` state (`'text' | 'raw'`). The default mode is decided per-extension. SVG and selected raster/PDF types render via a sandboxed Blob URL (`<img>` for images, `<embed>` for PDF) so untrusted file content can't execute scripts. A small toggle in the file header lets the user switch modes when both are meaningful (currently: SVG only).

**Tech Stack:** React 19, the existing VFS reader (`@/lib/vfs`), `URL.createObjectURL` + `Blob`. No new dependencies.

---

## File Structure

### Modified files
- `entrypoints/vfs/App.tsx` — read files as `Uint8Array` (not utf8 string); extend `ViewState.file` to carry bytes; pick default view mode by extension; mount the new `FileView`.
- `locales/en.yml`, `locales/zh_CN.yml`, `locales/zh_TW.yml` — `vfs.viewMode.text`, `vfs.viewMode.raw`, `vfs.previewUnavailable`.

### New files
- (none — all new logic lives inside `entrypoints/vfs/App.tsx` to keep the entrypoint self-contained, matching existing convention.)

---

## Behavior Matrix

| Extension                                    | Default mode | Toggle visible | Raw renderer        |
|----------------------------------------------|--------------|----------------|---------------------|
| `svg`                                        | `raw`        | **yes**        | `<img>` via Blob URL (`image/svg+xml`) |
| `png`, `jpg`, `jpeg`, `gif`, `webp`, `bmp`, `ico` | `raw`        | no             | `<img>` via Blob URL |
| `pdf`                                        | `raw`        | no             | `<embed type="application/pdf">` via Blob URL |
| Everything text-decodable (md, ts, json, yaml, txt, css, html, js, …) | `text` | no | existing `<pre>` |
| Other binary (zip, woff, mp3, …)             | n/a          | no             | "Binary file — $size" placeholder (existing) |

`text` mode also remains available for SVG so users can still inspect/copy XML.

---

## Task 1: Switch File Loader to Bytes

**Files:** `entrypoints/vfs/App.tsx`

- [ ] **Step 1: Add MIME helpers and constants**

Near the existing `BINARY_EXTS`, add:

```ts
// Extensions previewable in raw mode (image / pdf).
const RAW_PREVIEW_EXTS = new Set(['svg', 'png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'ico', 'pdf']);

// Extensions where the user can toggle between text and raw views.
const DUAL_VIEW_EXTS = new Set(['svg']);

function mimeOf(ext: string): string {
  switch (ext) {
    case 'svg':  return 'image/svg+xml';
    case 'png':  return 'image/png';
    case 'jpg':
    case 'jpeg': return 'image/jpeg';
    case 'gif':  return 'image/gif';
    case 'webp': return 'image/webp';
    case 'bmp':  return 'image/bmp';
    case 'ico':  return 'image/x-icon';
    case 'pdf':  return 'application/pdf';
    default:     return 'application/octet-stream';
  }
}
```

- [ ] **Step 2: Extend `ViewState.file` to carry bytes**

```ts
type ViewState =
  | { kind: 'loading' }
  | { kind: 'dir'; path: string; entries: DirEntry[] }
  | { kind: 'file'; path: string; bytes: Uint8Array; size: number; ext: string }
  | { kind: 'error'; path: string; message: string };
```

- [ ] **Step 3: Rewrite the file branch of `loadPath`**

Replace the current text-vs-binary split with a single bytes read. The bytes carry both raw and text representations; `FileView` decides what to show.

```ts
} else {
  const ext = fileExtension(p.split('/').pop() ?? '');
  const raw = await vfs.readFile(p);
  const bytes = raw instanceof Uint8Array ? raw : new TextEncoder().encode(raw as string);
  if (!stale) setView({ kind: 'file', path: p, bytes, size: st.size, ext });
}
```

> Note: `BINARY_EXTS` and the pre-existing "Binary file — $size" branch are no longer needed in the loader — `FileView` decides at render time.

---

## Task 2: Refactor `FileView` to Support Both Modes

**Files:** `entrypoints/vfs/App.tsx`

- [ ] **Step 1: Replace the existing `FileView` with a mode-aware version**

Signature changes from `{ path, content, size }` to `{ path, bytes, size, ext }`. Internal state holds the selected mode; default is decided once on mount via `useState(() => initialMode(ext))`.

```ts
function initialMode(ext: string): 'text' | 'raw' {
  return RAW_PREVIEW_EXTS.has(ext) ? 'raw' : 'text';
}

function isProbablyBinary(ext: string): boolean {
  // Conservative: only treat known-binary, non-previewable extensions as binary.
  return BINARY_EXTS.has(ext) && !RAW_PREVIEW_EXTS.has(ext);
}

function FileView({ path, bytes, size, ext }: { path: string; bytes: Uint8Array; size: number; ext: string }) {
  const [mode, setMode] = useState<'text' | 'raw'>(() => initialMode(ext));
  const name = path.split('/').pop() ?? path;
  const canToggle = DUAL_VIEW_EXTS.has(ext);

  // Decode lazily, only when text mode is actually shown.
  const text = useMemo(() => {
    if (mode !== 'text') return '';
    return new TextDecoder().decode(bytes);
  }, [bytes, mode]);

  // Manage Blob URL lifecycle for raw mode.
  const [blobUrl, setBlobUrl] = useState<string | null>(null);
  useEffect(() => {
    if (mode !== 'raw' || !RAW_PREVIEW_EXTS.has(ext)) {
      setBlobUrl(null);
      return;
    }
    const url = URL.createObjectURL(new Blob([bytes], { type: mimeOf(ext) }));
    setBlobUrl(url);
    return () => URL.revokeObjectURL(url);
  }, [bytes, ext, mode]);

  const lineCount = mode === 'text' ? (text.length === 0 ? 0 : text.split('\n').length) : 0;

  return (
    <div className="border border-border rounded-lg overflow-hidden">
      <div className="flex items-center justify-between px-4 py-2.5 bg-card border-b border-border">
        <div className="flex items-center gap-2.5 min-w-0">
          <FileIcon ext={ext} className="shrink-0 text-muted-foreground" />
          <span className="text-sm font-medium truncate">{name}</span>
        </div>
        <div className="flex items-center gap-3 text-xs text-muted-foreground shrink-0">
          {canToggle && <ModeToggle mode={mode} onChange={setMode} />}
          {mode === 'text' && (
            <>
              <span className="tabular-nums">{t('vfs.lines', [lineCount])}</span>
              <span className="text-border">·</span>
            </>
          )}
          <span className="tabular-nums">{formatSize(size)}</span>
        </div>
      </div>

      <div className="relative overflow-auto max-h-[calc(100vh-12rem)]">
        {mode === 'raw' && blobUrl && ext === 'pdf' && (
          <embed src={blobUrl} type="application/pdf" className="w-full h-[calc(100vh-12rem)]" />
        )}
        {mode === 'raw' && blobUrl && ext !== 'pdf' && (
          <div className="flex items-center justify-center p-6 bg-[repeating-conic-gradient(theme(colors.muted)_0%_25%,transparent_0%_50%)] bg-[length:16px_16px]">
            <img src={blobUrl} alt={name} className="max-w-full max-h-[calc(100vh-16rem)] object-contain" />
          </div>
        )}
        {mode === 'raw' && !blobUrl && isProbablyBinary(ext) && (
          <div className="p-4 text-sm text-muted-foreground">{t('vfs.binaryFile', [formatSize(size)])}</div>
        )}
        {mode === 'text' && (
          <pre className="p-4 text-[13px] leading-relaxed font-mono text-foreground/90 whitespace-pre-wrap wrap-break-word selection:bg-primary/20">
            {text}
          </pre>
        )}
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Add the small `ModeToggle` component**

A pill-style segmented control with two buttons (`Text` / `Raw`). Co-located inside `App.tsx`.

```tsx
function ModeToggle({ mode, onChange }: { mode: 'text' | 'raw'; onChange: (m: 'text' | 'raw') => void }) {
  const base = 'px-2 py-0.5 rounded-sm transition-colors';
  return (
    <div className="inline-flex items-center rounded-md border border-border bg-background p-0.5 text-xs">
      <button
        onClick={() => onChange('text')}
        className={`${base} ${mode === 'text' ? 'bg-accent text-foreground' : 'text-muted-foreground hover:text-foreground'}`}
      >
        {t('vfs.viewMode.text')}
      </button>
      <button
        onClick={() => onChange('raw')}
        className={`${base} ${mode === 'raw' ? 'bg-accent text-foreground' : 'text-muted-foreground hover:text-foreground'}`}
      >
        {t('vfs.viewMode.raw')}
      </button>
    </div>
  );
}
```

- [ ] **Step 3: Update the call site in the App tree**

```tsx
{view.kind === 'file' && <FileView path={view.path} bytes={view.bytes} size={view.size} ext={view.ext} />}
```

---

## Task 3: i18n Strings

**Files:** `locales/en.yml`, `locales/zh_CN.yml`, `locales/zh_TW.yml`

- [ ] Add under existing `vfs:` block:

```yaml
vfs:
  viewMode:
    text: "Text"
    raw: "Preview"
```

- en: `Text` / `Preview`
- zh_CN: `文本` / `预览`
- zh_TW: `文字` / `預覽`

(`vfs.binaryFile` already exists and is reused unchanged.)

---

## Security Notes

- **No `dangerouslySetInnerHTML`.** SVGs render via `<img src={blobUrl}>`, which prevents `<script>` execution and inline event handlers from firing — even if a malicious SVG ends up in the VFS.
- **Blob URL scope.** `URL.createObjectURL` URLs are origin-scoped to the extension; not exposed to web pages.
- **Lifecycle.** Every Blob URL is revoked in the `useEffect` cleanup so navigating between files / toggling modes does not leak memory.
- **No external network.** All preview content comes from `vfs.readFile`; no remote fetches.

---

## Testing Checklist

- [ ] **SVG**: opening `logo.svg` shows the rendered image by default; toggle to `Text` reveals the XML; toggle back; both work after hashchange to another file and back.
- [ ] **PNG / JPG**: opening shows the image; no toggle visible; "Binary file" placeholder no longer appears for these.
- [ ] **PDF**: opens inline via `<embed>`; scrolling/zoom works.
- [ ] **Markdown / TS / JSON**: unchanged behavior; still shows `<pre>` text view.
- [ ] **ZIP / WOFF**: still falls into the binary placeholder branch (`isProbablyBinary` returns true).
- [ ] **Memory**: open / navigate away from several large images; check Task Manager that VFS tab memory does not climb monotonically (Blob URLs revoked).
- [ ] **Dark mode**: image checkerboard background is visible but not jarring in both themes.

---

## Out of Scope

- Editing files inside the VFS browser (read-only stays read-only).
- HTML preview (would require sandboxed iframe; defer until requested).
- Video / audio preview (deferrable; same pattern with `<video>` / `<audio>` if needed later).
- Syntax highlighting in text mode (existing `<pre>` is plain; orthogonal change).
