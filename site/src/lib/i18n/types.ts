// 站点文案字典的形状。每种语言导出同一形状的对象。
// 随各页面落地逐步扩充。所有正文文本都来自这里，组件内不硬编码（Cebian 除外）。

export interface Dict {
  /** 站点级 meta */
  site: {
    name: string;
    tagline: string;
    description: string;
  };
  nav: {
    home: string;
    docs: string;
    changelog: string;
    sponsor: string;
    github: string;
    install: string;
    menu: string;
    theme: string;
    language: string;
  };
  footer: {
    tagline: string;
    createdBy: string;
    productHeading: string;
    resourcesHeading: string;
    moreHeading: string;
    docs: string;
    changelog: string;
    installGuide: string;
    github: string;
    releases: string;
    issues: string;
    sponsor: string;
    privacy: string;
    about: string;
    /** 底部社交图标（aria-label 用） */
    social: {
      /** 图标列表的无障碍组标签 */
      follow: string;
      wechat: string;
      bilibili: string;
      xiaohongshu: string;
      x: string;
    };
  };
  /** 首页各区块 */
  home: {
    hero: {
      titleLead: string;
      titleAccent: string;
      ctaInstall: string;
      ctaDocs: string;
      heroShotLabel: string;
    };
    trust: { title: string; note: string }[];
    /** 演示视频的暂停 / 播放按钮无障碍文案 */
    videoPause: string;
    videoPlay: string;
    features: {
      title: string;
      body: string;
      points: string[];
      shotLabel: string;
    }[];
    capabilities: {
      heading: string;
      lead: string;
      skillsTitle: string;
      skillsBody: string;
      skillExampleName: string;
      skillExampleDesc: string;
      mcpTitle: string;
      mcpBody: string;
      privacyTitle: string;
      privacyBody: string;
      privacyNote: string;
    };
    install: {
      heading: string;
      lead: string;
      latestBadge: string;
      steps: string[];
      goCta: string;
      options: {
        github: { title: string; desc: string };
        chrome: { title: string; desc: string };
        edge: { title: string; desc: string };
      };
    };
  };
  notFound: {
    title: string;
    body: string;
    back: string;
  };
  /** 文档系统的外壳文案（分组名、侧栏、目录等） */
  docs: {
    title: string;
    lead: string;
    /** 侧栏分组的 key → 显示名 + 顺序（数组顺序即展示顺序） */
    groups: { key: string; label: string }[];
    onThisPage: string;
    sidebarHeading: string;
    prev: string;
    next: string;
    /** 文档索引页：每组下方「N 篇」之类（可留空） */
    edit: string;
  };
  /** 更新日志页 */
  changelog: {
    title: string;
    lead: string;
    unreleased: string;
    /** 折叠区展开按钮，含 {n} 占位（更早版本数量） */
    showOlder: string;
  };
  /** 赞助页 */
  sponsor: {
    title: string;
    lead: string;
    kofi: { title: string; desc: string; cta: string };
    wechat: { title: string; desc: string; hint: string; viewLarge: string };
    followHeading: string;
    channels: {
      blog: string;
      bilibili: string;
      xiaohongshu: string;
      x: string;
      wechatPublic: string;
    };
  };
  /** 关于页 */
  about: {
    title: string;
    lead: string;
    whatTitle: string;
    whatBody: string;
    authorTitle: string;
    authorBody: string;
    licenseTitle: string;
    licenseBody: string;
    feedbackTitle: string;
    feedbackBody: string;
    feedbackCta: string;
    linksHeading: string;
    links: { repo: string; releases: string; sponsor: string; privacy: string };
  };
}
