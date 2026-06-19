// 识别结果文本的纯字符串处理（无副作用、无 IPC、无 storage）。
//
// 这里只放「拿到一段文本就能算出结果」的纯工具。AI 修正涉及读配置 +
// 跨进程调模型，是有状态的跨进程逻辑，拆在 `lib/speech/correction-channel.ts`。
//
// `cleanTranscript` —— 去掉 CJK 字符之间多余的空格。Chrome SODA 本地引擎的
// 中文最终结果会在字间插空格（如「今 天 天 气」），但英文单词间的空格必须
// 保留，所以只合并「汉字 空格 汉字」这种间隙。

// 匹配「CJK 字符 + 一个或多个空白 + CJK 字符」，用于剔除中日韩字之间的空格。
// 覆盖：CJK 统一表意文字、扩展 A、兼容表意、假名、注音、全角标点等常见区段。
const CJK_RANGE = '\\u3000-\\u303f\\u3040-\\u30ff\\u3100-\\u312f\\u3400-\\u4dbf\\u4e00-\\u9fff\\uf900-\\ufaff\\uff00-\\uffef';
const CJK_GAP_RE = new RegExp(`([${CJK_RANGE}])\\s+(?=[${CJK_RANGE}])`, 'g');

/** 去除 CJK 字符之间的空格，保留英文单词间空格，并裁剪首尾空白。 */
export function cleanTranscript(text: string): string {
  // 反复套用以处理「字 字 字」中相邻间隙的重叠匹配。
  let prev = text;
  let next = text.replace(CJK_GAP_RE, '$1');
  while (next !== prev) {
    prev = next;
    next = next.replace(CJK_GAP_RE, '$1');
  }
  return next.trim();
}

// 单个字符是否落在上面的 CJK 区段内，用于决定拼接时是否补空格。
const CJK_CHAR_RE = new RegExp(`[${CJK_RANGE}]`);

/** 把一段识别文本拼接到已有内容尾部，按语言决定是否补空格。
 *
 *  规则：已有内容为空 → 直接返回新段；尾部已是空白 → 不再补；边界任一侧是
 *  CJK 字符 → 不加空格（中文不分词）；否则补一个空格（英文句子/单词间）。
 *  用于把每段 final 追加进输入框，以及 interim 实时预览的拼接，两处共用同一
 *  规则，保证预览与落定一致。 */
export function appendTranscript(base: string, addition: string): string {
  // interim 预览用的是未清洗的原始识别文本，可能带前导空白；先归一化掉，
  // 避免与下面的补空格逻辑叠加出双空格。
  const add = addition.replace(/^\s+/, '');
  if (!base) return add;
  if (!add) return base;
  if (/\s$/.test(base)) return base + add;
  const boundaryIsCJK = CJK_CHAR_RE.test(base[base.length - 1]) || CJK_CHAR_RE.test(add[0]);
  return base + (boundaryIsCJK ? '' : ' ') + add;
}

