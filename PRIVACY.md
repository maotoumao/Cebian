# Cebian Privacy Policy

English | **[简体中文](PRIVACY.zh-CN.md)**

**Last updated:** 2026-10-09

## TL;DR

**Cebian stores its working data locally. The author does not operate a backend
that collects your data, but features you use can send data to other services.**

Cebian is an open-source browser extension ([AGPL-3.0](./LICENSE)) whose extension
code runs in your browser. Chats, settings, credentials, and files are stored
locally. AI requests send messages and relevant context directly to the model
provider or custom endpoint you configure, without an author-operated proxy.
Depending on the features you use, data may also go to MCP servers, search
engines and websites, browser speech-recognition services, or your WebDAV server.
Local storage does **not** mean that data never leaves your device.

Uninstalling removes the extension's local storage, not exported files, remote
backups, or records retained by services that received requests.

---

## 1. Scope

This policy describes how the Cebian browser extension (hereafter "Cebian", "the
extension", or "we") handles user data.

It does **not** cover:

- The privacy practices of the AI providers you configure (OpenAI, Anthropic,
  Google, etc.) — those are governed by their own privacy policies.
- The privacy practices of MCP (Model Context Protocol) servers, WebDAV servers,
  search engines, websites, and browser speech-recognition services used by the
  features you enable.
- Any fork, repackage, or self-hosted build of Cebian that you or a third party
  modifies.

Source code: <https://github.com/maotoumao/Cebian>

---

## 2. Data we process

Data access depends on your actions, enabled features, and tools used during a
task. Some processing happens before a message is sent or continues in the
background; this is distinct from collecting analytics for the author.

| Data category | Specifically | When it's accessed | Where it goes |
| :-- | :-- | :-- | :-- |
| **Website content** | URL, title, page metadata/text, selected text and DOM elements, screenshots or files used by tools | While preparing context/templates, using element picking or page actions, recording, or running tools in a task | Read locally; included context, attachments, and tool results are sent to the configured model when used in AI requests |
| **User activity** | Active page metadata/selection, viewport and focus information, plus URLs/titles and IDs of open tabs/windows | When gathering AI context; enabled UI features and tasks also read tab/page state | Local processing; gathered AI context goes to the configured model |
| **Clipboard content** | System clipboard text | Selecting a slash-menu prompt template attempts to read the clipboard while gathering variables, even if the template does not use `{{clipboard}}` | Read locally; included in the template sent to AI if the template uses `{{clipboard}}` |
| **Browsing history** | Read/query/manage via `chrome.history` | When the AI invokes browser tools during a task, or an authorized Skill uses these APIs | Results may enter the chat and subsequent AI requests; Skills may use them in permitted external requests |
| **Bookmarks** | Read/write via `chrome.bookmarks` | When the AI invokes browser tools during a task, or an authorized Skill uses these APIs | Results may enter the chat and subsequent AI requests; Skills may use them in permitted external requests |
| **Cookies** | Read, set, and remove via `chrome.cookies`, including cookie values accessible to that API | When the AI invokes browser tools during a task, or an authorized Skill uses these APIs | Results may enter the chat and subsequent AI requests; Skills may use them in permitted external requests |
| **Top sites** | Read via `chrome.topSites` | When the AI invokes browser tools during a task, or an authorized Skill uses these APIs | Results may enter the chat and subsequent AI requests; Skills may use them in permitted external requests |
| **Recently closed tabs / sessions** | Read/restore via `chrome.sessions` | When the AI invokes browser tools during a task, or an authorized Skill uses these APIs | Results may enter the chat and subsequent AI requests; Skills may use them in permitted external requests |
| **Downloads** | Query/manage via `chrome.downloads` | When the AI invokes browser tools during a task, or an authorized Skill uses these APIs | Results may enter the chat and subsequent AI requests; Skills may use them in permitted external requests |
| **Recorded interaction sessions** | Clicks, keypresses, typed text, scrolls, navigations, and DOM-element selectors on recorded tabs | While a recording you started has interaction recording enabled | Held in memory during recording; stopping adds a draft attachment. Sending it passes the recording to the AI and persists it with the chat in IndexedDB |
| **Recorded network requests** | For each request the recorded tabs make (page loads, fetch / XHR, EventSource, WebSocket): method, URL, status, timing, request and response headers, request and response bodies up to 64 KiB each, and the first few WebSocket / EventSource messages (in Firefox: no response bodies and no messages). Recognizable secrets such as tokens, passwords, API keys and auth headers are replaced with `[redacted]`, and formats that cannot be reliably redacted are left out; a secret with no recognizable name (for example a bare token inside a URL path) may remain, so review the recording before sending or sharing it. Recording stops capturing network data after 500 requests or 5 MiB of recorded request bodies, response bodies and message previews combined. **Cookie/Set-Cookie header values are redacted and HAR cookie arrays are empty** (this network-recorder behavior does not disable cookie access through browser tools or Skills), static assets (images, scripts, styles, fonts) are not recorded, and recognized requests to common analytics / monitoring services are skipped | Only while a recording you started has "Network requests" turned on (off by default) | Held in memory during recording; when you stop, a summary is added as a draft attachment. Sending it passes the summary to your AI provider and stores it with that chat in IndexedDB. The full log is saved as a HAR file in that chat's workspace in Cebian's virtual filesystem (`cebian-vfs`) when you send the message; its content can also be read by AI file tools |
| **Microphone audio (voice input)** | Live microphone audio for speech-to-text | Only after you start voice input | The default `auto` mode prefers on-device recognition, may download a browser language pack, and falls back to the browser's cloud speech service if local recognition is unavailable. Audio may therefore leave your device under that service's policies. Text is inserted into the input for review, not automatically submitted to the chat model; there is no separate AI-correction request |
| **API keys & OAuth tokens** | Provider credentials and custom authentication headers | When configured, used for requests, or refreshed | Stored in `chrome.storage.local`; used with the configured provider/API and OAuth endpoints according to their authentication protocols; included in backups that contain credentials |
| **MCP server configurations** | URLs, custom headers, and bearer tokens; tool arguments and results when connected | When configured, connected, or used by a task | Configuration stored in `chrome.storage.local`; authentication and tool requests go to the configured MCP service, and tool results may be sent to AI; credentials can be included in backups |
| **Chat history, settings** | Conversations, your preferences | Continuously, as you use the extension | Stored locally in IndexedDB (`cebian` database) and `chrome.storage.local` |
| **Prompt templates, Skills, files in the virtual FS** | Templates/Skills you author or import; created/imported workspace files | As you use these features | Stored in IndexedDB (`cebian-vfs`); template/Skill content and file contents may be sent to AI when used, and included in selected backups |
| **Cross-conversation memory** | User profile, preferences, context, and references synthesized from conversations | When memory is enabled; manual or enabled automatic organization | Stored in `cebian-vfs`; profile/index and recalled content go to AI, and organization reads memory through the selected model; see section 7 |
| **Backups / WebDAV** | Selected backup contents, server URL, username, password | When you create/export a backup or use WebDAV backup operations | Archive saved locally or sent to your WebDAV server; connection credentials stored in `chrome.storage.local`; see section 7 |

The author does not collect this data through an analytics or telemetry backend.
That does **not** mean Cebian never processes personal information: chats, pages,
files, cookies, provider login data, or enabled memory may contain names, email
addresses, account details, or other sensitive content. Receiving services also
see network metadata such as your IP address. Avoid including sensitive data that
you do not want the relevant service to receive.

---

## 3. How data flows

```text
Your browser: Cebian + local storage
  ├─ AI requests and tool results → configured model endpoints
  ├─ MCP calls → configured MCP servers
  ├─ Search, browsing, Skills, downloads/previews → relevant sites/services
  ├─ Voice input → browser speech engine (local or cloud)
  ├─ Backup upload → your configured WebDAV server
  └─ About-page update check → GitHub API
```

These are feature-dependent paths, not a promise that each operation stays
local. A task may continue making tool and model requests in the background.
Automatic chat titles and context compaction also send conversation content to
their configured model (or the chat model); memory organization uses its selected
model or the global model. These may be different providers from the chat model.
OAuth login and token refresh contact the provider's authentication services.

Search uses browser tabs, including background tabs, so queries go to the search
engine and normal website cookies/login state may apply. Skills, MCP Apps, and
HTML previews can also contact external resources according to their code and
applicable browser/extension restrictions. Their traffic is not limited to AI APIs.

The Cebian author operates no data-collection backend or request proxy for the
extension. Cebian has no analytics endpoint, error-reporting service, or telemetry
pings to the author.

When you open **Settings → About**, the extension checks
`https://api.github.com/repos/maotoumao/Cebian/releases/latest` for updates,
with a 6-hour local cache (a manual recheck bypasses it). The request does not
include your chats, page content, or configured credentials. GitHub can still
receive ordinary network metadata such as your IP address and user-agent.
This is an additional network request, not the only non-AI request. Chrome Web
Store installations receive extension binary updates through the store.

---

## 4. What we do NOT do

The following statements describe Cebian and the author's own collection/use,
not the practices of services contacted by enabled features:

- ❌ We do not run a backend that collects your extension data.
- ❌ We do not collect telemetry, analytics, crash reports, or usage statistics.
- ❌ We do not display ads.
- ❌ The author does not sell or rent your data; feature-related transfers to
  other services are described in this policy.
- ❌ The author does not use your data to train models. Third-party model
  providers have their own terms.
- ❌ We do not require a Cebian account. Providers and connected services may
  require their own credentials or login.

Reading data is not limited to clicking Send: selection tools, prompt-template
preparation, recording, and tasks already running can read data as described
above. Tool calls within a task are not all subject to a separate confirmation;
Skill permissions can also be remembered after you grant them.

---

## 5. Third-party AI providers

For chat and auxiliary AI features, Cebian transmits requests directly from your
browser to the configured model endpoint. Requests can include your messages,
conversation context, selected attachments, tool results, and enabled memory
context. Cebian supports, among others:

- OpenAI, Anthropic, Google Gemini, xAI, Groq, OpenRouter, DeepSeek, Mistral,
  MiniMax, MiniMax (CN), Kimi, zAI
- GitHub Copilot, OpenAI Codex (via OAuth)
- Any custom OpenAI-compatible endpoint you add yourself (including your own
  self-hosted models)

Once data leaves your browser, the receiving provider's privacy policy applies.
Whether they retain, log, or use your input for model training is **entirely
governed by their terms** — Cebian has no visibility into or control over that.
Please review the privacy policy of any provider you enable.

**OpenRouter app attribution.** When you choose OpenRouter as your provider,
Cebian attaches two fixed app-identifying headers to each request
(`HTTP-Referer: https://cebian.catcat.work` and `X-Title: Cebian`) so that the
traffic is attributed to Cebian on OpenRouter's public app rankings and the
"Apps" tab of each model page. These two headers contain **no user data** —
they only mark "this request comes from Cebian" — and are sent to OpenRouter
only.

If you connect external tools via MCP (Model Context Protocol), tool arguments
are sent to those endpoints and returned content can be passed to the AI model.
The receiving services' policies likewise apply to MCP, WebDAV, search, and
browser cloud speech recognition. Their retention cannot be inferred from
Cebian's local storage or lack of an author-operated backend.

---

## 6. Chrome permissions — and why each one is needed

Cebian requests the following permissions in its manifest. Their main uses are
listed below; some browser APIs are also available to tools and authorized Skills.

| Permission | Why Cebian needs it |
| :-- | :-- |
| `sidePanel` | Render the Cebian UI in the browser's side panel. |
| `activeTab` | Read the URL, title, and content of the tab you're currently looking at, so the AI can answer questions about the page. |
| `tabs` | Enumerate open tabs so the AI knows what you have open and can switch between them when you ask. |
| `scripting` | Inject scripts into task/recording/search tabs to read page text, pick DOM elements, and execute page interactions or JavaScript. |
| `storage` | Persist settings and credentials in `chrome.storage.local`. Chats use IndexedDB `cebian`; templates, Skills, memory, and virtual files use IndexedDB `cebian-vfs`, not `chrome.storage.local`. |
| `alarms` | Schedule OAuth-token refresh checks and, if enabled, memory-organization checks; browser tools/authorized Skills can also manage alarms. |
| `offscreen` | Host an offscreen document for tasks that require a DOM/audio context the service worker can't provide (e.g. clipboard, audio). |
| `debugger` | Power page interactions, screenshots, emulation, search extraction, and enabled network recording via the Chrome DevTools Protocol, including on task-created background tabs. Chrome shows a notice while it is in use. |
| `webNavigation` | Observe navigation and inspect frames for page context, recording, and browser tasks, including background search tabs. |
| `bookmarks` | Read and modify bookmarks through browser tools during tasks or authorized Skills. |
| `history` | Query and manage browsing history through browser tools during tasks or authorized Skills. |
| `cookies` | Read, set, and remove cookies (separate from network-recorder redaction) through browser tools during tasks or authorized Skills. |
| `topSites` | Read top-visited sites through browser tools during tasks or authorized Skills. |
| `sessions` | Read and restore recently closed tabs/sessions through browser tools during tasks or authorized Skills. |
| `downloads` | Query and manage downloads through browser tools during tasks or authorized Skills. |
| `notifications` | Show desktop notifications for long-running tasks you've asked the AI to perform. |
| `clipboardRead` | Read clipboard text when gathering slash-template variables at template selection; only a referenced `{{clipboard}}` value is included in the expanded template. |
| `declarativeNetRequestWithHostAccess` | Remove the `Origin` header from extension-originated requests to enabled MCP server origins, to support those connections; not a general traffic-collection permission. |
| `webRequest` (Firefox only, optional) | Requested the first time you turn on "Network requests" for a recording in Firefox, and used only to record request and response headers, status, timing and request bodies (no response bodies) while such a recording runs. You can decline it or revoke it at any time. |
| `host_permissions: <all_urls>` | Allow page reading/interactions, task-created background search tabs, and connections to configured providers, MCP/WebDAV servers, and other feature-related sites. Not restricted to the active tab. |

---

## 7. Storage and deletion

Cebian's local working data is stored in your browser:

- **`chrome.storage.local`** — settings, API keys, OAuth tokens, custom provider
  headers, MCP configurations and credentials, and WebDAV connection credentials.
- **IndexedDB — `cebian` database** — chat sessions and message history,
  including branches, tool results, and recordings submitted with a chat.
- **IndexedDB — `cebian-vfs` database** — prompt templates, Skill packages,
  memory files, and files created or imported into the virtual filesystem.
  Recorded network HAR files are saved in each chat workspace's `recordings/`
  folder when submitted. Backing up that workspace includes its HAR files.
- **Extension-page `localStorage`** — small local caches such as the update-check
  result. This is distinct from `chrome.storage.local`.

**Cross-conversation memory.** Memory is off by default. When enabled, the AI can
save or update a profile and other durable facts from conversations without a
separate “remember this” request. Files live under `~/.cebian/memories` in the
virtual filesystem, not in your operating system's home directory. Subsequent AI
requests include the user profile and memory index within their size limits. An
oversized profile is replaced by its description or a read-file hint; an oversized
index is truncated. Additional memory content can be read through tools. Manual organization, and automatic
organization if separately enabled (off by default), send memory content to the
organization model. Turning memory off disables automatic context injection and
automatic-organization scheduling, but does not delete files or prevent explicit
file-tool access.

**Backups.** You can export an archive locally or upload it to your configured
WebDAV server. The creation dialog defaults to a **full backup, including
credentials**, with encryption **off**; partial backups let you choose categories.
Included data can cover chats/workspaces, settings, Skills/prompts, memories,
API/OAuth credentials, custom headers, MCP tokens, and WebDAV credentials.
Choosing password encryption encrypts the archive payload with AES-GCM, but the
manifest (including backup name, description, and category/count metadata) remains
readable. Without encryption, included credentials and other content are readable.
Review the scope and encryption choice before exporting, uploading, or sharing.

You can delete local data:

- **Delete a chat:** remove the session in the history panel. Independently saved
  memories and external copies are not deleted with that chat.
- **Delete memories/files:** remove the relevant files in the virtual filesystem;
  disabling memory alone is not deletion. Content already present in chat history
  or backups may remain there.
- **Delete the extension's local data:** uninstall Cebian from
  `chrome://extensions`; Chrome removes the extension's local storage, including
  its `chrome.storage` and IndexedDB data.

The author holds no server-side copy of your extension data. However, exported
archives, WebDAV snapshots, and data retained by AI or other services can exist.
Delete exported files and remote backups separately (WebDAV snapshots can be
deleted from the backup UI), and use the receiving service's procedures for its
records. Uninstalling or deleting local data does not erase those copies.

---

## 8. Children's privacy

Cebian is not directed at children under the age of 13. We do not knowingly
collect personal information from children.

---

## 9. Security

- Credentials are stored in `chrome.storage.local`, isolated by the browser per
  extension; this is not a separate password-encrypted credential vault.
- Built-in provider endpoints use HTTPS, but custom provider and WebDAV URLs
  support HTTP as well. HTTPS is not enforced for every configurable endpoint;
  use HTTPS for remote services, especially when sending credentials or content.
- Authentication follows the provider's API/OAuth protocol and any custom headers
  you configure. Credentials are not restricted to one `Authorization` header:
  OAuth exchanges also send authentication data to token endpoints. MCP and
  WebDAV use their configured credentials; credential-inclusive backups are
  another explicit way credentials can leave local extension storage.
- Recording redaction reduces exposure but is not a guarantee that a recording
  contains no sensitive data. Inspect recordings and HAR files before sharing.

Anyone with access to your unlocked browser profile may be able to read local
extension data. Protect that profile and exported backups as you would other
files containing provider credentials and personal content.

---

## 10. Changes to this policy

This policy is versioned in the public Git repository. Any material change is
recorded as a commit to `PRIVACY.md` on the `master` branch. The "Last updated"
date at the top of this document reflects the most recent change.

There is no separate notification channel — please watch the repository if you'd
like to be notified.

---

## 11. Contact

For questions, concerns, or to report a privacy issue, please open an issue on
GitHub:

<https://github.com/maotoumao/Cebian/issues>
