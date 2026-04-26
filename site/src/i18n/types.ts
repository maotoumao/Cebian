// Shape of all translatable content on the site.
// zh.ts and en.ts export objects of this shape.

export type Dict = {
  nav: {
    home: string;
    install_guide: string;
    docs: string;
    about: string;
    github: string;
    install_cta: string;
  };
  footer: {
    tagline: string;
    made_with: string;
    author: string;
    author_url: string;
    license: string;
    links_heading: string;
    resources_heading: string;
    privacy: string;
    contact: string;
    copyright: string;
  };
  common: {
    screenshot_placeholder: string;
    coming_soon: string;
    learn_more: string;
    back_to_top: string;
    read_docs: string;
    on_github: string;
    switch_language: string;
    switch_theme: string;
  };
  home: {
    headline_lead: string;
    headline_accent: string;
    headline_tail: string;
    subhead: string;
    cta_install: string;
    cta_install_guide: string;
    badges: { multi_provider: string; mcp: string; skills: string; local_first: string; open_source: string; };
    hero_screenshot_caption: string;
    sidebar_alt: string;
    sidebar_placeholder: string;
    why_heading: string;
    why_lead: string;
    why_cards: Array<{ title: string; body: string }>;
    features_heading: string;
    features_cards: Array<{ title: string; body: string; tag: string }>;
    scenarios_heading: string;
    scenarios_lead: string;
    scenarios: Array<{ title: string; body: string }>;
    cta_heading: string;
    cta_body: string;
  };
  install_guide: {
    title: string;
    lead: string;
    eyebrows: { requirements: string; steps: string; next: string };
    next_cta: string;
    requirements_heading: string;
    requirements: string[];
    steps_heading: string;
    steps: Array<{ step: string; title: string; body: string; code?: string }>;
    firefox_heading: string;
    firefox_body: string;
    troubleshoot_heading: string;
    troubleshoot: Array<{ q: string; a: string }>;
    after_install_heading: string;
    after_install_body: string;
  };
  docs: {
    title: string;
    lead: string;
    eyebrow: string;
    read_cta: string;
    wip_label: string;
    wip_text: string;
    index_items: Array<{ slug: string; title: string; body: string; tag: string }>;
    pager: { prev: string; next: string; index: string };
    getting_started: {
      title: string;
      lead: string;
      body: string;
      eyebrow: string;
      tip_tag: string;
      steps: Array<{ title: string; body: string }>;
      tip_heading: string;
      tip_body: string;
    };
    prompts: {
      title: string;
      lead: string;
      body: string;
      eyebrow: string;
      variables_tag: string;
      example_tag: string;
      panel_tag: string;
      variables_heading: string;
      variables: Array<{ name: string; desc: string }>;
      example_heading: string;
      example_body: string;
      example_code: string;
      panel_heading: string;
      panel_body: string;
      panel_bullets: string[];
    };
    skills: {
      title: string;
      lead: string;
      body: string;
      eyebrow: string;
      when_tag: string;
      structure_tag: string;
      panel_tag: string;
      when_heading: string;
      when_body: string;
      structure_heading: string;
      structure_body: string;
      structure_code: string;
      panel_heading: string;
      panel_body: string;
      panel_bullets: string[];
    };
    mcp: {
      title: string;
      lead: string;
      body: string;
      eyebrow: string;
      transports_tag: string;
      example_tag: string;
      panel_tag: string;
      transports_heading: string;
      transports: Array<{ name: string; desc: string }>;
      example_heading: string;
      example_body: string;
      panel_heading: string;
      panel_body: string;
      panel_bullets: string[];
    };
    providers: {
      title: string;
      lead: string;
      body: string;
      eyebrow: string;
      categories_tag: string;
      categories_heading: string;
      categories: Array<{ name: string; heading: string; body: string }>;
      notes_tag: string;
      notes_heading: string;
      notes: string[];
    };
    instructions: {
      title: string;
      lead: string;
      body: string;
      eyebrow: string;
      notes_tag: string;
      notes_heading: string;
      notes: string[];
    };
    input_tools: {
      title: string;
      lead: string;
      body: string;
      eyebrow: string;
      tools_tag: string;
      tools_heading: string;
      tools: Array<{ name: string; desc: string }>;
    };
  };
  privacy: {
    title: string;
    lead: string;
    eyebrow: string;
    clause_tag: string;
    sections: Array<{ heading: string; body: string }>;
  };
  about: {
    title: string;
    eyebrow: string;
    tags: { name: string; license: string; feedback: string; sponsor: string; contact: string };
    name_heading: string;
    name_body: string;
    license_heading: string;
    license_body: string;
    feedback_heading: string;
    feedback_body: string;
    sponsor_heading: string;
    sponsor_body: string;
    sponsor_kofi_title: string;
    sponsor_kofi_body: string;
    sponsor_wechat_label: string;
    sponsor_wechat_title: string;
    sponsor_wechat_body: string;
    sponsor_wechat_cta: string;
    contact_heading: string;
    contact_body: string;
    socials: {
      bilibili_name: string;
      xhs_label: string;
      xhs_name: string;
      wechat_label: string;
      wechat_name: string;
    };
  };
  not_found: {
    title: string;
    body: string;
    back: string;
  };
};
