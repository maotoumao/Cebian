/**
 * Cebian Site — i18n (bilingual Chinese / English)
 * Language is stored in localStorage and toggled via the language button.
 */

const translations = {
  en: {
    nav: {
      features: "Features",
      install: "Install",
      github: "GitHub",
      language: "中文",
    },
    home: {
      hero: {
        badge: "Open Source · Privacy First",
        title: "Your AI assistant,\nliving in the sidebar.",
        subtitle:
          "Cebian puts a powerful AI agent right in your browser side panel. Read any page, pick elements, run tools — without ever leaving the tab you're on.",
        cta_install: "Install Now",
        cta_features: "Explore Features",
      },
      why: {
        title: "Why Cebian?",
        no_account_title: "No account required",
        no_account_desc:
          "Install and start chatting immediately. No sign-up, no email, no subscription needed.",
        private_title: "Your data stays local",
        private_desc:
          "Every conversation, prompt, and file is stored in your browser only. Nothing is ever uploaded to any server.",
        open_source_title: "Fully open source",
        open_source_desc:
          "All code is on GitHub under AGPL-3.0. Read it, modify it, run it yourself.",
      },
      features: {
        title: "Everything you need to be productive",
        subtitle: "Powerful AI tooling that fits neatly inside your browser.",
        multi_model_title: "Multi-model",
        multi_model_desc:
          "OpenAI, Anthropic, Google Gemini, GitHub Copilot, and any OpenAI-compatible endpoint via custom providers.",
        page_aware_title: "Page-aware",
        page_aware_desc:
          "Grab the current URL, title, or selected text. Use the element picker to capture any part of the page as context.",
        prompts_title: "Slash Prompts",
        prompts_desc:
          "Build a reusable prompt library. Insert dynamic variables like {{selected_text}}, {{page_url}}, or {{clipboard}} right in your templates.",
        skills_title: "Skills",
        skills_desc:
          "Package multi-step workflows or domain knowledge into reusable Skills that the AI loads on demand.",
        mcp_title: "MCP Tools",
        mcp_desc:
          "Built-in Model Context Protocol client. Drop in external tool servers and they just work.",
        mobile_title: "Mobile Emulation",
        mobile_desc:
          "Toggle mobile-device emulation on the active tab to debug responsive pages without switching tools.",
        privacy_title: "Privacy First",
        privacy_desc:
          "All conversations, prompts, and files stay in your browser — zero telemetry, zero cloud sync.",
        screenshot_title: "Screenshots & Files",
        screenshot_desc:
          "Attach screenshots, images, or files directly in the chat to give the AI full visual context.",
      },
      cta: {
        title: "Ready to try Cebian?",
        subtitle:
          "Install in under a minute. No account, no subscription, no data collection.",
        button: "Get Cebian",
      },
      footer: {
        tagline: "AI assistant in your browser side panel.",
        links_title: "Links",
        legal_title: "Legal",
        license: "License (AGPL-3.0)",
        contributing: "Contributing",
        made_with: "Made with ❤️",
      },
    },
    features: {
      page_title: "Features & Settings",
      page_subtitle:
        "A complete guide to every feature in Cebian, including detailed explanations of all settings.",
      chat_section: "Chat Interface",
      chat_desc:
        "The main chat area is where you interact with the AI. Select a model from the model picker at the top, type your message, and press Enter or click Send.",
      chat_attach_title: "Attachments",
      chat_attach_desc:
        "Click the paperclip icon to attach images or files. You can also paste images directly from the clipboard. Attachments are sent to the AI as context.",
      chat_screenshot_title: "Page Screenshot",
      chat_screenshot_desc:
        "Capture a screenshot of the current tab and attach it to your message so the AI can see exactly what you see.",
      chat_pick_title: "Element Picker",
      chat_pick_desc:
        "Click the cursor icon to enter pick mode. Then click any element on the page to capture its HTML and text as context. Useful for debugging or explaining specific UI elements.",
      chat_mobile_title: "Mobile Emulation",
      chat_mobile_desc:
        "Toggle mobile-device emulation on the active tab. The page reloads in a mobile viewport so you can test responsive layouts side-by-side with the AI.",
      chat_prompt_title: "Slash Prompts",
      chat_prompt_desc:
        "Type / in the chat input to open the prompt picker. Select a saved prompt to insert it into the input with all template variables filled in.",
      settings_section: "Settings",
      settings_desc:
        "Open settings by clicking the gear icon at the bottom of the side panel. Settings are organized into the following sections.",
      providers_title: "Providers",
      providers_desc:
        "Configure which AI providers and models are available to you. Cebian supports three categories of providers:",
      providers_oauth:
        "OAuth providers (GitHub Copilot, OpenAI Codex via ChatGPT, Google Gemini CLI) — sign in once with your existing subscription.",
      providers_apikey:
        "API Key providers (OpenAI, Anthropic, Google Gemini) — paste your API key to unlock all models from that provider.",
      providers_custom:
        "Custom OpenAI-compatible providers — configure any endpoint that speaks the OpenAI API (e.g. Ollama, LM Studio, or a self-hosted proxy).",
      instructions_title: "Instructions",
      instructions_desc:
        "Write custom instructions that are appended to the default system prompt. Use this to adjust the AI's language, tone, or persona. For example:",
      instructions_example:
        '- Reply in English\n- Keep answers concise\n- Default to TypeScript when discussing code',
      instructions_note:
        "Instructions cannot override tool protocols or built-in safety rules. Maximum 2,000 characters.",
      prompts_title: "Prompts",
      prompts_desc:
        "Build a library of reusable prompt templates. Trigger any prompt by typing / in the chat input. Templates support these dynamic variables:",
      prompts_vars: [
        "{{selected_text}} — currently selected text on the active page",
        "{{page_url}} — full URL of the active page",
        "{{page_title}} — title of the active page",
        "{{date}} — today's date",
        "{{clipboard}} — current clipboard content",
      ],
      skills_title: "Skills",
      skills_desc:
        "Skills are multi-file instruction packs following the agentskills.io specification. The AI can load and run them on demand to handle complex, domain-specific workflows. Each skill is a folder of Markdown and config files that teach the AI how to do a specific task.",
      mcp_title: "MCP Servers",
      mcp_desc:
        "Connect external Model Context Protocol (MCP) servers to expose their tools to the agent. Click \"Add MCP server\" and fill in:",
      mcp_fields: [
        "Name — a short identifier for this server",
        "Transport — Streamable HTTP (recommended) or SSE",
        "URL — the server's endpoint URL",
        "Authentication — None, or Bearer token",
        "Custom headers — optional HTTP headers to include with each request",
      ],
      mcp_status_title: "Server status indicators:",
      mcp_statuses: [
        "Idle — server is configured but not yet called",
        "Connected — last tool call succeeded",
        "Disconnected — server could not be reached",
        "Reconnecting — automatic retry in progress",
        "Unavailable — circuit breaker open after repeated failures",
        "Disabled — server is toggled off",
      ],
      advanced_title: "Advanced",
      advanced_desc:
        "Fine-tune agent behaviour with low-level knobs.",
      advanced_maxrounds_title: "Max conversation rounds",
      advanced_maxrounds_desc:
        "Sets the maximum number of message pairs kept in the context window before older messages are truncated. Default is 200, range 1–1,000. Lower values save tokens; higher values preserve more history.",
      about_title: "About",
      about_desc:
        "Shows the current extension version and links to the GitHub repository, license, and feedback.",
    },
    install: {
      page_title: "Install Cebian",
      page_subtitle:
        "Cebian is not yet listed on the Chrome Web Store. Install it directly from the latest GitHub release in a few easy steps.",
      step1_title: "Download the latest release",
      step1_desc:
        'Go to the <a href="https://github.com/maotoumao/Cebian/releases/latest" target="_blank" rel="noopener noreferrer" class="text-blue-600 underline hover:text-blue-800">GitHub Releases page</a> and download the <code class="bg-gray-100 px-1 rounded">cebian-chrome.zip</code> file from the latest release.',
      step2_title: "Unzip the file",
      step2_desc:
        "Extract the downloaded <code class=\"bg-gray-100 px-1 rounded\">.zip</code> file to a folder on your computer. Remember where you put it — Chrome needs to access this folder.",
      step3_title: "Open Chrome Extensions",
      step3_desc:
        'Navigate to <code class="bg-gray-100 px-1 rounded">chrome://extensions</code> in your Chrome browser, or open the Chrome menu → More tools → Extensions.',
      step4_title: "Enable Developer Mode",
      step4_desc:
        'Toggle the <strong>Developer mode</strong> switch in the top-right corner of the Extensions page. This unlocks the ability to install unpacked extensions.',
      step5_title: 'Click "Load unpacked"',
      step5_desc:
        'Click the <strong>Load unpacked</strong> button that appears after enabling Developer mode, then select the folder you extracted in step 2.',
      step6_title: "Open the side panel",
      step6_desc:
        'Cebian is now installed! Click the Cebian icon in the Chrome toolbar, or use the keyboard shortcut to open the side panel. Configure your first AI provider in Settings to get started.',
      tip_title: "💡 Tip: Updating Cebian",
      tip_desc:
        "When a new release is available, download the new zip, extract it to the same folder (overwriting the old files), and click the reload button on the Cebian card in chrome://extensions.",
      requirements_title: "System requirements",
      requirements: [
        "Google Chrome 116 or later (Side Panel API required)",
        "macOS, Windows, or Linux",
        "An API key or OAuth subscription for at least one AI provider",
      ],
      next_steps_hint: "After installing, explore all features and settings.",
    },
  },
  zh: {
    nav: {
      features: "功能",
      install: "安装",
      github: "GitHub",
      language: "English",
    },
    home: {
      hero: {
        badge: "开源 · 隐私优先",
        title: "你的 AI 助手，\n就在侧边栏。",
        subtitle:
          "Cebian 把强大的 AI agent 直接放到浏览器侧边栏。阅读页面、选取元素、调用工具——无需离开你正在浏览的标签页。",
        cta_install: "立即安装",
        cta_features: "探索功能",
      },
      why: {
        title: "为什么选择 Cebian？",
        no_account_title: "无需账号",
        no_account_desc:
          "安装即用，无需注册、邮箱或订阅。",
        private_title: "数据留在本地",
        private_desc:
          "所有对话、Prompt、附件都只存储在你自己的浏览器里，不会上传到任何服务器。",
        open_source_title: "完全开源",
        open_source_desc:
          "全部代码托管在 GitHub，基于 AGPL-3.0 协议，可自由阅读、修改、自部署。",
      },
      features: {
        title: "高效工作所需的一切",
        subtitle: "强大的 AI 工具，整洁地嵌入浏览器侧边栏。",
        multi_model_title: "多模型支持",
        multi_model_desc:
          "支持 OpenAI、Anthropic、Google Gemini、GitHub Copilot，以及任意 OpenAI 兼容协议的自定义服务端点。",
        page_aware_title: "页面感知",
        page_aware_desc:
          "一键获取当前 URL、标题或选中文本。使用元素拾取器捕捉页面任意部分作为上下文。",
        prompts_title: "Slash 提示词",
        prompts_desc:
          "构建可复用的提示词库。在模板中插入动态变量，如 {{selected_text}}、{{page_url}}、{{clipboard}}。",
        skills_title: "技能",
        skills_desc:
          "将多步工作流或领域知识封装为可复用的技能包，AI 可按需加载。",
        mcp_title: "MCP 工具",
        mcp_desc:
          "内置 Model Context Protocol 客户端。接入外部工具服务器，即插即用。",
        mobile_title: "移动端模拟",
        mobile_desc:
          "对当前标签页开启移动设备模拟，无需切换工具即可调试响应式页面。",
        privacy_title: "隐私优先",
        privacy_desc:
          "所有对话、提示词和文件都留在浏览器本地——零遥测、零云同步。",
        screenshot_title: "截图与文件",
        screenshot_desc:
          "直接在聊天中附加截图、图片或文件，让 AI 获得完整的视觉上下文。",
      },
      cta: {
        title: "准备好尝试 Cebian 了吗？",
        subtitle:
          "不到一分钟即可安装完成，无需账号、订阅，也不收集任何数据。",
        button: "获取 Cebian",
      },
      footer: {
        tagline: "浏览器侧边栏的 AI 助手。",
        links_title: "链接",
        legal_title: "法律",
        license: "开源协议 (AGPL-3.0)",
        contributing: "参与贡献",
        made_with: "用 ❤️ 制作",
      },
    },
    features: {
      page_title: "功能与设置",
      page_subtitle:
        "Cebian 所有功能的完整指南，包括设置页中每个选项的详细说明。",
      chat_section: "聊天界面",
      chat_desc:
        "主聊天区是你与 AI 交互的地方。从顶部的模型选择器选择模型，输入消息后按 Enter 或点击发送。",
      chat_attach_title: "附件",
      chat_attach_desc:
        "点击回形针图标添加图片或文件，也可以直接从剪贴板粘贴图片。附件会作为上下文发送给 AI。",
      chat_screenshot_title: "页面截图",
      chat_screenshot_desc:
        "截取当前标签页的截图并附加到消息中，让 AI 看到你看到的内容。",
      chat_pick_title: "元素拾取器",
      chat_pick_desc:
        "点击光标图标进入拾取模式，然后点击页面上的任意元素，其 HTML 和文本将作为上下文附加到消息中。适合调试或解释特定 UI 元素。",
      chat_mobile_title: "移动端模拟",
      chat_mobile_desc:
        "对当前标签页开启移动设备模拟。页面将在移动视口中重新加载，方便你与 AI 一起调试响应式布局。",
      chat_prompt_title: "Slash 提示词",
      chat_prompt_desc:
        "在聊天输入框中输入 / 打开提示词选择器，选择已保存的提示词后，模板变量将自动填充。",
      settings_section: "设置",
      settings_desc:
        "点击侧边栏底部的齿轮图标打开设置。设置分为以下几个部分。",
      providers_title: "提供商",
      providers_desc:
        "配置可用的 AI 提供商和模型。Cebian 支持三类提供商：",
      providers_oauth:
        "OAuth 提供商（GitHub Copilot、OpenAI Codex via ChatGPT、Google Gemini CLI）——使用现有订阅一次性登录。",
      providers_apikey:
        "API Key 提供商（OpenAI、Anthropic、Google Gemini）——粘贴 API Key 即可使用该提供商的所有模型。",
      providers_custom:
        "自定义 OpenAI 兼容提供商——配置任意支持 OpenAI API 的端点（如 Ollama、LM Studio 或自托管代理）。",
      instructions_title: "指引",
      instructions_desc:
        "编写自定义指引，追加到默认系统提示之后。用于调整 AI 的语言、风格或角色。例如：",
      instructions_example:
        '- 用中文回复\n- 回答尽量简洁\n- 讨论代码时默认使用 TypeScript',
      instructions_note:
        "指引无法覆盖工具协议或内置安全规则。最多 2,000 个字符。",
      prompts_title: "提示词",
      prompts_desc:
        "构建可复用的提示词模板库。在聊天输入框中输入 / 触发任意提示词。模板支持以下动态变量：",
      prompts_vars: [
        "{{selected_text}} — 当前页面上选中的文本",
        "{{page_url}} — 当前页面的完整 URL",
        "{{page_title}} — 当前页面的标题",
        "{{date}} — 今天的日期",
        "{{clipboard}} — 剪贴板内容",
      ],
      skills_title: "技能",
      skills_desc:
        "技能是遵循 agentskills.io 规范的多文件指令包。AI 可以按需加载并执行它们，以处理复杂的领域工作流。每个技能是一个包含 Markdown 和配置文件的文件夹，用于教 AI 如何完成特定任务。",
      mcp_title: "MCP 服务器",
      mcp_desc:
        "接入外部 Model Context Protocol (MCP) 服务器，将其工具暴露给 agent 使用。点击「添加 MCP 服务器」并填写以下信息：",
      mcp_fields: [
        "名称 — 此服务器的简短标识符",
        "传输协议 — Streamable HTTP（推荐）或 SSE",
        "URL — 服务器的端点 URL",
        "认证方式 — 无，或 Bearer Token",
        "自定义 Headers — 每次请求中附加的可选 HTTP 请求头",
      ],
      mcp_status_title: "服务器状态说明：",
      mcp_statuses: [
        "等待首次调用 — 已配置但尚未被调用",
        "已连接 — 最近一次工具调用成功",
        "未连接 — 无法访问服务器",
        "重连中 — 正在自动重试",
        "暂时不可用 — 多次失败后熔断器已打开",
        "已禁用 — 服务器已被手动关闭",
      ],
      advanced_title: "高级",
      advanced_desc: "通过底层参数精细调整 agent 行为。",
      advanced_maxrounds_title: "最大对话轮数",
      advanced_maxrounds_desc:
        "设置上下文窗口中保留的最大消息对数，超出后早期消息会被截断。默认值为 200，范围 1–1,000。较小的值节省 token，较大的值保留更多历史记录。",
      about_title: "关于",
      about_desc:
        "显示当前扩展版本，并提供 GitHub 仓库、许可证和反馈的链接。",
    },
    install: {
      page_title: "安装 Cebian",
      page_subtitle:
        "Cebian 尚未上架 Chrome 应用商店。请按以下步骤从最新 GitHub Release 直接安装。",
      step1_title: "下载最新 Release",
      step1_desc:
        '前往 <a href="https://github.com/maotoumao/Cebian/releases/latest" target="_blank" rel="noopener noreferrer" class="text-blue-600 underline hover:text-blue-800">GitHub Releases 页面</a>，从最新 Release 中下载 <code class="bg-gray-100 px-1 rounded">cebian-chrome.zip</code> 文件。',
      step2_title: "解压文件",
      step2_desc:
        '将下载的 <code class="bg-gray-100 px-1 rounded">.zip</code> 文件解压到电脑上的某个文件夹。请记住存放位置——Chrome 需要持续访问此文件夹。',
      step3_title: "打开 Chrome 扩展页",
      step3_desc:
        '在 Chrome 中访问 <code class="bg-gray-100 px-1 rounded">chrome://extensions</code>，或点击 Chrome 菜单 → 更多工具 → 扩展程序。',
      step4_title: "启用开发者模式",
      step4_desc:
        '点击扩展程序页面右上角的<strong>开发者模式</strong>开关。这将解锁安装未打包扩展的能力。',
      step5_title: '点击「加载已解压的扩展程序」',
      step5_desc:
        '启用开发者模式后，点击出现的<strong>加载已解压的扩展程序</strong>按钮，然后选择第 2 步中解压的文件夹。',
      step6_title: "打开侧边栏",
      step6_desc:
        'Cebian 已安装！点击 Chrome 工具栏中的 Cebian 图标或使用快捷键打开侧边栏。在设置中配置第一个 AI 提供商即可开始使用。',
      tip_title: "💡 提示：更新 Cebian",
      tip_desc:
        "有新版本时，下载新的 zip 文件并解压到同一文件夹（覆盖旧文件），然后在 chrome://extensions 的 Cebian 卡片上点击刷新按钮即可。",
      requirements_title: "系统要求",
      requirements: [
        "Google Chrome 116 或更高版本（需要侧边栏 API）",
        "macOS、Windows 或 Linux",
        "至少一个 AI 提供商的 API Key 或 OAuth 订阅",
      ],
      next_steps_hint: "安装完成后，探索所有功能与设置。",
    },
  },
};

let currentLang = localStorage.getItem("cebian_lang") || "en";

function setLang(lang) {
  currentLang = lang;
  localStorage.setItem("cebian_lang", lang);
  applyTranslations();
  updateLangButton();
}

function t(keyPath) {
  const keys = keyPath.split(".");
  let obj = translations[currentLang];
  for (const k of keys) {
    if (obj === undefined) return keyPath;
    obj = obj[k];
  }
  return obj ?? keyPath;
}

/**
 * Safely render trusted HTML translation strings by building a real DOM tree
 * without using innerHTML anywhere. This avoids XSS even if translation values
 * were somehow tainted. Only whitelisted tags are preserved; everything else
 * is reduced to its text content.
 */
const ALLOWED_TAGS = new Set(["A", "CODE", "STRONG", "EM", "BR", "SPAN"]);

function buildSafeFragment(sourceNode) {
  const frag = document.createDocumentFragment();
  for (const child of sourceNode.childNodes) {
    if (child.nodeType === Node.TEXT_NODE) {
      frag.appendChild(document.createTextNode(child.textContent));
    } else if (child.nodeType === Node.ELEMENT_NODE) {
      if (ALLOWED_TAGS.has(child.tagName)) {
        const el = document.createElement(child.tagName.toLowerCase());
        for (const attr of child.attributes) {
          // Never copy event-handler attributes
          if (!attr.name.startsWith("on")) {
            el.setAttribute(attr.name, attr.value);
          }
        }
        el.appendChild(buildSafeFragment(child));
        frag.appendChild(el);
      } else {
        // Disallowed tag — preserve text only
        frag.appendChild(document.createTextNode(child.textContent));
      }
    }
  }
  return frag;
}

function setSafeHtml(target, html) {
  const parsed = new DOMParser().parseFromString(html, "text/html");
  target.replaceChildren(buildSafeFragment(parsed.body));
}

function applyTranslations() {
  document.querySelectorAll("[data-i18n]").forEach((el) => {
    const key = el.getAttribute("data-i18n");
    const val = t(key);
    if (typeof val === "string") {
      if (el.getAttribute("data-i18n-html") === "true") {
        setSafeHtml(el, val);
      } else {
        el.textContent = val;
      }
    }
  });

  // Handle arrays rendered as lists — use DOM manipulation, not innerHTML
  document.querySelectorAll("[data-i18n-list]").forEach((ul) => {
    const key = ul.getAttribute("data-i18n-list");
    const arr = t(key);
    if (Array.isArray(arr)) {
      ul.innerHTML = "";
      arr.forEach((item) => {
        const li = document.createElement("li");
        li.textContent = item;
        ul.appendChild(li);
      });
    }
  });

  // Update document lang attribute
  document.documentElement.lang = currentLang === "zh" ? "zh-CN" : "en";
}

function updateLangButton() {
  const el = document.getElementById("lang-text");
  if (el) {
    el.textContent = t("nav.language");
  }
}

function toggleLang() {
  setLang(currentLang === "en" ? "zh" : "en");
}

document.addEventListener("DOMContentLoaded", () => {
  applyTranslations();
  updateLangButton();

  const btn = document.getElementById("lang-toggle");
  if (btn) btn.addEventListener("click", toggleLang);
});
