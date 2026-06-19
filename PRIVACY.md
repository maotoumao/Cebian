# Cebian Privacy Policy

English | **[简体中文](PRIVACY.zh-CN.md)**

**Last updated:** 2026-05-14

## TL;DR

**Cebian has no servers. We never see your data.**

Cebian is an open-source Chrome extension ([AGPL-3.0](./LICENSE)) that runs entirely
in your browser. Everything you type, every page it reads, and every API key you
configure stays on your device. The only network traffic Cebian initiates goes
**directly from your browser to the AI provider you yourself configured** — over
HTTPS, using your own API key or OAuth token. Nothing is routed through any
server operated by the Cebian author.

If you uninstall the extension, all locally stored data goes with it.

---

## 1. Scope

This policy describes how the Cebian browser extension (hereafter "Cebian", "the
extension", or "we") handles user data.

It does **not** cover:

- The privacy practices of the AI providers you configure (OpenAI, Anthropic,
  Google, etc.) — those are governed by their own privacy policies.
- The privacy practices of any MCP (Model Context Protocol) server you choose to
  connect to.
- Any fork, repackage, or self-hosted build of Cebian that you or a third party
  modifies.

Source code: <https://github.com/maotoumao/Cebian>

---

## 2. Data we process

Cebian processes the following categories of data **only when you actively trigger
the relevant feature**. Nothing is collected in the background.

| Data category | Specifically | When it's accessed | Where it goes |
| :-- | :-- | :-- | :-- |
| **Website content** | URL, page title, body text, DOM elements you pick | When you send a message to the AI | Your local browser → the AI provider you chose |
| **User activity** | Active tab URL/title, text you've selected, plus the URL and title of every other tab you have open (so the AI knows what's open) | When you send a message to the AI | Your local browser → the AI provider you chose |
| **Clipboard content** | System clipboard, read only when a prompt template references the `{{clipboard}}` variable | When you submit such a template | Your local browser → the AI provider you chose |
| **Browsing history** | Read via `chrome.history` | Only when you explicitly ask the AI to query history | Your local browser → the AI provider you chose |
| **Bookmarks** | Read/write via `chrome.bookmarks` | Only when you explicitly ask the AI to view or modify bookmarks | Your local browser → the AI provider you chose |
| **Cookies** | Read via `chrome.cookies` | Only when you explicitly ask the AI to inspect cookies for a site | Your local browser → the AI provider you chose |
| **Top sites** | Read via `chrome.topSites` | Only when you explicitly ask the AI for them | Your local browser → the AI provider you chose |
| **Recently closed tabs / sessions** | Read via `chrome.sessions` | Only when you explicitly ask the AI for them | Your local browser → the AI provider you chose |
| **Downloads** | Read via `chrome.downloads` | Only when you explicitly ask the AI to query downloads | Your local browser → the AI provider you chose |
| **Recorded interaction sessions** | Clicks, keypresses (including special keys like Enter/Backspace), typed text, scrolls, page navigations, and DOM-element selectors on the tabs you are recording | Only while you have explicitly started a recording from the Cebian UI | Held in memory during recording; when you stop, attached to a chat message and persisted with that session in IndexedDB |
| **Microphone audio (voice input)** | Live microphone audio, used only to transcribe speech into the chat input | Only while you have explicitly started voice input from the composer's mic button | The **audio** is processed entirely **on-device** by the browser's built-in speech engine and **never leaves your device** — it is not sent to any server, including AI providers. The resulting **text** appears in the input for you to review; by default it is **not sent anywhere**. If you enable AI correction (an optional feature), that transcribed text is sent to your configured AI provider for cleanup, just like a normal message — the audio itself still never leaves your device |
| **API keys & OAuth tokens** | Credentials you enter for AI providers | When you enter or update them in Settings | Stored locally in `chrome.storage.local`; sent only as the `Authorization` header to the matching provider's API |
| **MCP server configurations** | URLs, custom headers, and bearer tokens for any Model Context Protocol server you add | When you add or edit one in Settings | Stored locally in `chrome.storage.local`; sent only to the MCP server you configured |
| **Chat history, settings** | Conversations, your preferences | Continuously, as you use the extension | Stored locally in IndexedDB (`cebian` database) and `chrome.storage.local` |
| **Prompt templates, Skills, files in the virtual FS** | Prompt templates and Skill packages you author or import; files in the in-extension virtual filesystem | Continuously, as you use the extension | Stored locally in a separate IndexedDB database (`cebian-vfs`) |

We do **not** collect or process: your name, email, account information, payment
information, IP address, device identifiers, browser fingerprint, or any
analytics/telemetry events.

---

## 3. How data flows

```
┌─────────────────────────────────────────┐
│  Your browser (local only)              │
│                                         │
│   ┌───────────────────────────────┐     │
│   │  Cebian extension             │     │
│   │  • IndexedDB (chats, skills)  │     │
│   │  • chrome.storage (settings,  │     │
│   │    API keys)                  │     │
│   └────────────────┬──────────────┘     │
│                    │                    │
│                    │ user sends         │
│                    │ a message          │
│                    ▼                    │
│   ┌───────────────────────────────┐     │
│   │  Reads relevant context       │     │
│   │  (page text, selection, etc.) │     │
│   └────────────────┬──────────────┘     │
└────────────────────┼────────────────────┘
                     │ HTTPS (your API key)
                     ▼
┌─────────────────────────────────────────┐
│  The AI provider YOU configured         │
│  (OpenAI / Anthropic / Google / xAI /   │
│   Groq / OpenRouter / Mistral / your    │
│   own OpenAI-compatible endpoint / …)   │
└─────────────────────────────────────────┘
```

The Cebian author operates **no server** of any kind. There is no proxy, no
analytics endpoint, no error reporter, no telemetry pings.

One narrow exception, fully disclosed: when you open **Settings → About**, the
extension fetches the latest release tag from
`https://api.github.com/repos/maotoumao/Cebian/releases/latest` to tell you
whether an update is available. The result is cached for 6 hours. **No user
data** is sent in that request — but, as with any HTTP request, GitHub may log
your IP address and user-agent. Extension binary updates themselves are
delivered by the Chrome Web Store, not by us.

---

## 4. What we do NOT do

- ❌ We do not run any backend server that receives your data.
- ❌ We do not collect telemetry, analytics, crash reports, or usage statistics.
- ❌ We do not display ads.
- ❌ We do not sell, rent, share, or transfer your data to any third party other
  than the AI provider you yourself configured.
- ❌ We do not use your data to train any model.
- ❌ We do not require you to create an account or log in.
- ❌ We do not read or transmit page content unless you actively send a message.

---

## 5. Third-party AI providers

When you send a message, Cebian transmits the request directly from your browser
to the API endpoint of the provider you chose. Cebian supports, among others:

- OpenAI, Anthropic, Google Gemini, xAI, Groq, OpenRouter, DeepSeek, Mistral,
  MiniMax, MiniMax (CN), Kimi, zAI
- GitHub Copilot, OpenAI Codex (via OAuth)
- Any custom OpenAI-compatible endpoint you add yourself (including your own
  self-hosted models)

Once data leaves your browser, the receiving provider's privacy policy applies.
Whether they retain, log, or use your input for model training is **entirely
governed by their terms** — Cebian has no visibility into or control over that.
Please review the privacy policy of any provider you enable.

If you connect external tools via MCP (Model Context Protocol), the same applies
to those endpoints.

---

## 6. Chrome permissions — and why each one is needed

Cebian requests the following permissions in its manifest. Each is used only for
the purpose stated below.

| Permission | Why Cebian needs it |
| :-- | :-- |
| `sidePanel` | Render the Cebian UI in the browser's side panel. |
| `activeTab` | Read the URL, title, and content of the tab you're currently looking at, so the AI can answer questions about the page. |
| `tabs` | Enumerate open tabs so the AI knows what you have open and can switch between them when you ask. |
| `scripting` | Inject content scripts into the active tab to read page text, pick DOM elements, and (when you allow it) execute the JavaScript snippets the AI proposes. |
| `storage` | Persist your settings, prompt templates, Skills, and API keys in `chrome.storage.local`. |
| `alarms` | Run the periodic OAuth-token refresh check (every 30 min) so logged-in providers like GitHub Copilot stay valid. |
| `offscreen` | Host an offscreen document for tasks that require a DOM/audio context the service worker can't provide (e.g. clipboard, audio). |
| `debugger` | Power advanced page interactions via the Chrome DevTools Protocol (e.g. mobile-device emulation, screenshots, network capture) — only on tabs you actively work with. |
| `webNavigation` | Detect navigation events on the active tab so context (URL, title) stays in sync with what you're looking at. |
| `bookmarks` | Read and write your bookmarks **only** when you explicitly ask the AI to manage them. |
| `history` | Query your browsing history **only** when you explicitly ask the AI to look something up in it. |
| `cookies` | Read cookies **only** when you explicitly ask the AI to inspect a site's cookies (e.g. for debugging). |
| `topSites` | Read your top-visited sites **only** when you explicitly ask the AI to list them. |
| `sessions` | Read recently closed tabs/sessions **only** when you explicitly ask the AI to recover them. |
| `downloads` | Query and manage downloads **only** when you explicitly ask the AI to. |
| `notifications` | Show desktop notifications for long-running tasks you've asked the AI to perform. |
| `clipboardRead` | Read the system clipboard **only** when you submit a prompt template that includes the `{{clipboard}}` variable. |
| `host_permissions: <all_urls>` | The AI can be asked about **any** website you visit; without all-URL host access, Cebian could not read or assist on arbitrary sites. Host access is used solely to read/interact with the tab you're working on, never to scan sites in the background. |

---

## 7. Storage and deletion

All data Cebian creates is stored locally in your browser, specifically:

- **`chrome.storage.local`** — settings, API keys, OAuth tokens, MCP server
  configurations (including bearer tokens).
- **IndexedDB — `cebian` database** — chat sessions and message history
  (including any recorded interaction sessions you've attached to a chat).
- **IndexedDB — `cebian-vfs` database** — prompt templates, Skill packages, and
  any files you create or import into Cebian's virtual filesystem.

You can delete this data at any time:

- **Delete a single chat:** open the history panel and remove the session.
- **Delete all data:** uninstall Cebian from `chrome://extensions`. Chrome will
  remove both the `chrome.storage` and IndexedDB data associated with the
  extension.

Because the author runs no server, there is **no remote copy** to request
deletion of.

---

## 8. Children's privacy

Cebian is not directed at children under the age of 13. We do not knowingly
collect personal information from children.

---

## 9. Security

- API keys and OAuth tokens are stored in `chrome.storage.local`, which is
  sandboxed per-extension by Chrome.
- All network requests to AI providers are made over HTTPS.
- Cebian itself does not transmit credentials anywhere other than the
  `Authorization` header of the matching provider's API.

That said, anyone with physical access to your unlocked computer profile could
read `chrome.storage.local`. Treat the device the same way you'd treat any
machine that has your AI provider's keys saved.

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
