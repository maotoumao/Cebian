// dependency-cruiser 架构护栏 · Phase 0
// 规则依据: docs/plans/2026-07-18-architecture-guardrails.md
// 本阶段只含「分层方向 + capability 文件夹」规则；执行上下文后缀（.bg/.page）
// 规则在改名子任务后单独加入。
/** @type {import('dependency-cruiser').IConfiguration} */
module.exports = {
  forbidden: [
    // ── 无环 ──
    // 只禁「运行时」循环：整环全由 type-only 边构成的 SCC 不算（如 dialog registry、
    // user-permission requester registry）——与架构台账 §2.3「擦除 type-only 边后无
    // 运行时 SCC」的结论一致。viaOnly + dependencyTypesNot 表示「环中每一条边都不是
    // type-only」才判违规。
    {
      name: 'no-circular',
      severity: 'error',
      comment: '不允许运行时循环依赖',
      from: {},
      to: {
        circular: true,
        viaOnly: { dependencyTypesNot: ['type-only'] },
      },
    },

    // ── 分层方向: entrypoints → components → hooks → lib ──
    {
      name: 'hooks-no-up',
      severity: 'error',
      comment: 'hooks 不得依赖 components / entrypoints',
      from: { path: '^hooks/', pathNot: '\\.test\\.' },
      to: { path: '^(components|entrypoints)/' },
    },
    {
      name: 'components-no-entrypoints',
      severity: 'error',
      comment: 'components 不得依赖 entrypoints',
      from: { path: '^components/', pathNot: '\\.test\\.' },
      to: { path: '^entrypoints/' },
    },
    {
      name: 'lib-no-up-runtime',
      severity: 'error',
      comment: 'lib 不得【运行时】依赖 components / hooks / entrypoints；import type 例外（wire / renderer contract）',
      from: { path: '^lib/', pathNot: '\\.test\\.' },
      to: { path: '^(components|hooks|entrypoints)/', dependencyTypesNot: ['type-only'] },
    },

    // ── capability 文件夹边界 ──
    {
      name: 'background-no-lib-ui',
      severity: 'error',
      comment: 'background 不得依赖 lib/ui（DOM / toast）',
      from: { path: '^entrypoints/background/' },
      to: { path: '^lib/ui/' },
    },
    {
      name: 'content-no-lib-browser',
      severity: 'error',
      comment: 'content script 不得依赖 lib/browser（Chrome / CDP）',
      from: { path: '\\.content/' },
      to: { path: '^lib/browser/' },
    },
    {
      name: 'content-no-vfs',
      severity: 'error',
      comment: 'content script 不得依赖 extension-origin VFS',
      from: { path: '\\.content/' },
      to: { path: '^lib/persistence/vfs\\.ts$' },
    },
  ],

  options: {
    // 解析 @/ alias（tsconfig 定义 @/* → ./*）
    tsConfig: { fileName: 'tsconfig.json' },
    // 识别 import type → 让 dependencyTypesNot: ['type-only'] 生效
    tsPreCompilationDeps: true,
    doNotFollow: { path: 'node_modules' },
    // node_modules / .wxt 生成目录 / ambient 声明都不进依赖图（减少无关噪声）
    exclude: { path: '(^|/)(node_modules|\\.wxt)/|\\.d\\.ts$' },
  },
};
