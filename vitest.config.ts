import { defineConfig } from 'vitest/config';
import { WxtVitest } from 'wxt/testing/vitest-plugin';

// WxtVitest 会：用内存版 @webext-core/fake-browser 注入 `browser` API、
// 接管 `wxt.config.ts` 的 vite 配置与插件、配置 `#imports` auto-import、
// 设置 `@/*` 等别名。测试因此能像生产代码一样 import 各模块。
//
// 单元测试就近协置：放在被测文件同目录下的同名 `*.test.ts`，只覆盖高风险逻辑，
// 不强求每个文件都有。顶层 test/ 目录留给将来真正串联多文件的 E2E/集成测试。
export default defineConfig({
  // WxtVitest 的返回类型按 wxt 自带的 vite 版本声明，与 vitest 拉入的 vite
  // 版本存在纯类型层面的 skew（运行无影响），用 any 收敛。
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  plugins: [WxtVitest() as any],
  test: {
    include: ['**/*.test.ts'],
    exclude: ['**/node_modules/**', '.wxt/**', '.output/**', 'dist/**', 'site/**'],
  },
});
