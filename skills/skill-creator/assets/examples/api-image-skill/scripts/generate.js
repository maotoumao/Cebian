// Reference example — see ../SKILL.md for the full context.
//
// Pattern: bgFetch → vfs.write → return short markdown link.
// The agent receives ~80 bytes regardless of image size.

// Credentials live in this file, not in SKILL.md — the agent reads
// SKILL.md on every invocation but only reads script files when it
// deliberately fs_read_file's them (rare).
const API_KEY = 'YOUR_API_KEY_HERE';
const ENDPOINT = 'https://api.example.com/v1/images/generate';

if (typeof args.prompt !== 'string' || args.prompt.length === 0) {
  throw new Error('Missing required argument: prompt');
}

const resp = await bgFetch(ENDPOINT, {
  method: 'POST',
  headers: {
    'authorization': `Bearer ${API_KEY}`,
    'content-type': 'application/json',
  },
  body: JSON.stringify({
    prompt: args.prompt,
    size: args.size ?? '1024x1024',
  }),
});

if (!resp.ok) {
  // Native fetch semantics: 4xx/5xx do NOT throw. Decide what to do
  // with the body and throw a useful message yourself.
  throw new Error(`API HTTP ${resp.status}: ${(await resp.text()).slice(0, 200)}`);
}

const json = await resp.json();

// Adjust this to whatever shape your real API returns. Common shapes:
//   - { data: [{ b64_json: "..." }] }              (DALL-E style)
//   - { images: [{ url: "https://..." }] }         (URL-returning APIs)
//   - raw binary in resp.body (use `await resp.bytes()` instead of json())
const b64 = json?.data?.[0]?.b64_json;
if (typeof b64 !== 'string') {
  throw new Error('API response did not contain expected `data[0].b64_json` field');
}

// Base64 → bytes. atob is one of the always-available sandbox globals.
const bytes = Uint8Array.from(atob(b64), c => c.charCodeAt(0));

const filename = `${Date.now()}.png`;
await vfs.writeFile(filename, bytes);

// Return a structured object the agent can extract from. Returning a bare
// string would surface to the agent as a JSON-encoded value (with quotes),
// which is awkward to relay verbatim. The agent's instruction (in
// SKILL.md) is to render the `markdown` field as markdown.
//
// `vfs.cwd` is the absolute path of this skill's session workspace, e.g.
// /workspaces/<session-uuid>/api-image-skill. The renderer recognises
// `#/workspaces/...` hrefs in image markdown and inlines the file.
const path = `${vfs.cwd}/${filename}`;
// Fixed alt text — args.prompt may contain `]` or newlines that would
// break the surrounding `![...](...)` syntax. Use a stable label.
module.exports = {
  markdown: `![generated image](#${path})`,
  path,
};
