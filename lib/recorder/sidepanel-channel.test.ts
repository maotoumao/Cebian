import { describe, it, expect, beforeEach } from 'vitest';
import { recorderChannel, type RecorderStatus } from '@/lib/recorder/sidepanel-channel';
import type { RecordedSession } from '@/lib/recorder/types';

const recording: RecorderStatus = {
  isRecording: true,
  startedAt: 100,
  eventCount: 3,
  initiatorInstanceId: 'me',
  activeWindowId: 7,
};

function session(startedAt: number): RecordedSession {
  return { version: 1, startedAt, endedAt: startedAt + 5, durationMs: 5, windowId: 7, events: [] };
}

describe('recorderChannel.publishSession', () => {
  beforeEach(() => {
    recorderChannel.publishStatus({ ...recording, isRecording: false, startedAt: null, initiatorInstanceId: null });
  });

  it('同一轮的成品送达时，先把缓存状态标成空闲，再通知 session 订阅者', () => {
    recorderChannel.publishStatus(recording);
    let seenDuringDelivery: RecorderStatus | null = null;
    const unsubscribe = recorderChannel.subscribeSession(() => {
      seenDuringDelivery = recorderChannel.getStatus();
    });
    recorderChannel.publishSession(session(100));
    unsubscribe();

    expect(seenDuringDelivery).toMatchObject({ isRecording: false, initiatorInstanceId: null });
    expect(recorderChannel.getStatus()).toMatchObject({ isRecording: false, initiatorInstanceId: null, startedAt: 100 });
  });

  it('迟到的上一轮成品不会把正在进行的新一轮标成空闲', () => {
    const next = { ...recording, startedAt: 102, initiatorInstanceId: 'other' };
    recorderChannel.publishStatus(next);
    recorderChannel.publishSession(session(100));
    expect(recorderChannel.getStatus()).toEqual(next);
  });

  it('不向状态订阅者广播修正后的缓存（以后台随后的状态广播为准）', () => {
    recorderChannel.publishStatus(recording);
    const seen: RecorderStatus[] = [];
    const unsubscribe = recorderChannel.subscribeStatus((s) => seen.push(s));
    seen.length = 0; // 去掉订阅时的回放
    recorderChannel.publishSession(session(100));
    unsubscribe();
    expect(seen).toEqual([]);
  });
});
