import { defineCollection } from 'astro:content';
import { z } from 'astro/zod';
import { glob } from 'astro/loaders';

// 文档集合：每篇文章一个文件夹，content/docs/<lang>/<group>/<slug>/index.mdx；
// 截图等资源放各自文件夹的 images/ 子目录，目录不混杂。
// 新增一篇文档 = 新建一个文件夹 + index.mdx（带下面的 frontmatter），自动进侧栏 + 路由。
//
// generateId 保留原始相对路径（去扩展名），不走默认 slugify——默认会把 `zh-TW`
// 小写成 `zh-tw`，与我们大小写敏感的 Lang 码（'zh-TW'）不符，导致该语言文档被漏掉。
const docs = defineCollection({
  loader: glob({
    pattern: '**/index.mdx',
    base: './src/content/docs',
    generateId: ({ entry }) => entry.replace(/\.mdx$/, ''),
  }),
  schema: z.object({
    title: z.string(),
    description: z.string(),
    /** 搜索摘要与页面导航名称分开，未填写时沿用原字段。 */
    seoTitle: z.string().optional(),
    seoDescription: z.string().optional(),
    /** 分组 key（与 i18n 里 docs.groups 的键一致），决定归到侧栏哪一组 */
    group: z.string(),
    /** 组内排序，小的在前 */
    order: z.number().default(100),
    /** 隐藏（草稿）：true 时不进侧栏 / 不生成路由 */
    draft: z.boolean().default(false),
    /** 占位页：仍进侧栏 + 生成路由，但加 noindex（内容待补，不该被搜索引擎收录） */
    placeholder: z.boolean().default(false),
  }),
});

export const collections = { docs };
