// Sidepanel-side channel for recorder state.
//
// The port itself is owned by `useBackgroundAgent`; we don't open a second
// port just for the recorder. This module is a tiny pub/sub bridge so
// `useRecorder` can subscribe to status broadcasts and post start/stop
// without coupling to the agent hook's internals.
//
// Per-instance identity (used for ownership gating) lives in
// `lib/ipc/instance-id.ts` — it's a global app-wide concern, not specific
// to the recorder. Import `myInstanceId` from there if you need it.

import type { ClientMessage } from '@/lib/ipc/protocol';
import type { RecordedSession } from './types';

export interface RecorderStatus {
  isRecording: boolean;
  startedAt: number | null;
  eventCount: number;
  truncated?: 'event_limit' | 'time_limit';
  initiatorInstanceId: string | null;
  activeWindowId: number | null;
}

export type RecorderRejectionReason = 'busy' | 'before_hello';

type StatusListener = (s: RecorderStatus) => void;
type SessionListener = (s: RecordedSession) => void;
type RejectionListener = (r: { reason: RecorderRejectionReason }) => void;

const statusListeners = new Set<StatusListener>();
const sessionListeners = new Set<SessionListener>();
const rejectionListeners = new Set<RejectionListener>();

/** Last status pushed by the background. New subscribers receive this
 *  immediately so a button rendered after a broadcast still gets state. */
let lastStatus: RecorderStatus = {
  isRecording: false,
  startedAt: null,
  eventCount: 0,
  initiatorInstanceId: null,
  activeWindowId: null,
};

/** Active port. Set by `useBackgroundAgent` on connect/disconnect. */
let portRef: chrome.runtime.Port | null = null;

export const recorderChannel = {
  setPort(p: chrome.runtime.Port | null): void {
    portRef = p;
    if (p == null) {
      // Background is unreachable. Synthesize an idle status so subscribers
      // (the toolbar button) don't keep showing "recording" forever and so
      // callers see `isRecording = false` for connection-lost gating.
      lastStatus = {
        isRecording: false,
        startedAt: null,
        eventCount: 0,
        initiatorInstanceId: null,
        activeWindowId: null,
      };
      for (const l of statusListeners) l(lastStatus);
    }
  },

  /** True iff a connected port is currently registered. */
  isConnected(): boolean {
    return portRef != null;
  },

  /** Background pushed a new status — fan out to subscribers. Listener
   *  errors are swallowed so one bad subscriber doesn't break siblings
   *  (mirrors the BG-side `recordingFinishedListeners` discipline). */
  publishStatus(s: RecorderStatus): void {
    lastStatus = s;
    for (const l of statusListeners) {
      try { l(s); } catch (err) { console.warn('[recorderChannel] status listener threw:', err); }
    }
  },

  /** Background delivered the recorded session after a successful stop. */
  publishSession(s: RecordedSession): void {
    // 成品送达即说明这一轮录制已经结束。后台紧接着才广播当前状态（没有新一轮时即 idle），这之间若有人读
    // getStatus()（如发送前等待文件读取后判断归属），会误以为还在录制，进而发出一个
    // 后台会忽略的 stop、永远等不到成品。所以这里先就地修正同步读取用的缓存；订阅方
    // 仍以后台随后的状态广播为准，不在这里多触发一次渲染。
    // 只改同一轮：后台 finalize 等 detach 期间可能已有新一轮开始，迟到的旧成品不能把
    // 新一轮标成空闲（startedAt 与状态广播同源，可作这一轮的标识）。
    if (lastStatus.isRecording && lastStatus.startedAt === s.startedAt) {
      lastStatus = { ...lastStatus, isRecording: false, initiatorInstanceId: null };
    }
    for (const l of sessionListeners) {
      try { l(s); } catch (err) { console.warn('[recorderChannel] session listener threw:', err); }
    }
  },

  /** Background refused a `recorder_start` request (busy / before_hello). */
  publishRejection(r: { reason: RecorderRejectionReason }): void {
    for (const l of rejectionListeners) {
      try { l(r); } catch (err) { console.warn('[recorderChannel] rejection listener threw:', err); }
    }
  },

  getStatus(): RecorderStatus {
    return lastStatus;
  },

  subscribeStatus(l: StatusListener): () => void {
    statusListeners.add(l);
    // Replay last known status so newly mounted components are correct.
    l(lastStatus);
    return () => { statusListeners.delete(l); };
  },

  subscribeSession(l: SessionListener): () => void {
    sessionListeners.add(l);
    return () => { sessionListeners.delete(l); };
  },

  subscribeRejection(l: RejectionListener): () => void {
    rejectionListeners.add(l);
    return () => { rejectionListeners.delete(l); };
  },

  /** Returns true if the message was posted; false if no port is connected. */
  start(): boolean {
    if (!portRef) return false;
    portRef.postMessage({ type: 'recorder_start' } satisfies ClientMessage);
    return true;
  },

  stop(): boolean {
    if (!portRef) return false;
    portRef.postMessage({ type: 'recorder_stop' } satisfies ClientMessage);
    return true;
  },
};
