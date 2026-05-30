// 构建期 shim：替换 `@earendil-works/pi-ai` 的
// `dist/utils/oauth/anthropic.js` 模块。
//
// 为什么需要这个文件
// ------------------
// `@earendil-works/pi-ai/oauth` 自带一套 Anthropic OAuth 登录流程，其
// CLIENT_ID 是一段 base64 字符串字面量、通过 `atob` 解码得到。Chrome
// Web Store 审核会把「base64 字面量经 atob 解码」这种模式判定为代码
// 混淆（违规 id：Red Titanium），即便 Cebian 从不调用任何 Anthropic
// OAuth 代码路径 —— 我们在 `lib/oauth.ts` 中只用到 pi-ai 的 GitHub
// Copilot 和 OpenAI Codex 辅助函数。Anthropic 模块被打包进来，仅仅
// 是因为 pi-ai 的 `utils/oauth/index.js` 在顶层把它塞进了
// `BUILT_IN_OAUTH_PROVIDERS` 数组（顶层副作用 → tree-shaking 无效）。
//
// 接入方式：`wxt.config.ts` 中的一个 Vite `resolveId` 插件会把 pi-ai
// `utils/oauth/index.js` 里对 `./anthropic.js` 的相对导入重定向到本
// 文件。原始模块 —— 包括那段 base64 字符串和 Node 专用的
// `http.createServer` 回调流程 —— 都不会进入 bundle。
//
// 导出面
// ------
// pi-ai 的 `utils/oauth/index.js` 从 `./anthropic.js` 再导出三个命名：
// `anthropicOAuthProvider`、`loginAnthropic`、`refreshAnthropicToken`。
// 我们给这三个都提供「惰性 stub」。它们需要同时满足：
//   1. 模块求值期的使用 —— pi-ai 的 index.js 会执行
//      `new Map(BUILT_IN_OAUTH_PROVIDERS.map((p) => [p.id, p]))`，因此
//      `anthropicOAuthProvider` 必须是一个带字符串 `.id` 的对象。
//   2. 运行期 —— 万一这些 handler 被调用，要明确以错误终止，避免悄无
//      声息地走到无效路径。Cebian 自身的代码不会调用它们。
//
// 如果将来 Cebian 真的要支持 Anthropic OAuth，需要：去掉
// `wxt.config.ts` 里那个 resolveId 插件；并且单独评估是否要上
// `claude.ai/oauth/authorize` 这条流程 —— 当前 pi-ai 实现是借用 Claude
// Code CLI 的 client ID 来跑会员登录，属于另一个合规问题，跟这次过审
// 是两件事。

const NOT_SUPPORTED_MESSAGE =
  'Anthropic OAuth is not supported in Cebian (pi-ai anthropic module is shimmed out at build time).';

export async function loginAnthropic() {
  throw new Error(NOT_SUPPORTED_MESSAGE);
}

export async function refreshAnthropicToken() {
  throw new Error(NOT_SUPPORTED_MESSAGE);
}

export const anthropicOAuthProvider = {
  id: 'anthropic',
  name: 'Anthropic (disabled)',
  // 反映 shim 自身语义（没有回调服务器），不是 upstream 的值 —— upstream 是 `true`。
  usesCallbackServer: false,
  async login() {
    throw new Error(NOT_SUPPORTED_MESSAGE);
  },
  async refreshToken() {
    throw new Error(NOT_SUPPORTED_MESSAGE);
  },
  getApiKey() {
    throw new Error(NOT_SUPPORTED_MESSAGE);
  },
};
