import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { Lang } from './i18n';

// 构建期解析根目录的 CHANGELOG.md（单一来源）。仅在构建/SSG 期运行，cwd 为 site/，
// 故仓库根的 CHANGELOG.md 在 ../CHANGELOG.md。
// 文件格式（Keep a Changelog + 本项目双语约定）：
//   ## [Unreleased]            或   ## 1.3.2 - 2026-06-14
//   ### 新增 / Added                （小节标题：中文 / English）
//   - 中文条目…                     （先列全部中文）
//   （空行）
//   - English bullets…             （再列全部对应英文）
// 解析时按「空行」把每个小节的条目分成中文 / 英文半区，按站点语言取用。
const CHANGELOG_PATH = resolve(process.cwd(), '../CHANGELOG.md');
const GH = 'https://github.com/maotoumao/Cebian';

type Kind = 'added' | 'changed' | 'fixed' | 'removed' | 'breaking' | 'other';

// ── 内部：解析出的双语原始结构 ──
interface RawSection {
  headingZh: string;
  headingEn: string;
  kind: Kind;
  zh: string[];
  en: string[];
}
interface RawRelease {
  version: string;
  unreleased: boolean;
  date: string | null;
  sections: RawSection[];
}

// ── 按语言展开后的结构（由 readChangelog 返回，类型经推断暴露给调用方）──
interface ChangelogEntry {
  html: string;
}
interface ChangelogSection {
  label: string;
  kind: Kind;
  entries: ChangelogEntry[];
}
export interface ChangelogRelease {
  version: string;
  unreleased: boolean;
  date: string | null;
  sections: ChangelogSection[];
}

function sectionKind(headingEn: string): Kind {
  const k = headingEn.toLowerCase();
  if (k.includes('add')) return 'added';
  if (k.includes('chang')) return 'changed';
  if (k.includes('fix')) return 'fixed';
  if (k.includes('remov')) return 'removed';
  if (k.includes('break')) return 'breaking';
  return 'other';
}

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** 渲染条目内的 inline markdown：`code`、Markdown 链接、裸 (#NNN) → HTML。 */
function renderInline(text: string): string {
  let t = text.replace(/\\`/g, '`'); // 还原源文件里被转义的反引号
  t = esc(t);
  // inline code
  t = t.replace(/`([^`]+)`/g, (_m, code) => `<code>${code}</code>`);
  // Markdown 链接 [label](url)：#NNN / @user 加 cl-ref 样式，其余正常链接
  t = t.replace(/\[([^\]]+)\]\((https?:\/\/[^)]+)\)/g, (_m, label, url) => {
    const isMeta = /^#\d+$/.test(label) || label.startsWith('@');
    const cls = isMeta ? ' class="cl-ref"' : '';
    return `<a${cls} href="${url}" target="_blank" rel="noopener">${label}</a>`;
  });
  // 兼容旧格式裸 (#NNN)
  t = t.replace(/\(#(\d+)\)/g, (_m, n) => ` <a class="cl-ref" href="${GH}/issues/${n}" target="_blank" rel="noopener">#${n}</a>`);
  return t;
}

/** 把一个小节正文（中/英两半、空行分隔）拆成 { zh, en } 条目数组。 */
function splitBullets(lines: string[]): { zh: string[]; en: string[] } {
  const zh: string[] = [];
  const en: string[] = [];
  let half: string[] = zh;
  let switched = false;
  for (const raw of lines) {
    const line = raw.trim();
    if (line === '') {
      if (half === zh && zh.length > 0 && !switched) { half = en; switched = true; }
      continue;
    }
    const m = line.match(/^-\s+(.*)$/);
    if (m) half.push(m[1]);
  }
  return { zh, en: en.length ? en : zh };
}

function parseRaw(): RawRelease[] {
  const lines = readFileSync(CHANGELOG_PATH, 'utf-8').split(/\r?\n/);
  const releases: RawRelease[] = [];
  let cur: RawRelease | null = null;
  let secLines: string[] | null = null;
  let secHeading: { zh: string; en: string } | null = null;

  const flush = () => {
    if (!cur || !secHeading || !secLines) return;
    const { zh, en } = splitBullets(secLines);
    if (zh.length || en.length) {
      cur.sections.push({
        headingZh: secHeading.zh,
        headingEn: secHeading.en,
        kind: sectionKind(secHeading.en),
        zh,
        en,
      });
    }
    secLines = null;
    secHeading = null;
  };

  for (const line of lines) {
    const ver = line.match(/^##\s+(?!#)(.+?)\s*$/);
    if (ver) {
      flush();
      const head = ver[1].trim();
      const unreleased = /^\[?unreleased\]?$/i.test(head);
      let version = head;
      let date: string | null = null;
      if (unreleased) {
        version = 'Unreleased';
      } else {
        const dm = head.match(/^(.+?)\s*-\s*(\d{4}-\d{2}-\d{2})\s*$/);
        if (dm) { version = dm[1].trim(); date = dm[2]; }
      }
      cur = { version, unreleased, date, sections: [] };
      releases.push(cur);
      continue;
    }
    const sec = line.match(/^###\s+(.+?)\s*$/);
    if (sec && cur) {
      flush();
      const parts = sec[1].split('/').map((s) => s.trim());
      secHeading = { zh: parts[0] ?? sec[1], en: parts[1] ?? parts[0] ?? sec[1] };
      secLines = [];
      continue;
    }
    if (secLines) secLines.push(line);
  }
  flush();
  // 只保留真正的版本节（标题之前的「约定」列表没有版本号，不会建 release）。
  return releases.filter((r) => r.sections.length > 0 || r.unreleased);
}

/** 按站点语言展开 changelog（中文站取中文条目 + 中文小节名；英文站取英文）。 */
export function readChangelog(lang: Lang): ChangelogRelease[] {
  const useChinese = lang === 'zh' || lang === 'zh-TW';
  return parseRaw().map((r) => ({
    version: r.version,
    unreleased: r.unreleased,
    date: r.date,
    sections: r.sections.map((s) => ({
      label: useChinese ? s.headingZh : s.headingEn,
      kind: s.kind,
      entries: (useChinese ? s.zh : s.en).map((b) => ({ html: renderInline(b) })),
    })),
  }));
}

/** version 的 major.minor 键；非 semver 版本自成一组（返回原串）。 */
function minorKey(version: string): string {
  const m = version.match(/^(\d+)\.(\d+)/);
  return m ? `${m[1]}.${m[2]}` : version;
}

/**
 * 决定默认展开哪些版本：未发布版始终展开；已发布版展开「最新 minor 组」的全部
 * patch 版本，若该组只有 1 个版本，再额外展开上一个 minor 组。剩余版本折叠。
 */
export function splitReleases(releases: ChangelogRelease[]): {
  shown: ChangelogRelease[];
  folded: ChangelogRelease[];
} {
  const shown: ChangelogRelease[] = [];
  const released: ChangelogRelease[] = [];
  for (const r of releases) {
    (r.unreleased ? shown : released).push(r);
  }

  const folded: ChangelogRelease[] = [];
  if (released.length > 0) {
    const firstKey = minorKey(released[0].version);
    const expand = new Set([firstKey]);
    const firstCount = released.filter((r) => minorKey(r.version) === firstKey).length;
    if (firstCount === 1) {
      const next = released.find((r) => minorKey(r.version) !== firstKey);
      if (next) expand.add(minorKey(next.version));
    }
    for (const r of released) {
      (expand.has(minorKey(r.version)) ? shown : folded).push(r);
    }
  }
  return { shown, folded };
}
