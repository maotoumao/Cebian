// 网络录制打码用到的判断：字段名是否敏感、文本里有没有凭据迹象、文本像不像 URL / JSON。
// 只做判断不改写；改写规则在 `redact-values.ts` 与 `redact.ts`。
//
// 字段名先规整（小写、去掉重音、`_` `-` `.` 等分隔符与末尾数字），再按「整词 / 后缀 / 包含」
// 匹配：`access_token`、`refreshToken`、`client_secret`、`password_confirmation` 算敏感，
// `keyword`、`author`、`country_code` 不算；另把名字按驼峰与分隔符拆成单词，命中敏感单词
// （`newPwd`、`SecretCode`）或敏感的相邻单词组合（`SMS_MFA_CODE`、`stateHandle`）也算。
// 宁可多算一些（如分页用的 `page_token`、通过率 `pass_rate`），也不放过凭据。
//
// 自由文本（不是 URL / JSON 的字符串值、表单值、多数头部值）无法可靠地圈出「名字后面的值」
// （GraphQL 注释、脚本语法、转义写法都能把两者隔开），所以只要出现敏感词、敏感名字的赋值、
// 带用户信息的 URL、Bearer / Basic 凭据或 JWT 就算有迹象，由调用方整段打码。结构化文本
// （URL 路径、名字列表类的头）里敏感词本身很常见，只看赋值与凭据形态。

/** URL 里用户名 / 密码与路径位置的占位（方括号在那里不合法）。识别用户信息时它不算凭据。 */
const REDACTED_WORD = 'redacted';

/**
 * 只在 URL 参数、表单与头部里才敏感的名字：OAuth 授权码 `code`、Google 等的 API Key
 * 参数 `key`、CAS 的 `ticket`、国内接口常见的签名 `sign`。JSON 里它们多是业务状态码、普通
 * 键名，改按值的形态判断（见 `redact-values.ts` 的 `looksLikeCredentialValue`）。
 */
const PARAM_ONLY_NAMES: ReadonlySet<string> = new Set(['code', 'key', 'ticket', 'sign']);

/** 只在完整的名字（参数名、JSON 字段名）等于它们时才敏感；自由文本里的同一个词不算（`10 tokens`）。 */
const NAME_ONLY_NAMES: ReadonlySet<string> = new Set(['tokens', 'secrets']);

/** 整个名字（规整后）等于这些就打码。 */
const SENSITIVE_NAMES: ReadonlySet<string> = new Set([
  'passcode', 'assertion', 'samlresponse', 'samlart', 'oobcode', 'privkey',
  'challengeresponse', 'challengeresponses',
  'token', 'auth', 'authorization', 'basicauth',
  'sid', 'sessid', 'sessionkey', 'devicecode', 'codeverifier',
  'totpcode', 'twofactorcode', '2facode',
  'apikey', 'accesskey', 'privatekey', 'credential', 'credentials',
  'sig', 'signature',
]);

/** 名字以这些（规整后）结尾就打码。 */
const SENSITIVE_SUFFIXES: readonly string[] = [
  'token', 'secret', 'apikey', 'accesskey', 'privatekey', 'secretkey', 'authkey', 'appkey',
  'applicationkey', 'subscriptionkey', 'clientkey', 'signingkey', 'encryptionkey', 'masterkey',
  'licensekey', 'accountkey', 'apikeys', 'accesskeys', 'secretkeys', 'privatekeys', 'session', 'sessionid', 'sessid', 'cookie', 'cookies', 'appcheck', 'otp', 'auth',
  'authorization', 'accesstokens', 'refreshtokens', 'authtokens', 'apitokens', 'idtokens', 'tokenhash',
  'pw', 'privkey', 'nonce',
  'credential', 'credentials', 'signature', 'verifier', 'assertion',
];

/**
 * 名字拆成单词（驼峰、分隔符、字母数字交界）后，任一单词是这些就算敏感：密码的各种缩写与
 * 多语种写法（`newPwd`、`userPass`、`pass1-text`、`neues_passwort`、`nova_senha`）、一次性口令等。
 * 只收几乎不会作普通词用的写法，`token`、`auth` 这类常见词不在此列（避免 `token_type`、
 * `auth_url` 误伤），它们按整名 / 后缀判断。
 */
const SENSITIVE_WORDS: ReadonlySet<string> = new Set([
  'pass', 'passe', 'pw', 'pwd', 'psw', 'pswd', 'passwd', 'passwrd', 'passwort', 'kennwort', 'senha',
  'contrasena', 'wachtwoord', 'pin', 'otp', 'totp', 'secret', 'hmac', 'jwt', 'csrf', 'xsrf', 'nonce', 'crumb',
]);

/** 名字里相邻两个单词连起来是这些就算敏感（`SMS_MFA_CODE`、`unused_codes`、`sessionInfo`）。 */
const SENSITIVE_WORD_PAIRS: ReadonlySet<string> = new Set([
  'mfacode', 'otpcode', 'smscode', 'authcode', 'verifycode', 'verificationcode', 'checkcode',
  'recoverycode', 'recoverycodes', 'backupcode', 'backupcodes', 'unusedcodes', 'sessioninfo',
  'temporaryproof', 'loginticket', 'signedrequest', 'usercode', 'confirmationcode', 'resetcode',
  'sessioncode', 'statehandle', 'interactionhandle', 'interactioncode', 'emailcode', 'bindingcode', 'tokenvalue',
  'securitycode', 'onetimecode', 'securityanswer',
]);

/**
 * 名字里有这些单词时本身不一定敏感（`token_type`、`auth_url`、`tokenName`），但值像凭据
 * （见 `redact-values.ts` 的 `looksLikeCredentialValue`）就打码：`tokenValue`、`sharedKey`、
 * Elasticsearch 的 `encoded`、Meteor 登录用的 `resume`。
 */
const CREDENTIAL_HINT_WORDS: ReadonlySet<string> = new Set([
  'token', 'tokens', 'key', 'keys', 'auth', 'session', 'encoded', 'credential', 'bearer', 'resume',
]);

/**
 * base64 / base64url 字符组成的一段（可以跨 MIME 风格的换行），如 AppSync 放在 `header=` 参数、
 * `header-<base64url>` 子协议里的认证信息。一段里可能先有普通文字（`Data-`、`/embed/`）再接
 * 真正的编码内容，所以起点在段内另找，见 `decodeBase64Json`。
 */
const BASE64_RUN = /(?:[A-Za-z0-9+/_-]|\r?\n)+={0,2}/g;
/**
 * 编码 JSON 的起点：JSON 文本首字节只能是 `{` `[` 或空白（空格、`\t`、`\n`、`\r`），编码后的
 * 首字符相应只能是 `e` `W` `I` `C` `D`；起点要么在段首，要么紧跟 `/` `_` `-` 或换行。
 */
const JSON_START_CHARS = 'eWICD';
const START_SEPARATORS = '/_-\n';
/** 起点后最多跳过这么多个空白字节再找 `{` / `[`；全是空白时按 JSON 处理（宁可多查）。 */
const MAX_LEADING_SPACE = 64;
/** 解码 base64 片段得到的字节按 UTF-8 解读；坏字节变成替换符，不影响其余内容可读。 */
const utf8 = new TextDecoder();

/** 以 `session` 结尾却与会话无关的普通词。 */
const SESSION_LOOKALIKES: readonly string[] = ['possession', 'obsession'];

/** 名字里包含这些（规整后）就打码：密码类字段变体多（`password_confirmation`、`new_password2`）。 */
const SENSITIVE_PARTS: readonly string[] = ['password', 'passwd', 'passphrase'];

/** 自由文本里的一段「词串」（标识符、带连字符 / 下划线 / 点的名字）。 */
const WORD_RUN = /[A-Za-z0-9_$.-]+/g;
/** 名字 / 词串拆成单词：分隔符、驼峰、字母与数字的交界。 */
const SUBWORD_BOUNDARY = /[^A-Za-z0-9]+|(?<=[a-z])(?=[A-Z])|(?<=[A-Z])(?=[A-Z][a-z])|(?<=[A-Za-z])(?=[0-9])|(?<=[0-9])(?=[A-Za-z])/;
/** Bearer 令牌（含 Kubernetes 放在 WebSocket 子协议里的 `base64url.bearer.authorization.k8s.io.<token>`）。 */
const BEARER = /(?<![A-Za-z0-9])bearer[\s.]+[\w~+/=.-]/i;
/** Basic 凭据：base64 串里至少有一个数字、大写字母或 `+` `/` `=`（`basic information` 这类普通词组不算）。 */
const BASIC = /(?<![A-Za-z0-9])[Bb][Aa][Ss][Ii][Cc]\s+(?=[A-Za-z0-9+/]*[0-9A-Z+/=])[A-Za-z0-9+/]+/;
/**
 * 可能是 JWT 的三段式：第一段解码后是带 `alg` 的 JOSE 头才算（头部 JSON 允许有空白，不能只认
 * `eyJ`）；载荷可以是 `{}`（`e30`），不限长度。
 */
const JWT_CANDIDATE = /(?<![\w-])([A-Za-z0-9_-]{4,})\.[A-Za-z0-9_-]*\./g;
/**
 * 「名字 + `=`」：名字只从一段标识符的开头匹配（后行断言），并用「先行断言 + 反向引用」
 * 固定下来不再回吐字符，长串的令牌或 `]` 不会让正则回溯成平方级。名字后可以跟转义符、
 * 引号与右方括号（`a["token"]=`）。
 */
const ASSIGNMENT = /(?<![\w$.\-[\]])(?=([\w$.\-[\]]+))\1[\\"'\]]*\s*=/g;
/** URL 的 authority：`//` 之后，或 `https:` 这类特殊协议之后（浏览器允许省略、多写斜杠）。 */
const AUTHORITY_AFTER_SLASHES = /\/\/([^\s/?#]*)/g;
const AUTHORITY_AFTER_SCHEME = /(?<![a-z0-9+.-])(?:https?|wss?|ftp|file):\/*([^\s/?#]*)/gi;
/** 结构化文本里出现这些字符，说明内嵌了 JSON、引号或尖括号包着的内容：按自由文本再检查一遍。 */
const EMBEDDED_STRUCTURE = /[{}"'<>]/;
/** 标识符形态的名字（参数名、字段名）。 */
const IDENTIFIER_NAME = /^[\w$.\-[\]]*$/;

/**
 * 名字出现的位置：`param`（URL 参数、表单字段、请求头）、`field`（JSON 字段）、`word`
 * （自由文本里的一个词）。
 */
type NameContext = 'param' | 'field' | 'word';

/** 去掉重音符号（`contraseña` → `contrasena`），否则这些字母会被当成分隔符丢掉。 */
function stripAccents(text: string): string {
  return text.normalize('NFD').replace(/\p{M}/gu, '');
}

function normalizeName(name: string): string {
  const letters = stripAccents(name).toLowerCase().replace(/[^a-z0-9]/g, '');
  // 去掉末尾数字：从尾部逐字扫描（`[0-9]+$` 遇到中间的长数字串会回溯成平方级）
  let end = letters.length;
  while (end > 0 && letters.charCodeAt(end - 1) >= 48 && letters.charCodeAt(end - 1) <= 57) end--;
  return letters.slice(0, end);
}

function isSensitiveSegment(segment: string, context: NameContext): boolean {
  const normalized = normalizeName(segment);
  if (!normalized) return false;
  if (context === 'param' && PARAM_ONLY_NAMES.has(normalized)) return true;
  if (context !== 'word' && NAME_ONLY_NAMES.has(normalized)) return true;
  const sessionLookalike = SESSION_LOOKALIKES.some((word) => normalized.endsWith(word));
  return (
    SENSITIVE_NAMES.has(normalized)
    // 不带分隔的小写写法（`smscode`、`authcode`）
    || SENSITIVE_WORD_PAIRS.has(normalized)
    || SENSITIVE_SUFFIXES.some((suffix) => normalized.endsWith(suffix) && !(sessionLookalike && suffix === 'session'))
    || SENSITIVE_PARTS.some((part) => normalized.includes(part))
  );
}

/** 名字拆成的单词（小写、去掉重音）。 */
function nameWords(name: string): string[] {
  return stripAccents(name).split(SUBWORD_BOUNDARY).filter(Boolean).map((word) => word.toLowerCase());
}

/** 名字里有没有「本身不一定敏感、值像凭据才算」的提示单词。 */
function hasCredentialHintWord(name: string): boolean {
  return nameWords(name).some((word) => CREDENTIAL_HINT_WORDS.has(word));
}

/** 名字里的单词有没有命中敏感单词或敏感的相邻单词组合。 */
function hasSensitiveNameWord(name: string): boolean {
  const words = nameWords(name);
  return words.some((word, i) => SENSITIVE_WORDS.has(word) || (i > 0 && SENSITIVE_WORD_PAIRS.has(words[i - 1] + word)));
}

/**
 * 名字是否属于敏感信息。`context` 为 `param` 时额外把 `code` / `key` / `ticket` / `sign` 算作
 * 敏感；`word`（自由文本里的词）时不算 `tokens` 这类只在完整名字里才敏感的词。`user[auth]`、
 * `a.b.token` 这类结构化的名字按每一段分别判断；名字里的单词另按敏感单词表判断。
 */
function isSensitiveName(name: string, context: NameContext = 'field'): boolean {
  if (isSensitiveSegment(name, context)) return true;
  const segments = name.split(/[[\].]+/).filter(Boolean);
  if (segments.length > 1 && segments.some((segment) => isSensitiveSegment(segment, context))) return true;
  return hasSensitiveNameWord(name);
}

// ─── 凭据迹象 ───

/**
 * 只解码 ASCII 范围的转义（`%XX`、`+`、`\uXXXX`、`\xXX`、`&#NN;` / `&#xNN;`），足以还原
 * 被编码的名字与 `=` `:` `@` 等结构字符；非法转义原样保留，不会报错。
 */
function decodeAscii(text: string): string {
  const ascii = (code: number, original: string) => (code < 0x80 ? String.fromCharCode(code) : original);
  return text
    .replace(/\+/g, ' ')
    .replace(/%([0-9a-f]{2})/gi, (m, hex: string) => ascii(parseInt(hex, 16), m))
    .replace(/\\u([0-9a-f]{4})|\\x([0-9a-f]{2})/gi, (m, u?: string, x?: string) => ascii(parseInt(u ?? x!, 16), m))
    .replace(/&#(?:x([0-9a-f]{1,6})|([0-9]{1,7}));/gi, (m, hex?: string, dec?: string) =>
      ascii(hex != null ? parseInt(hex, 16) : parseInt(dec!, 10), m));
}

/** 原文与逐层解转义后的各个版本（最多三层）。解到第四层仍有变化时返回 undefined。 */
function unescapedViews(text: string): string[] | undefined {
  const views = [text];
  for (let round = 0; round < 3; round++) {
    const next = decodeAscii(views[views.length - 1]);
    if (next === views[views.length - 1]) return views;
    views.push(next);
  }
  return decodeAscii(views[views.length - 1]) === views[views.length - 1] ? views : undefined;
}

/**
 * 检查凭据迹象时要看的各个版本：原文、逐层解转义后的版本、去掉重音的版本（自由文本按 ASCII
 * 拆词，`contraseña` 不去重音会被拆散），以及其中 base64 包着的 JSON 解码后的版本（里面的
 * Authorization、JWT 才看得见；解码结果同样逐层解转义）。转义层数过多时返回 undefined（按有
 * 迹象处理）。
 */
function decodedViews(text: string): string[] | undefined {
  const views = unescapedViews(text);
  if (!views) return undefined;
  const plain = stripAccents(views[views.length - 1]);
  if (plain !== views[views.length - 1]) views.push(plain);
  // 每个版本都找 base64 片段：原文里的 `+` 在解转义后会变成空格，只看最后一层会把片段截断
  const embedded = new Set<string>();
  for (const view of [...views]) {
    for (const decoded of decodeBase64Json(view)) embedded.add(decoded);
  }
  for (const decoded of embedded) {
    const inner = unescapedViews(decoded);
    if (!inner) return undefined;
    // 里面还套着一层 base64 JSON：不再逐层解下去（每层都会放大检查量），按有迹象处理
    if (inner.some((view) => decodeBase64Json(view).length > 0)) return undefined;
    views.push(...inner, stripAccents(inner[inner.length - 1]));
  }
  return views;
}

/** 从字节串的 `offset` 起，跳过空白后是不是 `{` / `[`（JSON 的开头）。 */
function startsJson(binary: string, offset: number): boolean {
  let i = offset;
  while (i < binary.length && i - offset < MAX_LEADING_SPACE && /[ \t\n\r]/.test(binary[i])) i++;
  if (i - offset >= MAX_LEADING_SPACE) return true;
  return binary[i] === '{' || binary[i] === '[';
}

/**
 * 文本里 base64 编码的 JSON 片段逐个解码（按 UTF-8）。每段先找出所有可能的起点，再按起点
 * 在 4 字符分组里的位置，把整段按 4 种对齐各解码一次：从第 k 个字符开始的内容就是第
 * `k % 4` 种解码结果从第 `(k >> 2) * 3` 个字节起的部分。每种对齐取第一个解出 JSON 开头的
 * 起点，从那里到段尾作为结果（后面再出现的编码内容也包含在内）。每段最多解码 4 次，保持线性。
 */
function decodeBase64Json(text: string): string[] {
  const parts: string[] = [];
  for (const [run] of text.matchAll(BASE64_RUN)) {
    if (run.length < 12) continue;
    let clean = '';
    const starts: number[] = [];
    let previous = '';
    for (const char of run) {
      if (char === '\r' || char === '\n') {
        previous = '\n';
        continue;
      }
      if (JSON_START_CHARS.includes(char) && (clean.length === 0 || START_SEPARATORS.includes(previous))) {
        starts.push(clean.length);
      }
      clean += char === '-' ? '+' : char === '_' ? '/' : char;
      previous = char;
    }
    clean = clean.replace(/=+$/, '');
    for (let alignment = 0; alignment < 4; alignment++) {
      const aligned = starts.filter((start) => start % 4 === alignment);
      if (aligned.length === 0) continue;
      let base64 = clean.slice(alignment);
      if (base64.length % 4 === 1) base64 = base64.slice(0, -1);
      let binary: string;
      try {
        binary = atob(base64.padEnd(Math.ceil(base64.length / 4) * 4, '='));
      } catch {
        continue;
      }
      const first = aligned.map((start) => ((start - alignment) >> 2) * 3).find((offset) => startsJson(binary, offset));
      if (first == null) continue;
      parts.push(utf8.decode(Uint8Array.from(binary.slice(first), (char) => char.charCodeAt(0))));
    }
  }
  return parts;
}

/**
 * 带用户信息的 URL：`//user:pass@`、`https:user@`、`https:\\user@`。浏览器解析 URL 时会去掉
 * 制表符与换行、把反斜杠当作斜杠，检查前同样处理。用户信息恰好是本模块写出的占位
 * `redacted` 时不算。
 */
function hasUrlUserinfo(text: string): boolean {
  const view = text.replace(/[\t\n\r]/g, '').replace(/\\/g, '/');
  for (const pattern of [AUTHORITY_AFTER_SLASHES, AUTHORITY_AFTER_SCHEME]) {
    for (const [, authority] of view.matchAll(pattern)) {
      const at = authority.lastIndexOf('@');
      if (at >= 0 && authority.slice(0, at).toLowerCase() !== REDACTED_WORD) return true;
    }
  }
  return false;
}

function hasJwt(text: string): boolean {
  for (const [, header] of text.matchAll(JWT_CANDIDATE)) {
    // 超长的候选不解码：像 JWT 头（`eyJ` 即 `{"` 的编码）就按 JWT 处理
    if (header.length > 4096) {
      if (header.startsWith('eyJ')) return true;
      continue;
    }
    try {
      const base64 = header.replace(/-/g, '+').replace(/_/g, '/');
      const jose: unknown = JSON.parse(atob(base64.padEnd(Math.ceil(base64.length / 4) * 4, '=')));
      if (jose && typeof jose === 'object' && 'alg' in jose) return true;
    } catch {
      // 不是合法的 base64 / JSON：不是 JWT
    }
  }
  return false;
}

/** 不依赖名字的凭据形态：带用户信息的 URL、Bearer / Basic 凭据、JWT。 */
function hasCredentialShape(view: string): boolean {
  return hasUrlUserinfo(view) || BEARER.test(view) || BASIC.test(view) || hasJwt(view);
}

/** 一段词串里有没有敏感词：整段、拆开后的每个单词、相邻两个单词连起来（`api key`、`apiKey`）。 */
function runHasSensitiveWord(run: string, previous: string | undefined): boolean {
  if (isSensitiveName(run, 'word')) return true;
  const words = run.split(SUBWORD_BOUNDARY).filter(Boolean);
  for (const [i, word] of words.entries()) {
    if (isSensitiveSegment(word, 'word')) return true;
    if (i > 0 && isSensitiveSegment(words[i - 1] + word, 'word')) return true;
  }
  if (previous == null || words.length === 0) return false;
  // 跨空格的两个词（`recovery codes`、`api key`）
  const pair = previous + words[0];
  return isSensitiveSegment(pair, 'word') || SENSITIVE_WORD_PAIRS.has(pair.toLowerCase());
}

function hasSensitiveWord(text: string): boolean {
  let previous: string | undefined;
  for (const [run] of text.matchAll(WORD_RUN)) {
    if (runHasSensitiveWord(run, previous)) return true;
    const words = run.split(SUBWORD_BOUNDARY).filter(Boolean);
    previous = words[words.length - 1];
  }
  return false;
}

/** 敏感名字（按参数语境：含 `code` / `key` / `ticket` / `sign`）的 `=` 赋值。 */
function hasSensitiveAssignment(view: string): boolean {
  for (const match of view.matchAll(ASSIGNMENT)) {
    if (isSensitiveName(match[1], 'param')) return true;
  }
  return false;
}

function secretHintsInView(view: string): boolean {
  if (hasSensitiveAssignment(view) || hasCredentialShape(view)) return true;
  // 只有一个由字母单词（可带末尾数字）组成的短词（枚举值 `refresh_token`、名字
  // `Authorization`、元素 id `pw1`）或 Firebase 式的小写错误码（`auth/invalid-email`）：没有
  // 装值的位置。带 `.` 或字母数字混排的（`password.x`、`pi_3Mtw…_secret_…`）不算这种词
  const trimmed = view.trim();
  if (trimmed.length <= 40 && /^[A-Za-z]+[0-9]*(?:[_-][A-Za-z]+[0-9]*){0,3}$/.test(trimmed)) return false;
  if (trimmed.length <= 40 && /^[a-z]+\/[a-z]+(?:-[a-z]+)*$/.test(trimmed)) return false;
  return hasSensitiveWord(view);
}

function structuralHintsInView(view: string): boolean {
  if (hasSensitiveAssignment(view) || hasCredentialShape(view)) return true;
  return EMBEDDED_STRUCTURE.test(view) && secretHintsInView(view);
}

/**
 * 自由文本里是否有凭据迹象：敏感名字的 `=` 赋值（含 `key=`、`code=`）、敏感词、带用户信息
 * 的 URL、Bearer / Basic 凭据、JWT。
 * 转义编码过的内容同样检查。
 */
function hasSecretHints(text: string): boolean {
  const views = decodedViews(text);
  return !views || views.some(secretHintsInView);
}

/**
 * 结构化文本（URL 路径、取值是名字列表的头）里是否有凭据迹象：敏感名字的 `=` 赋值、
 * 不依赖名字的凭据形态；内嵌了 JSON、引号、尖括号时再按自由文本检查。这类文本里敏感词
 * 本身很常见（`/auth/login`、`Vary: Cookie`），所以平时不按词判断。
 */
function hasStructuralHints(text: string): boolean {
  const views = decodedViews(text);
  return !views || views.some(structuralHintsInView);
}

/**
 * 名字（参数名、JSON 字段名）本身是否装着凭据：按结构化规则检查；不是标识符形态（整段
 * JSON 被当成参数名、`password: …` 这样的字段名）时再按自由文本检查。
 */
function hasNameHints(name: string): boolean {
  const views = decodedViews(name);
  return !views || views.some((view) =>
    structuralHintsInView(view) || (!IDENTIFIER_NAME.test(view) && secretHintsInView(view)));
}

function looksLikeJson(text: string): boolean {
  const trimmed = text.trimStart();
  return trimmed.startsWith('{') || trimmed.startsWith('[');
}

/**
 * 整段（不含首尾空白）是一个 URL 或 URL 引用（绝对、协议相对、根相对、`./` `../` 相对、
 * 只有查询串）。带 authority 时主机部分只能是合法的主机字符，`//{"token":…}` 这类不算。
 */
function looksLikeUrl(text: string): boolean {
  if (!/^(?:[a-z][a-z0-9+.-]*:\/\/|\/|\.{1,2}\/|\?)\S*$/i.test(text)) return false;
  const authority = /^(?:[a-z][a-z0-9+.-]*:)?\/\/([^/?#]*)/i.exec(text)?.[1];
  return authority == null || /^[\w.~%!$&'()*+,;=:@[\]-]*$/.test(authority);
}

/** 名字（含多层编码后的写法）是否敏感；默认按参数语境。 */
function isSensitiveEncodedName(name: string, context: NameContext = 'param'): boolean {
  const views = decodedViews(name);
  return !views || views.some((view) => isSensitiveName(view, context));
}

// ─── 公开 API ───

export {
  REDACTED_WORD,
  hasCredentialHintWord,
  hasNameHints,
  hasSecretHints,
  hasStructuralHints,
  hasUrlUserinfo,
  isSensitiveName,
  isSensitiveEncodedName,
  looksLikeJson,
  looksLikeUrl,
};
