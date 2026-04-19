# MCP Custom Request Headers — Implementation Plan

**Goal:** Let users add arbitrary HTTP request headers to each MCP server entry, unlocking provider-specific features (e.g. GitHub MCP `X-MCP-Toolsets`, `X-MCP-Insiders`) without us hard-coding per-provider knobs.

**Scope:** UI + i18n only. The data layer (`MCPTransportConfig.headers`), validation (`validateAndNormalize` rejects bearer/Authorization conflict), and runtime injection (`MCPClient.buildRequestInit` merges headers + bearer with bearer winning) are already in place.

**Tech stack:** React 19 + shadcn `Input`/`Button`/`Label` + lucide `Trash2`/`Plus`. No new deps.

**Locked decisions:**
- Bearer token always wins over user-supplied `Authorization` (already enforced server-side: input is rejected; UI surfaces toast).
- Other header names unrestricted (proxy / `Content-Type` overrides allowed).
- Plan file lives standalone, not appended to the original MCP plan.

---

## Task 1 — Form state & data flow

**File:** `components/settings/mcp/MCPServerForm.tsx`

- Add `headers: Array<{ key: string; value: string }>` to `MCPFormValues`.
- Set `EMPTY.headers = []`.
- `formToInput`: aggregate the array into a `Record<string, string>` using `Headers` (case-insensitive normalization, last wins). Emit `transport.headers` only when non-empty.
- `MCPServerEditForm` initializer: deserialize `server.transport.headers ?? {}` back into the array form.
- **No UI changes in this task** — pure plumbing.

**Verify:** `pnpm check`. Existing add/edit flow behaves identically (headers always empty → undefined).

---

## Task 2 — Headers editor UI

**File:** `components/settings/mcp/MCPServerForm.tsx` (only `MCPFormBody`)

Place the section between the bearer-token block and the Cancel/Submit row:

```
─────  ← <Separator />
Custom headers
[ key input ] [ value input ] [trash button]   ← row, repeats N times
…
[+ Add header]                                  ← outline button, full width
```

- Each row: two `Input h-8 text-sm` + a `Button variant="ghost" size="icon" size-7` containing `<Trash2 className="size-3.5" />`.
- "Add header" button calls `onChange({ headers: [...values.headers, { key: '', value: '' }] })`.
- Row Enter must NOT submit the form. Override `onKeyDown` on these inputs to `e.preventDefault()` on Enter (no submit, no form crash).
- Show the "+ Add header" button always; show rows only when `values.headers.length > 0`.

**Verify:** Manual — add server with two headers, save, reopen, headers persisted; remove a row; empty-key rows silently dropped on save (handled in Task 1's `formToInput`).

---

## Task 3 — i18n

**Files:** `locales/en.yml`, `locales/zh_CN.yml`, `locales/zh_TW.yml`

Add under `settings.mcp.form.*`:

| key | en | zh_CN | zh_TW |
|-----|-----|-------|-------|
| `headers` | Custom headers | 自定义 Headers | 自訂 Headers |
| `headerKeyPlaceholder` | Header name (e.g. X-MCP-Toolsets) | Header 名（如 X-MCP-Toolsets） | Header 名稱（如 X-MCP-Toolsets） |
| `headerValuePlaceholder` | Header value | Header 值 | Header 值 |
| `addHeader` | Add header | 添加 Header | 新增 Header |
| `removeHeader` | Remove header | 移除 Header | 移除 Header |

**Verify:** `pnpm check` (i18n parity lint must pass).

---

## Task 4 — End-to-end verification + commit

1. New server + 2 headers (`X-Foo: bar`, `X-Baz: qux`) → save → reopen → headers re-rendered correctly.
2. Edit existing server: change a value, delete a row, add a new row → save → reopen → state matches.
3. GitHub MCP test: URL `https://api.githubcopilot.com/mcp/`, Bearer + PAT, `X-MCP-Toolsets: repos`. Ask agent for an issue → should be unavailable.
4. Change `X-MCP-Toolsets: repos,issues` → issue tools available again.
5. Conflict test: Bearer enabled + manually add `Authorization: Bearer xxx` → save → toast error from `validateAndNormalize`.
6. `pnpm check` + `pnpm build` clean.
7. Commit: `feat(mcp): custom request headers in server form`.
