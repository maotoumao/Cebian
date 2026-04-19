# Blocking Overlay Detection in `read_page` outline

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在 `read_page` 的 `outline` 模式下精准检测 "blocking overlay"（登录弹窗、全屏遮罩、抽屉等会拦截用户/agent 操作的浮层），把结果作为显著的 header 块拼到 outline 输出顶部，让模型在决策前就能看到。

**Background:** 小模型（如 gpt-5.4-nano）在处理被登录弹窗遮挡的页面时，经常意识不到当前有阻塞性遮罩，导致它"对着遮罩点搜索按钮"。outline 当前只输出 DOM 结构，把 modal 和正文同级排列，没有遮挡信号。

**Approach:** 多信号 + 硬门槛 + 加权评分。在已有的 `extractOutline` 注入脚本里追加一个 `detectOverlays()` 函数，复用同一次 `executeScript`，零额外 IPC，纯只读不干扰页面。

**Tech Stack:** 现有 `chrome.scripting.executeScript` (isolated world，CSP 豁免)；纯 DOM 只读 API（`elementFromPoint` / `getBoundingClientRect` / `getComputedStyle`）。

---

## 文件结构

### 修改文件
- `lib/tools/read-page.ts` — 新增页面内函数 `detectOverlays()`，在 `extractOutline` 全页扫描分支拼接结果

### 不改动
- `lib/page-context.ts` — 这次先不动，遮罩信息只走 outline；待算法验证后再决定是否扩展到每次 prompt 的 context
- `lib/tools/interact.ts` — 失败诊断是后续独立优化项
- 系统 prompt — 输出格式自解释，不依赖额外提示

---

## 算法规格

### 硬性条件 A（全部满足才进入加权）

候选元素必须：
1. `position` ∈ `{fixed, absolute, sticky}`
2. `coverage = (rect.w * rect.h) / (vw * vh) >= 0.15`
3. 在 5 个采样点（中心 + 四个 1/3 分位点）中至少 **2** 个被它本身或其后代命中（`elementFromPoint`）
4. 可见：`display !== 'none'` 且 `visibility !== 'hidden'` 且 `opacity > 0.1` 且 `pointerEvents !== 'none'`

### 加权信号 B–H（满足任一加分；阈值见下）

| 信号 | 分数 | 判定 |
|---|---|---|
| B. 语义角色 | +3 | `role="dialog"` / `role="alertdialog"` / `aria-modal="true"` / `<dialog open>` |
| C. 命名特征 | +2 | id/class 匹配 `/(?:^|[-_ ])(modal|dialog|overlay|popup|mask|backdrop|login|signin|sign-?up|register|consent|gdpr|cookie|paywall|lightbox)(?:[-_ ]|$)/i` |
| D. 焦点被困 | +2 | `el.contains(document.activeElement)` 且 `activeElement !== body && !== documentElement` |
| E. body 滚动锁 | +1 | `getComputedStyle(body).overflow === 'hidden'` 或 `documentElement` 同 |
| F. backdrop 特征 | +2 | 自身或全屏 fixed 兄弟节点 `backgroundColor` alpha > 0.3 且覆盖 ≥ 80% |
| G. 高 z-index | +1 | `zIndex >= 1000` |
| H. 全屏覆盖 | +2 | `coverage >= 0.6` |

**判定规则：**
- 加权总分 `>= 3` → `blocking`
- 加权总分 `>= 5` → `blocking (high confidence)`

### Cookie / Notice 旁路规则（不算 blocking，单独提示）

满足全部条件：
- `position: fixed`
- 贴底（`rect.bottom >= vh - 10`）或贴顶（`rect.top <= 10`）
- 命名匹配 `/(?:cookie|consent|gdpr|notice|banner)/i`
- 高度 `>= 60px`
- 不满足 blocking 阈值

→ 输出 `[i] Notice bar detected (non-blocking)` 行。

### 输出格式

**未检测到 → 不输出额外内容**（保持 outline 简洁）。

**Blocking detected：**
```
[!] Blocking overlay detected (high confidence):
    selector: <CSS selector>
    rect: [x,y w×h]  coverage: NN%  z-index: NNNN
    label: "<aria-label or first heading text>"
    signals: role=dialog, aria-modal=true, focus-trapped, body-scroll-locked, backdrop-alpha=0.5
    suggestion: this overlay likely intercepts clicks. Dismiss it (close button / ESC) or ask the user before interacting with the underlying page.

```

**Notice detected：**
```
[i] Notice bar detected (non-blocking):
    selector: <CSS selector>
    rect: [x,y w×h]  position: fixed bottom
    label: "<text snippet>"

```

两者可同时出现。位置：在 outline 的 `header` 行之后、空行之后、tree 之前。

---

## Task 1: 在 `read-page.ts` 中新增 `detectOverlays` 函数

**Files:**
- Modify: `lib/tools/read-page.ts`

- [ ] **Step 1: 在 in-page 函数区（`extractOutline` 上方）新增 `detectOverlays`**

要求：
- 自包含、无闭包（与 `extractText` / `extractCleanHtml` 等同款约束）
- 内部包含一份精简 `buildSelector(el)`（与 `extractOutline.getSelector` 等价但独立，因为注入脚本不能共享外部作用域）
- 包含一份精简 `describeLabel(el)`：优先 `aria-label` → 内部 `h1/h2/[role="heading"]` 文本（截断 60 字符）→ 空字符串
- 实现硬门槛 + 加权评分
- 实现 Cookie/Notice 旁路
- 返回类型（在文件顶部声明 TypeScript interface）：

```ts
interface OverlayInfo {
  selector: string;
  rect: { x: number; y: number; w: number; h: number };
  coverage: number;          // 0–100 整数
  zIndex: number;            // 0 if auto
  label: string;
  signals: string[];         // ['role=dialog','aria-modal=true',...]
  score: number;
  confidence: 'normal' | 'high';
}

interface OverlayDetectionResult {
  blocking: OverlayInfo | null;
  notice: OverlayInfo | null;
}
```

注意点：
- 候选集合：从 5 个采样点 `elementFromPoint` 出发，向上爬祖先链（最多到 `body`），每条链按"硬门槛通过的最外层"作为候选（避免选到 modal 内部的小卡片）
- 多采样点可能命中同一候选，去重后按"加权分数 + 覆盖率"排序，取最高分作为 `blocking`
- 评分时同步收集 `signals` 字符串数组用于输出
- Shadow DOM：穿透时 `try { el.shadowRoot?.elementFromPoint(...) } catch {}`，失败就停在 host
- 性能预算：单次执行 < 5ms（祖先链总节点 < 100，每节点最多 1 次 `getBoundingClientRect` + 1 次 `getComputedStyle`）
- **纯只读**：禁止 `focus / click / scroll / dispatchEvent / 修改 style/class/attr / 创建 DOM`

- [ ] **Step 2: 修改 `extractOutline` 签名**

把当前
```ts
function extractOutline(selector: string | null): string
```
改为
```ts
function extractOutline(selector: string | null): string
```
（签名不变，但内部在 `selector === null` 分支调用 `detectOverlays()` 并把结果格式化成 header 块）

具体位置：在最终 `return [...header, '', ...tree.flatMap(...), '', ...footer].join('\n')` 之前，组装一个 `overlayLines: string[]` 数组（无遮罩则为空），插入到 `header` 之后、tree 之前。

格式化逻辑（同样在 in-page 函数内）：
```ts
function formatOverlayBlock(result: OverlayDetectionResult): string[] {
  const lines: string[] = [];
  if (result.blocking) {
    const o = result.blocking;
    const conf = o.confidence === 'high' ? ' (high confidence)' : '';
    lines.push(`[!] Blocking overlay detected${conf}:`);
    lines.push(`    selector: ${o.selector}`);
    lines.push(`    rect: [${o.rect.x},${o.rect.y} ${o.rect.w}×${o.rect.h}]  coverage: ${o.coverage}%  z-index: ${o.zIndex}`);
    if (o.label) lines.push(`    label: "${o.label}"`);
    lines.push(`    signals: ${o.signals.join(', ')}`);
    lines.push(`    suggestion: this overlay likely intercepts clicks. Dismiss it (close button / ESC) or ask the user before interacting with the underlying page.`);
    lines.push('');
  }
  if (result.notice) {
    const o = result.notice;
    lines.push(`[i] Notice bar detected (non-blocking):`);
    lines.push(`    selector: ${o.selector}`);
    lines.push(`    rect: [${o.rect.x},${o.rect.y} ${o.rect.w}×${o.rect.h}]`);
    if (o.label) lines.push(`    label: "${o.label}"`);
    lines.push('');
  }
  return lines;
}
```

最终返回：
```ts
const overlayLines = (selector === null) ? formatOverlayBlock(detectOverlays()) : [];
return [
  ...header,
  '',
  ...overlayLines,
  ...tree.flatMap(n => formatNode(n, 0)),
  '',
  ...footer,
].join('\n');
```

- [ ] **Step 3: 更新 `readPageTool` 描述（可选但推荐）**

在 `description` 字符串里 outline 那段补一句：
> "outline" (page structure overview — visual regions with selectors, positions, interactive elements; **also reports any blocking overlay / modal that may intercept clicks**; use to understand layout before acting)

- [ ] **Step 4: 自检**

- [ ] 运行 `pnpm tsc --noEmit` 确保无类型错误
- [ ] 运行 `pnpm lint`（如配置）

---

## Task 2: 手动验证

**Files:** 无代码改动，仅人工验收。

由用户在 dev 模式下访问以下页面，调用 outline 工具，把首部输出贴回给开发者复核：

- [ ] **2.1 小红书未登录首页** (`https://www.xiaohongshu.com/`)
  - 期望：`[!] Blocking overlay detected (high confidence)`，signals 含 `role=dialog`、`focus-trapped`、`body-scroll-locked`
- [ ] **2.2 BBC / NYTimes 等带 cookie 横幅站点**
  - 期望：`[i] Notice bar detected`，**不**误报为 blocking
- [ ] **2.3 GitHub 已登录首页** (`https://github.com/`)
  - 期望：**无任何遮罩输出**（sticky header 不应误报）
- [ ] **2.4 Twitter/X 未登录** (`https://x.com/`)
  - 期望：`[!] Blocking overlay`
- [ ] **2.5 维基百科文章页**
  - 期望：**无任何遮罩输出**
- [ ] **2.6 任意网站打开"分享"侧滑抽屉**
  - 期望：`[!] Blocking overlay`（覆盖率 ~30%，但 B+C+D+E ≥ 5）

任一场景失败 → 调整阈值或评分（不重写架构），重测。

---

## Task 3: Code Review

按 `.github/copilot-instructions.md` 的 Post-Task Code Review 规则，调用 `code-review` 子代理审一遍 `lib/tools/read-page.ts` 的改动，修复反馈后再报告完成。

- [ ] 调用 `code-review` 子代理
- [ ] 修复审查反馈
- [ ] 报告完成

---

## 风险与回滚

- **风险 1：算法误报** → 影响仅是 outline 顶部多几行无害提示，模型可以忽略；调整阈值即可。
- **风险 2：算法漏报** → 退化为当前行为，不会比现状更差。
- **风险 3：性能** → 已通过预算控制（< 5ms），且只在 `selector === null` 时跑。
- **回滚**：单文件改动，`git revert` 即可。

---

## 不在范围

- 把检测结果同步到 `gatherPageContext()`（每次 prompt 都跑）— 待算法验证后另开 plan
- `interact` 工具的失败诊断 — 独立优化
- 修改 system prompt 引导模型阅读 `[!]` 块 — 视模型实际表现再说
- 新增独立 `detect_overlay` 工具 — 待 outline 内嵌方案验证后再评估
