import { describe, it, expect } from 'vitest';
import {
  TEMPLATE_VARIABLES,
  isTemplateVarName,
  replaceTemplateVars,
  templateVariablesFor,
} from '@/lib/ai-config/template';

describe('replaceTemplateVars', () => {
  it('有值就替换', () => {
    expect(replaceTemplateVars('Hi {{selected_text}}!', { selected_text: 'there' })).toBe(
      'Hi there!',
    );
  });

  it('同一变量出现多次全部替换', () => {
    expect(replaceTemplateVars('{{date}} / {{date}}', { date: '2026-08-22' })).toBe(
      '2026-08-22 / 2026-08-22',
    );
  });

  it('是内置变量但当前场景没给值 → 替换成空串', () => {
    // 划词场景取不到剪贴板，留着 {{clipboard}} 原样发给模型只会让它困惑。
    expect(replaceTemplateVars('A{{clipboard}}B', {})).toBe('AB');
  });

  it('不是内置变量 → 原样保留（让用户看见名字写错了）', () => {
    expect(replaceTemplateVars('{{notAVar}}', {})).toBe('{{notAVar}}');
    expect(replaceTemplateVars('{{selected_txt}}', { selected_text: 'x' })).toBe(
      '{{selected_txt}}',
    );
  });

  it('空串值与「没给值」等价，都不留占位符', () => {
    expect(replaceTemplateVars('[{{context}}]', { context: '' })).toBe('[]');
  });

  it('非 {{}} 形态不受影响', () => {
    expect(replaceTemplateVars('{single} {{ spaced }} $var', {})).toBe('{single} {{ spaced }} $var');
  });

  it('原型键不取 Object.prototype 上的成员', () => {
    // {{__proto__}} / {{constructor}} 都不是内置变量，应原样保留而不是渲染出对象。
    expect(replaceTemplateVars('{{__proto__}}|{{constructor}}', {})).toBe(
      '{{__proto__}}|{{constructor}}',
    );
  });

  it('只认 own property：原型链上继承来的同名值不采用', () => {
    const inherited = Object.create({ selected_text: 'from-prototype' }) as Record<string, string>;
    // selected_text 是内置变量但不是 own property → 按「取不到」处理，替换成空串。
    expect(replaceTemplateVars('[{{selected_text}}]', inherited)).toBe('[]');
  });
});

describe('templateVariablesFor', () => {
  // 断言完整列表而非「含 / 不含」若干项：误删某个变量的场景声明也会被抓住。
  it('划词场景的完整变量集（不含剪贴板——内容脚本取不稳）', () => {
    expect(templateVariablesFor('pageAction').map((v) => v.name)).toEqual([
      'selected_text',
      'context',
      'page_url',
      'page_title',
      'date',
      'ui_language',
    ]);
  });

  it('prompts 场景的完整变量集（不含选区周边文本——无采集来源）', () => {
    expect(templateVariablesFor('prompts').map((v) => v.name)).toEqual([
      'selected_text',
      'page_url',
      'page_title',
      'date',
      'ui_language',
      'clipboard',
    ]);
  });

  it('每个变量至少属于一个场景（否则是死变量）', () => {
    for (const v of TEMPLATE_VARIABLES) {
      expect(v.scenes.length).toBeGreaterThan(0);
    }
  });

  it('变量名不重复', () => {
    const names = TEMPLATE_VARIABLES.map((v) => v.name);
    expect(names.length).toBe(new Set(names).size);
  });
});

describe('isTemplateVarName', () => {
  it('认识表里的名字，不认识别的', () => {
    expect(isTemplateVarName('page_url')).toBe(true);
    expect(isTemplateVarName('ui_language')).toBe(true);
    expect(isTemplateVarName('nope')).toBe(false);
  });
});
