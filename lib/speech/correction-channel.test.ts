import { describe, it, expect } from 'vitest';
import { correctTranscript } from '@/lib/speech/correction-channel';

describe('correctTranscript', () => {
  it('第一版直通：原样返回', async () => {
    await expect(correctTranscript('今天天气不错')).resolves.toBe('今天天气不错');
  });
});
