// 划词动作的定义注册表 + 纯渲染函数（domain content，随概念走）。
//
// 数据驱动：每个动作是一条 PageActionDef，用 id 索引；renderSystemPrompt /
// renderUserIntent 是无平台依赖的纯函数，内联短暂调用与（后续）会话固化共用同一
// 渲染源，保证「怎么问」单一事实源、零漂移。动作指令（如「只输出译文」）放 system
// prompt，user turn 只放干净意图，便于将来固化进历史时读起来自然。

import type { PageActionId } from './types';

/** 渲染用参数（已由 background 解析成具体值，如目标语言名）。 */
export type PageActionParams = Record<string, unknown>;

export interface PageActionDef {
  id: PageActionId;
  /** LLM 的 system 提示词（含动作指令）。 */
  renderSystemPrompt(params: PageActionParams): string;
  /** 干净的用户意图（作为 user turn；将来固化进历史也用它）。 */
  renderUserIntent(text: string, params: PageActionParams): string;
}

function str(params: PageActionParams, key: string, fallback: string): string {
  const v = params[key];
  return typeof v === 'string' && v ? v : fallback;
}

/** 从参数中取布尔值；缺省 / 类型不对时回退 fallback。 */
function bool(params: PageActionParams, key: string, fallback: boolean): boolean {
  const v = params[key];
  return typeof v === 'boolean' ? v : fallback;
}

/** 若带有界上下文（页面标题 + 选区周边），拼成一段「仅供消歧的参考」附在 system 末尾。
 *  只进 system、不进 user turn，故「在侧边栏继续」固化的历史里 user 消息仍是干净意图。 */
function contextBlock(params: PageActionParams): string {
  const ctx = str(params, 'context', '');
  if (!ctx) return '';
  return (
    '\n\nFor reference only, here is surrounding context from the page. ' +
    'Use it to disambiguate; do NOT translate, explain, or summarize the context itself:\n' +
    ctx
  );
}

const TRANSLATE: PageActionDef = {
  id: 'translate',
  renderSystemPrompt: (p) => {
    const target = str(p, 'target', 'English');
    const showPronunciation = bool(p, 'pronunciation', false);

    if (!showPronunciation) {
      return (
        `You are a professional translator. Translate the user's text into ${target}. ` +
        'Preserve the original meaning and tone. ' +
        'Output only the translated text as plain text — no markdown, explanations, notes, or surrounding quotes.' +
        contextBlock(p)
      );
    }

    // 开启读音时，要求模型按固定 4 行格式输出：原文 → 原文读音 → 译文 → 译文读音。
    // 长文本（超过 2 句）跳过读音，只输出译文，避免大段注音无意义。
    return (
      `You are a professional translator. Translate the user's text into ${target}. ` +
      'Preserve the original meaning and tone.\n\n' +
      'Output format — follow strictly, plain text only, no markdown, no labels, no extra content:\n' +
      'Line 1: the original text (copy exactly)\n' +
      'Line 2: pronunciation of the original text\n' +
      'Line 3: the translated text\n' +
      'Line 4: pronunciation of the translated text\n\n' +
      'Pronunciation rules:\n' +
      '- Chinese text → Pinyin with tone marks (e.g., nǐ hǎo)\n' +
      '- English text → IPA phonetic notation in slashes (e.g., /həˈloʊ/)\n' +
      '- Japanese text → Romaji (e.g., konnichiwa)\n' +
      '- Korean text → Revised Romanization (e.g., annyeonghaseyo)\n' +
      '- Other languages → use the most common phonetic notation for that language\n\n' +
      'If the text is a long paragraph (more than 2 sentences), skip pronunciation entirely ' +
      'and output only the translated text as plain prose.' +
      contextBlock(p)
    );
  },
  renderUserIntent: (text, p) => {
    const target = str(p, 'target', 'English');
    return `Translate into ${target}:\n\n${text}`;
  },
};

const EXPLAIN: PageActionDef = {
  id: 'explain',
  renderSystemPrompt: (p) => {
    const lang = str(p, 'lang', "the user's language");
    return (
      `You are a helpful assistant. Explain the user's selected text clearly and concisely ` +
      `in ${lang}. Cover what it means and any important context a reader would want. ` +
      'Keep it brief. Reply in plain prose without markdown formatting.' +
      contextBlock(p)
    );
  },
  renderUserIntent: (text) => `Explain:\n\n${text}`,
};

const SUMMARIZE: PageActionDef = {
  id: 'summarize',
  renderSystemPrompt: (p) => {
    const lang = str(p, 'lang', "the user's language");
    return (
      `You are a helpful assistant. Summarize the user's selected text in ${lang}, ` +
      'capturing the key points concisely. ' +
      'Reply in plain prose (short sentences or a compact list is fine) without markdown formatting.' +
      contextBlock(p)
    );
  },
  renderUserIntent: (text) => `Summarize:\n\n${text}`,
};

const REGISTRY: Record<PageActionId, PageActionDef> = {
  translate: TRANSLATE,
  explain: EXPLAIN,
  summarize: SUMMARIZE,
};

/** 按 id 取动作定义；未知 id 返回 undefined（由调用方诚实报错）。 */
export function getPageAction(id: string): PageActionDef | undefined {
  return (REGISTRY as Record<string, PageActionDef>)[id];
}
