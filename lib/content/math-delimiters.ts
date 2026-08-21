/**
 * LaTeX 数学定界符归一化（纯文本变换，跑在 Markdown parse 之前）。
 *
 * remark-math 只认 `$...$` / `$$...$$`，但 LLM 经常输出 `\(...\)` / `\[...\]`；
 * 同时 remark-math 对货币写法没有防护——实测「价格 $5 加 $10」会被解析成
 * 公式「5 加 」，而且它扫描闭合 `$` 时既不理会 `\$` 转义、也不给 code span
 * 让位。本模块在渲染前做四件事：
 *
 * 1. `\(...\)` → `$...$`，`\[...\]` → `$$...$$`（fenced code / 行内 code 内不动）。
 *    公式体含字面 `$` 时按 code span 式规则用更长的 `$` run 做定界符
 *    （`\(p = $8\)` → `$$p = $8$$`），因为 `\$` 在公式体内阻止不了闭合。
 * 2. 货币防护（Pandoc 规则）：`$...$` 候选对的闭合 `$` 后紧跟数字时视为货币
 *    而非公式，把两个 `$` 转义成 `\$`（转义能阻止**开启**，实测有效）
 * 3. code span 让位：`$...$` 候选对中间夹反引号时（remark-math 会连 code span
 *    一起吞进公式），转义开启的 `$`，让 code span 正常解析
 * 4. streaming 时末尾未闭合的 `$$` 块级定界符转义成字面文本，避免流式中途
 *    KaTeX 渲染半截公式的红色闪烁；闭合符到达后自然恢复成公式
 *
 * 已知限制：不识别缩进式（4 空格）code block 与 blockquote/list 内嵌的
 * fence——LLM 输出几乎总是顶层 fenced code，误伤面可忽略。
 *
 * 注意：只应对「LLM 产出的聊天内容」启用。任意 Markdown 文件里的 `\(` 是
 * CommonMark 的转义括号（渲染为字面 `(`），不能当数学定界符转换。
 */

interface NormalizeOptions {
  /** 流式输出中：末尾未闭合的 `$$` 块保持字面文本，闭合后再渲染成公式。 */
  streaming?: boolean;
}

/** 快速路径：既没有 $ 也没有反斜杠时不可能需要任何变换。 */
const MAYBE_MATH_RE = /[$\\]/;

/** transformProse 里下一个需要分派处理的字符。 */
const SPECIAL_RE = /[`\\$]/g;

/** 空行（段落边界）：行内构造（code span、$...$、\(...\)）不得跨越。兼容 CRLF。 */
const BLANK_LINE_RE = /\r?\n[ \t]*\r?\n/g;

/** fence 开启行：≤3 空格缩进 + ``` 或 ~~~（后可带 info string）。 */
const FENCE_OPEN_RE = /^ {0,3}(`{3,}|~{3,})(.*?)\r?$/;

/** fence 关闭行：同字符、长度不小于开启符、行尾只允许空白。兼容 CRLF。 */
const FENCE_CLOSE_RE = /^ {0,3}(`{3,}|~{3,})[ \t]*\r?$/;

/** 块级公式定界行：≤3 空格缩进（CommonMark 规则，多于 3 格是缩进代码）+
 *  2 个及以上 $，行尾只允许空白。 */
const MATH_FLOW_LINE_RE = /^ {0,3}(\$\$+)[ \t]*\r?$/;

/** idx 处的字符是否被奇数个反斜杠转义。 */
function isEscaped(src: string, idx: number): boolean {
  let n = 0;
  for (let j = idx - 1; j >= 0 && src[j] === '\\'; j--) n++;
  return n % 2 === 1;
}

/** 从 from 起的第一个段落边界位置；没有则是文本末尾。 */
function blankLineFrom(src: string, from: number): number {
  BLANK_LINE_RE.lastIndex = from;
  const m = BLANK_LINE_RE.exec(src);
  return m ? m.index : src.length;
}

/** 在 [from, limit) 内找长度恰为 len 的反引号 run（code span 闭合符），返回起点或 -1。 */
function findBacktickRun(src: string, from: number, len: number, limit: number): number {
  let i = from;
  while (i < limit) {
    const start = src.indexOf('`', i);
    if (start === -1 || start >= limit) return -1;
    let end = start;
    while (end < limit && src[end] === '`') end++;
    if (end - start === len) return start;
    i = end;
  }
  return -1;
}

/** 从 from 起找未被转义的 closer（`\)` / `\]`），限制在 limit 内；返回起点或 -1。 */
function findUnescapedCloser(src: string, closer: string, from: number, limit: number): number {
  let idx = src.indexOf(closer, from);
  while (idx !== -1 && idx < limit && isEscaped(src, idx)) {
    idx = src.indexOf(closer, idx + 1);
  }
  return idx !== -1 && idx < limit ? idx : -1;
}

/** body 里最长的连续 $ run 长度（决定安全的定界符长度，code span 式规则）。 */
function maxDollarRun(body: string): number {
  let maxRun = 0;
  let run = 0;
  for (const c of body) {
    run = c === '$' ? run + 1 : 0;
    if (run > maxRun) maxRun = run;
  }
  return maxRun;
}

/**
 * 把公式体包成 remark-math 能正确解析的**行内** $ 定界形式。
 * 定界符 run 必须比 body 里最长的 $ run 更长；
 * body 首尾是 $ 时补一个空格防粘连。display 至少用 $$。
 */
function wrapMath(body: string, display: boolean): string {
  const delim = '$'.repeat(Math.max(display ? 2 : 1, maxDollarRun(body) + 1));
  const pad = body.startsWith('$') || body.endsWith('$') ? ' ' : '';
  return delim + pad + body + pad + delim;
}

/**
 * 把公式体包成**块级**（flow math）形式：定界符各占一行。
 * 行内的 `$$x$$` 会被 remark-math 解析成 inlineMath（无块级布局、无
 * display 属性），只有定界符独立成行才是真正的 math 块。
 * indent 为开启行的行首缩进：插入的续行沿用它，保证列表续行等容器
 * 上下文里公式不脱离容器。
 */
function wrapMathFlow(body: string, indent: string): string {
  const delim = '$'.repeat(Math.max(2, maxDollarRun(body) + 1));
  return `${delim}\n${indent}${body.trim()}\n${indent}${delim}`;
}

/** [start, end) 这段内容在源文本里是否独占其所在行（两侧到行边界都是空白）。
 *  用于判断 `\[...\]` / `$$...$$` 是否可以安全升级成块级公式。 */
function isAloneOnLines(src: string, start: number, end: number): boolean {
  let a = start - 1;
  while (a >= 0 && (src[a] === ' ' || src[a] === '\t' || src[a] === '\r')) a--;
  if (a >= 0 && src[a] !== '\n') return false;
  let b = end;
  while (b < src.length && (src[b] === ' ' || src[b] === '\t' || src[b] === '\r')) b++;
  return b >= src.length || src[b] === '\n';
}

/** start 所在行的行首缩进。仅接受 ≤3 个空格（可升级为块级公式并沿用该
 *  缩进）；4 空格及以上或含 Tab 可能是 CommonMark 缩进代码，返回 null
 *  表示不可升级、保持行内形式。 */
function upgradableIndentAt(src: string, start: number): string | null {
  const lineStart = src.lastIndexOf('\n', start - 1) + 1;
  const indent = src.slice(lineStart, start);
  if (indent.includes('\t') || indent.length > 3) return null;
  return indent;
}

/**
 * 对一段 prose（无 fenced code）做定界符变换。
 * 顺序扫描并分派 ` / \ / $ 三类字符；候选构造的搜索都限制在当前段落内
 * （段落边界带缓存，扫描位置只前进不后退）。
 */
function transformProse(src: string, streaming: boolean): string {
  const out: string[] = [];
  const n = src.length;
  let i = 0;
  // 当前段落边界缓存：blankLineFrom 单调，扫描过界才重算
  let paraEnd = -1;
  const limitAt = (pos: number): number => {
    if (paraEnd < pos) paraEnd = blankLineFrom(src, pos);
    return paraEnd;
  };

  while (i < n) {
    SPECIAL_RE.lastIndex = i;
    const m = SPECIAL_RE.exec(src);
    if (!m) {
      out.push(src.slice(i));
      break;
    }
    if (m.index > i) {
      out.push(src.slice(i, m.index));
      i = m.index;
    }
    const ch = src[i];

    // ─── code span：内容原样保留 ───
    if (ch === '`') {
      let runLen = 1;
      while (src[i + runLen] === '`') runLen++;
      const close = findBacktickRun(src, i + runLen, runLen, limitAt(i));
      if (close !== -1) {
        out.push(src.slice(i, close + runLen));
        i = close + runLen;
      } else {
        // 未闭合：反引号按字面处理，其后内容照常扫描
        out.push(src.slice(i, i + runLen));
        i += runLen;
      }
      continue;
    }

    // ─── 反斜杠 ───
    if (ch === '\\') {
      const next = src[i + 1];
      if (next === '\\' || next === '$' || next === '`') {
        // 既有转义原样保留（\$ 不是活动定界符、\` 不是 code span 开启符）
        out.push(ch + next);
        i += 2;
        continue;
      }
      if (next === '(' || next === '[') {
        const closer = next === '(' ? '\\)' : '\\]';
        const end = findUnescapedCloser(src, closer, i + 2, limitAt(i));
        if (end !== -1) {
          const body = src.slice(i + 2, end);
          // \[...\] 独占整行且缩进可升级时改成真正的块级公式（定界符独立
          // 成行），夹在行内文字中间时退化为行内 $$ 形式
          const indent =
            next === '[' && isAloneOnLines(src, i, end + 2) ? upgradableIndentAt(src, i) : null;
          out.push(indent !== null ? wrapMathFlow(body, indent) : wrapMath(body, next === '['));
          i = end + 2;
        } else {
          // 未闭合（含流式中途）：保持原样，等闭合符到达再转换
          out.push(ch + next);
          i += 2;
        }
        continue;
      }
      out.push(ch);
      i += 1;
      continue;
    }

    // ─── 美元符 ───
    if (src[i + 1] === '$') {
      const lineStart = src.lastIndexOf('\n', i - 1) + 1;
      let lineEnd = src.indexOf('\n', i);
      if (lineEnd === -1) lineEnd = n;
      const lineOpen = src.slice(lineStart, lineEnd).match(MATH_FLOW_LINE_RE);
      if (lineOpen) {
        // 块级公式定界行：找关闭行（$ run 不短于开启符），整块跳过不做任何变换
        const openLen = lineOpen[1].length;
        let close = -1;
        let from = lineEnd + 1;
        while (from <= n && from > 0) {
          let le = src.indexOf('\n', from);
          if (le === -1) le = n;
          const m2 = src.slice(from, le).match(MATH_FLOW_LINE_RE);
          if (m2 && m2[1].length >= openLen) {
            close = le;
            break;
          }
          if (le >= n) break;
          from = le + 1;
        }
        if (close !== -1) {
          out.push(src.slice(i, close));
          i = close;
        } else if (streaming) {
          // 流式中途未闭合：转义定界符按字面渲染，闭合后（下一帧重新归一化）恢复
          out.push('\\$'.repeat(openLen));
          i += openLen;
        } else {
          // 非流式的悬空 $$：保留 remark-math 的默认行为（渲染到文本末尾）
          out.push(src.slice(i));
          i = n;
        }
        continue;
      }
      // 行内 $$...$$：找同段内的闭合 $$
      const limit = limitAt(i);
      const end = src.indexOf('$$', i + 2);
      if (end !== -1 && end < limit) {
        const indent = isAloneOnLines(src, i, end + 2) ? upgradableIndentAt(src, i) : null;
        if (indent !== null) {
          // 独占整行的 $$x$$ 是 LLM 常见的块级写法，但 remark-math 会解析成
          // 行内公式（inlineMath），升级为定界符独立成行的真块级形式
          out.push(wrapMathFlow(src.slice(i + 2, end), indent));
        } else {
          out.push(src.slice(i, end + 2));
        }
        i = end + 2;
      } else {
        out.push('$$');
        i += 2;
      }
      continue;
    }

    // 单个 $：镜像 remark-math 的行为找闭合 $ —— 它不理会 body 内的 \$ 转义，
    // 所以这里也扫描任意 $；找到后按三种情况分派
    const limit = limitAt(i);
    let end = -1;
    for (let j = i + 1; j < limit; j++) {
      if (src[j] === '$') {
        end = j;
        break;
      }
    }
    if (end === -1) {
      // 无配对：remark-math 也不会解析，字面保留
      out.push('$');
      i += 1;
      continue;
    }
    // 配对区间内是否存在「真正能闭合的 code span」：未转义的反引号 run，
    // 且同段落内（可以在闭合 $ 之后）有等长的关闭 run。转义反引号或孤立
    // 反引号不算——remark-math 会把它们当字面字符收进公式体，无需让位
    let hasSpan = false;
    for (let j = i + 1; j < end; j++) {
      if (src[j] !== '`' || isEscaped(src, j)) continue;
      let runLen = 1;
      while (src[j + runLen] === '`') runLen++;
      if (findBacktickRun(src, j + runLen, runLen, limit) !== -1) {
        hasSpan = true;
        break;
      }
      j += runLen - 1;
    }
    if (hasSpan) {
      // 配对区间夹着 code span：remark-math 会把它吞进公式，
      // 转义开启的 $ 让位，从下一个字符重新扫描（code span 正常解析）
      out.push('\\$');
      i += 1;
      continue;
    }
    const after = src[end + 1];
    if (after !== undefined && after >= '0' && after <= '9') {
      // 货币（Pandoc 规则：闭合 $ 后紧跟数字）：两端都转义成字面 $
      out.push('\\$' + src.slice(i + 1, end) + '\\$');
    } else {
      // 真公式（或无害配对）：原样保留，公式体不再参与任何变换
      out.push(src.slice(i, end + 1));
    }
    i = end + 1;
  }
  return out.join('');
}

/**
 * 归一化一段 Markdown 里的数学定界符（详见文件头注释）。
 * 纯函数：无公式相关字符时原样返回同一引用。
 */
function normalizeMathDelimiters(markdown: string, opts: NormalizeOptions = {}): string {
  if (!MAYBE_MATH_RE.test(markdown)) return markdown;
  const streaming = !!opts.streaming;
  const lines = markdown.split('\n');
  const segments: string[] = [];
  let cur: string[] = [];
  let curIsCode = false;
  let fenceChar = '';
  let fenceLen = 0;

  const flush = () => {
    if (!cur.length) return;
    const text = cur.join('\n');
    segments.push(curIsCode ? text : transformProse(text, streaming));
    cur = [];
  };

  for (const line of lines) {
    if (!curIsCode) {
      const m = line.match(FENCE_OPEN_RE);
      // CommonMark：backtick fence 的 info string 不得含反引号（否则整行只是普通文本）
      if (m && !(m[1][0] === '`' && m[2].includes('`'))) {
        flush();
        curIsCode = true;
        fenceChar = m[1][0];
        fenceLen = m[1].length;
      }
      cur.push(line);
    } else {
      cur.push(line);
      const m = line.match(FENCE_CLOSE_RE);
      if (m && m[1][0] === fenceChar && m[1].length >= fenceLen) {
        flush();
        curIsCode = false;
      }
    }
  }
  flush();
  return segments.join('\n');
}

export { normalizeMathDelimiters };
