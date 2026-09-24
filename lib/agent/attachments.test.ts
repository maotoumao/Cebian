import { describe, it, expect } from 'vitest';
import { MAX_IMAGE_SIZE, MAX_TEXT_FILE_SIZE, planFileIntake } from '@/lib/agent/attachments';

/** 造一个指定体积的 File；内容无关紧要，只看 name / type / size。 */
function makeFile(name: string, type: string, size = 10): File {
  return new File([new Uint8Array(size)], name, { type });
}

const png = (name = 'a.png', size?: number) => makeFile(name, 'image/png', size);
const md = (name = 'a.md', size?: number) => makeFile(name, 'text/markdown', size);

describe('planFileIntake', () => {
  it('按传入顺序接受图片与文本文件，并标出类别', () => {
    const files = [md('1.md'), png('2.png'), md('3.md')];
    const plan = planFileIntake(files, { remaining: 10, supportsImage: true });
    expect(plan.accepted.map((a) => [a.file.name, a.kind])).toEqual([
      ['1.md', 'text'],
      ['2.png', 'image'],
      ['3.md', 'text'],
    ]);
    expect(plan.rejected).toEqual([]);
    expect(plan.skipped).toBe(0);
  });

  it('名额只计合格文件：前面不支持的文件不挤掉后面合格的', () => {
    const bad = makeFile('x.exe', 'application/octet-stream');
    const plan = planFileIntake([bad, md('1.md'), md('2.md')], { remaining: 2, supportsImage: true });
    expect(plan.accepted.map((a) => a.file.name)).toEqual(['1.md', '2.md']);
    expect(plan.rejected).toEqual([{ file: bad, reason: 'unsupported' }]);
    expect(plan.skipped).toBe(0);
  });

  it('名额用尽后，合格文件计入 skipped；不合格的仍照常报原因', () => {
    const big = md('big.md', MAX_TEXT_FILE_SIZE + 1);
    const plan = planFileIntake([md('1.md'), md('2.md'), big, md('3.md')], { remaining: 1, supportsImage: true });
    expect(plan.accepted.map((a) => a.file.name)).toEqual(['1.md']);
    expect(plan.skipped).toBe(2);
    expect(plan.rejected).toEqual([{ file: big, reason: 'too-large', maxSize: MAX_TEXT_FILE_SIZE }]);
  });

  it('remaining 为 0 或负数时一个都不接受', () => {
    expect(planFileIntake([md()], { remaining: 0, supportsImage: true }).skipped).toBe(1);
    expect(planFileIntake([md()], { remaining: -2, supportsImage: true }).accepted).toEqual([]);
  });

  it('当前模型不支持图片时拒绝图片，文本照常接受', () => {
    const img = png();
    const plan = planFileIntake([img, md()], { remaining: 10, supportsImage: false });
    expect(plan.rejected).toEqual([{ file: img, reason: 'no-image-model' }]);
    expect(plan.accepted.map((a) => a.kind)).toEqual(['text']);
  });

  it('模型不支持图片时，超大图片也按 no-image-model 报（模型能力优先于体积）', () => {
    const big = png('big.png', MAX_IMAGE_SIZE + 1);
    const plan = planFileIntake([big], { remaining: 10, supportsImage: false });
    expect(plan.rejected).toEqual([{ file: big, reason: 'no-image-model' }]);
  });

  it('图片与文本各按自己的体积上限判定（恰好等于上限算合格）', () => {
    const okImg = png('ok.png', MAX_IMAGE_SIZE);
    const bigImg = png('big.png', MAX_IMAGE_SIZE + 1);
    const okText = md('ok.md', MAX_TEXT_FILE_SIZE);
    const plan = planFileIntake([okImg, bigImg, okText], { remaining: 10, supportsImage: true });
    expect(plan.accepted.map((a) => a.file.name)).toEqual(['ok.png', 'ok.md']);
    expect(plan.rejected).toEqual([{ file: bigImg, reason: 'too-large', maxSize: MAX_IMAGE_SIZE }]);
  });

  it('图片按 MIME 白名单判定：白名单外的 image/* 视为不支持', () => {
    const bmp = makeFile('a.bmp', 'image/bmp');
    const plan = planFileIntake([bmp], { remaining: 10, supportsImage: true });
    expect(plan.rejected).toEqual([{ file: bmp, reason: 'unsupported' }]);
  });

  it('文本按扩展名判定，与 MIME 无关', () => {
    const plan = planFileIntake([makeFile('notes.TXT', '')], { remaining: 10, supportsImage: true });
    expect(plan.accepted.map((a) => a.kind)).toEqual(['text']);
  });
});
