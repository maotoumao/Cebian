import { describe, expect, it } from 'vitest';
import { unified } from 'unified';
import remarkParse from 'remark-parse';
import remarkMath from 'remark-math';
import { normalizeMathDelimiters } from '@/lib/content/math-delimiters';

describe('normalizeMathDelimiters', () => {
  describe('\\(...\\) / \\[...\\] 转换', () => {
    it('行内 \\(...\\) 转成 $...$', () => {
      expect(normalizeMathDelimiters('质能方程 \\(E = mc^2\\) 如上')).toBe(
        '质能方程 $E = mc^2$ 如上',
      );
    });

    it('块级 \\[...\\] 转成 $$...$$（多行）', () => {
      expect(normalizeMathDelimiters('\\[\n\\frac{a}{b}\n\\]')).toBe('$$\n\\frac{a}{b}\n$$');
    });

    it('行内出现的 \\[...\\] 转成行内 $$ 形式', () => {
      expect(normalizeMathDelimiters('见 \\[x=1\\] 所示')).toBe('见 $$x=1$$ 所示');
    });

    it('独占一行的 \\[...\\] 升级为块级（定界符独立成行）', () => {
      expect(normalizeMathDelimiters('\\[x=1\\]')).toBe('$$\nx=1\n$$');
      expect(normalizeMathDelimiters('前文\n\\[x=1\\]\n后文')).toBe('前文\n$$\nx=1\n$$\n后文');
    });

    it('列表项内的 \\[...\\] 不升级（保持行内，避免破坏列表结构）', () => {
      expect(normalizeMathDelimiters('- \\[x=1\\]')).toBe('- $$x=1$$');
    });

    it('公式体含字面 $ 时改用更长的 $ run 做定界符', () => {
      expect(normalizeMathDelimiters('价格 \\(p = $8\\)')).toBe('价格 $$p = $8$$');
      expect(normalizeMathDelimiters('\\(a\\$b\\)')).toBe('$$a\\$b$$');
    });

    it('公式体首尾是 $ 时补空格防粘连', () => {
      expect(normalizeMathDelimiters('\\($x\\)')).toBe('$$ $x $$');
    });

    it('未闭合的 \\( 保持原样', () => {
      expect(normalizeMathDelimiters('开头 \\(x + y')).toBe('开头 \\(x + y');
    });

    it('被转义的 \\\\) 不当作闭合符（反斜杠奇偶性）', () => {
      // markdown 源：\(a\\)b\)  ——  \\) 是「转义反斜杠 + 括号」，真正的闭合在末尾
      expect(normalizeMathDelimiters('\\(a\\\\)b\\)')).toBe('$a\\\\)b$');
    });

    it('闭合符在段落边界之外时不转换', () => {
      const src = '\\(x\n\n\\)';
      expect(normalizeMathDelimiters(src)).toBe(src);
    });
  });

  describe('货币防护（Pandoc 规则）', () => {
    it('闭合 $ 后紧跟数字 → 两端转义', () => {
      expect(normalizeMathDelimiters('价格 $5 加 $10 元')).toBe('价格 \\$5 加 \\$10 元');
    });

    it('真公式不受影响（闭合 $ 后是空格/标点/结尾）', () => {
      expect(normalizeMathDelimiters('$E=mc^2$ 结论')).toBe('$E=mc^2$ 结论');
      expect(normalizeMathDelimiters('幂 $2^{10}$ 保留')).toBe('幂 $2^{10}$ 保留');
    });

    it('无配对的单个 $ 原样保留', () => {
      expect(normalizeMathDelimiters('只花了 $5 而已')).toBe('只花了 $5 而已');
    });

    it('已转义的 \\$ 不参与配对', () => {
      expect(normalizeMathDelimiters('字面 \\$5 和 \\$10')).toBe('字面 \\$5 和 \\$10');
    });

    it('配对搜索不跨段落边界', () => {
      expect(normalizeMathDelimiters('第一段 $5\n\n第二段 $10 元')).toBe(
        '第一段 $5\n\n第二段 $10 元',
      );
    });

    it('CRLF 段落边界同样生效', () => {
      const src = '第一段 $5\r\n\r\n第二段 $10 元';
      expect(normalizeMathDelimiters(src)).toBe(src);
    });
  });

  describe('code span 让位', () => {
    it('配对区间夹反引号 → 转义开启 $，code span 保留', () => {
      expect(normalizeMathDelimiters('变量 $HOME 与 `echo $PATH` 无关')).toBe(
        '变量 \\$HOME 与 `echo $PATH` 无关',
      );
    });

    it('货币对夹 code span 同样让位', () => {
      expect(normalizeMathDelimiters('$5 `code` 加 $10')).toBe('\\$5 `code` 加 $10');
    });

    it('行内 code span 内不做变换', () => {
      expect(normalizeMathDelimiters('代码 `\\(x\\)` 与公式 \\(y\\)')).toBe(
        '代码 `\\(x\\)` 与公式 $y$',
      );
    });

    it('多反引号 code span（内含单反引号）整体跳过', () => {
      expect(normalizeMathDelimiters('`` ` \\(x\\) `` 之外 \\(y\\)')).toBe(
        '`` ` \\(x\\) `` 之外 $y$',
      );
    });

    it('未闭合反引号按字面处理，后续照常转换', () => {
      expect(normalizeMathDelimiters('孤立 ` 之后 \\(x\\)')).toBe('孤立 ` 之后 $x$');
    });

    it('转义的 \\` 不是 code span 开启符', () => {
      expect(normalizeMathDelimiters('转义 \\` 后 \\(x\\)')).toBe('转义 \\` 后 $x$');
    });

    it('公式体内转义的 \\` 不触发让位（有效公式保留）', () => {
      const src = '公式 $a \\` b$ 结束';
      expect(normalizeMathDelimiters(src)).toBe(src);
    });

    it('公式体内孤立反引号（无闭合 run）不触发让位', () => {
      const src = '公式 $a ` b$ 结束';
      expect(normalizeMathDelimiters(src)).toBe(src);
    });

    it('code span 闭合符在 $ 配对之后也让位', () => {
      expect(normalizeMathDelimiters('$a `b$ c` d')).toBe('\\$a `b$ c` d');
    });
  });

  describe('fenced code 跳过', () => {
    it('fenced code 内不做任何变换', () => {
      const src = '```sh\necho \\(hello\\) $5 加 $10\n```';
      expect(normalizeMathDelimiters(src)).toBe(src);
    });

    it('未闭合 fence（流式中途）后的内容全部不动', () => {
      const src = '```js\nconst a = "\\(x\\)";\nconst b = 1;';
      expect(normalizeMathDelimiters(src)).toBe(src);
    });

    it('fence 前后的 prose 正常转换', () => {
      expect(normalizeMathDelimiters('\\(a\\)\n```\n\\(b\\)\n```\n\\(c\\)')).toBe(
        '$a$\n```\n\\(b\\)\n```\n$c$',
      );
    });

    it('关闭 fence 长度可以大于开启符', () => {
      expect(normalizeMathDelimiters('```\n\\(a\\)\n`````\n\\(b\\)')).toBe(
        '```\n\\(a\\)\n`````\n$b$',
      );
    });

    it('CRLF 行尾的 fence 关闭行能被识别', () => {
      expect(normalizeMathDelimiters('```\r\n\\(a\\)\r\n```\r\n\\(b\\)')).toBe(
        '```\r\n\\(a\\)\r\n```\r\n$b$',
      );
    });

    it('info string 含反引号的 backtick fence 不是 fence', () => {
      expect(normalizeMathDelimiters('```bad`info\n\\(x\\)')).toBe('```bad`info\n$x$');
    });
  });

  describe('$$ 块', () => {
    it('闭合的 $$ 块整体跳过（内容不被货币/转义逻辑碰到）', () => {
      const src = '$$\nf(x) = $5 \\(oops\\)\n$$';
      expect(normalizeMathDelimiters(src)).toBe(src);
    });

    it('关闭行的 $ run 可以更长', () => {
      const src = '$$\nx\n$$$';
      expect(normalizeMathDelimiters(src)).toBe(src);
    });

    it('行内 $$...$$ 整体跳过', () => {
      const src = '看 $$x_1$$ 这里';
      expect(normalizeMathDelimiters(src)).toBe(src);
    });

    it('独占一行的 $$x$$ 升级为块级（定界符独立成行）', () => {
      expect(normalizeMathDelimiters('$$E=mc^2$$')).toBe('$$\nE=mc^2\n$$');
      expect(normalizeMathDelimiters('结论：\n$$E=mc^2$$\n完毕')).toBe(
        '结论：\n$$\nE=mc^2\n$$\n完毕',
      );
    });

    it('列表续行内的升级保留容器缩进', () => {
      expect(normalizeMathDelimiters('- item\n  $$x$$')).toBe('- item\n  $$\n  x\n  $$');
    });

    it('4 空格或 Tab 缩进（疑似缩进代码）不升级', () => {
      expect(normalizeMathDelimiters('    $$x$$')).toBe('    $$x$$');
      expect(normalizeMathDelimiters('\t$$x$$')).toBe('\t$$x$$');
    });

    it('非流式的悬空 $$ 保持原样（交给 remark 默认行为）', () => {
      const src = '$$\n\\frac{a}{b}';
      expect(normalizeMathDelimiters(src)).toBe(src);
    });

    it('缩进超过 3 格的 $$ 不是关闭行（块内内容不被转换）', () => {
      // remark-math 不认 4 空格缩进的 $$ 作关闭符，块一直开到结尾，
      // 后面的 \(a\) 实际仍在公式块内，不得转换
      const src = '$$\nx\n    $$\ny \\(a\\)';
      expect(normalizeMathDelimiters(src)).toBe(src);
    });

    it('开启行允许 1-3 格缩进', () => {
      const src = '  $$\nx\n$$';
      expect(normalizeMathDelimiters(src)).toBe(src);
    });
  });

  describe('streaming 逐帧截断', () => {
    it('末尾未闭合的 $$ 被转义为字面文本', () => {
      expect(normalizeMathDelimiters('$$\n\\frac{a}{b}', { streaming: true })).toBe(
        '\\$\\$\n\\frac{a}{b}',
      );
    });

    it('闭合符只到一半（单个 $）仍视为未闭合', () => {
      expect(normalizeMathDelimiters('$$\nx\n$', { streaming: true })).toBe('\\$\\$\nx\n$');
    });

    it('刚闭合的 $$ 块立即恢复', () => {
      const src = '$$\nx\n$$';
      expect(normalizeMathDelimiters(src, { streaming: true })).toBe(src);
    });

    it('只有一个 $ 的末尾无配对，字面保留', () => {
      expect(normalizeMathDelimiters('结尾 $', { streaming: true })).toBe('结尾 $');
    });
  });

  describe('杂项', () => {
    it('无公式字符时原样返回同一引用（快速路径）', () => {
      const src = '普通文本，没有任何数学。';
      expect(normalizeMathDelimiters(src)).toBe(src);
    });

    it('$...$ 公式体内的 \\( 不再二次转换', () => {
      expect(normalizeMathDelimiters('$f\\(x\\)$ 后文 \\(y\\)')).toBe('$f\\(x\\)$ 后文 $y$');
    });

    it('双反斜杠不吞掉后续字符', () => {
      expect(normalizeMathDelimiters('换行 \\\\ 之后 \\(x\\)')).toBe('换行 \\\\ 之后 $x$');
    });
  });
});

/**
 * 集成断言：归一化结果交给真实的 remark-parse + remark-math 解析，
 * 校验最终 AST——字符串比对可能掩盖 micromark 的真实行为。
 */
describe('normalize → remark-math 集成', () => {
  type Collected = { math: string[]; block: string[]; code: string[] };

  function parseMath(markdown: string): Collected {
    const tree = unified().use(remarkParse).use(remarkMath).parse(markdown);
    const acc: Collected = { math: [], block: [], code: [] };
    const walk = (node: {
      type: string;
      value?: string;
      children?: unknown[];
    }): void => {
      if (node.type === 'inlineMath' || node.type === 'math') acc.math.push(node.value ?? '');
      if (node.type === 'math') acc.block.push(node.value ?? '');
      if (node.type === 'inlineCode') acc.code.push(node.value ?? '');
      for (const c of node.children ?? []) walk(c as { type: string });
    };
    walk(tree as { type: string });
    return acc;
  }

  it('公式体含 $ 的 \\(...\\) 整体成为一个公式', () => {
    const r = parseMath(normalizeMathDelimiters('价格 \\(p = $8\\) 如上'));
    expect(r.math).toEqual(['p = $8']);
  });

  it('货币对不产生公式节点', () => {
    const r = parseMath(normalizeMathDelimiters('价格 $5 加 $10 元'));
    expect(r.math).toEqual([]);
  });

  it('$ 与 code span 交错时公式让位，code span 完整', () => {
    const r = parseMath(normalizeMathDelimiters('变量 $HOME 与 `echo $PATH` 无关'));
    expect(r.math).toEqual([]);
    expect(r.code).toEqual(['echo $PATH']);
  });

  it('货币对夹 code span：无公式、code 完整', () => {
    const r = parseMath(normalizeMathDelimiters('$5 `code` 加 $10'));
    expect(r.math).toEqual([]);
    expect(r.code).toEqual(['code']);
  });

  it('真公式正常解析', () => {
    const r = parseMath(normalizeMathDelimiters('质能方程 \\(E = mc^2\\) 与 $a+b$'));
    expect(r.math).toEqual(['E = mc^2', 'a+b']);
  });

  it('块级 \\[...\\] 解析为 math 块', () => {
    const r = parseMath(normalizeMathDelimiters('\\[\n\\frac{a}{b}\n\\]'));
    expect(r.block).toEqual(['\\frac{a}{b}']);
  });

  it('独占一行的 $$x$$ / \\[x\\] 解析为块级 math 节点', () => {
    expect(parseMath(normalizeMathDelimiters('$$E=mc^2$$')).block).toEqual(['E=mc^2']);
    expect(parseMath(normalizeMathDelimiters('\\[x=1\\]')).block).toEqual(['x=1']);
  });

  it('段落中间独立成行的块级公式能打断段落', () => {
    const r = parseMath(normalizeMathDelimiters('结论：\n$$E=mc^2$$\n完毕'));
    expect(r.block).toEqual(['E=mc^2']);
  });

  it('列表续行内升级后的公式仍是列表内的 math 块', () => {
    const r = parseMath(normalizeMathDelimiters('- item\n  $$x$$'));
    expect(r.block).toEqual(['x']);
  });

  it('缩进代码里的 $$x$$ 保持为代码，不产生公式', () => {
    const r = parseMath(normalizeMathDelimiters('前文\n\n    $$x$$'));
    expect(r.math).toEqual([]);
  });
});
