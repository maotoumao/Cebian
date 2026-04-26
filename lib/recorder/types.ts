// User-action recording event schema.
//
// All events share a base shape and are discriminated by `kind`. The recording
// is captured passively — the content script never mutates the page — and is
// later attached as JSON to a chat message so the agent can understand what
// the user was doing.

export type RecordedEventBase = {
  /** Short uuid assigned by the background recorder. */
  id: string;
  /** Milliseconds since recording start. */
  t: number;
  /** Tab where the event happened. */
  tabId: number;
  /** Tab url at the moment of the event. */
  url: string;
};

export type InteractionAction =
  | 'click' | 'input' | 'change' | 'submit' | 'keypress' | 'scroll';

export type InteractionEvent = RecordedEventBase & {
  kind: 'interaction';
  action: InteractionAction;
  target: {
    selector: string;
    tag: string;
    role?: string;
    label?: string;
    /** input type, if applicable. */
    type?: string;
  };
  /** Input value. Omitted for password / cc-* / one-time-code fields. */
  value?: string;
  /** Pressed key for keypress events (e.g. "Enter", "Escape"). */
  key?: string;
  modifiers?: Array<'ctrl' | 'shift' | 'alt' | 'meta'>;
  /** Repeat count for coalesced keypresses (Backspace/Delete within 1s on
   *  the same target). Omitted when the key was pressed only once; set
   *  to N ≥ 2 when the recorder merged N consecutive presses into this
   *  event. `t` is the timestamp of the FIRST press in the run. */
  repeat?: number;
  /** Aggregated scroll delta since last scroll emission. */
  scroll?: { deltaY: number; deltaX: number };
};

export type TabEventKind =
  | 'focus_changed' | 'navigated' | 'reloaded' | 'created' | 'closed';

export type TabEvent = RecordedEventBase & {
  kind: 'tab';
  event: TabEventKind;
  title?: string;
  openerTabId?: number;
};

export type MutationChange = {
  op: 'appeared' | 'disappeared';
  tag: string;
  role?: string;
  label?: string;
  /** Visible text inside the node, truncated. */
  textPreview?: string;
  /** Bounding rect size in CSS pixels. */
  size?: { w: number; h: number };
  /** Direct child element count, hints at module complexity. */
  childCount?: number;
};

export type MutationEvent = RecordedEventBase & {
  kind: 'mutation';
  changes: MutationChange[];
  /** Set when raw mutation buffer overflowed and the window was dropped. */
  note?: 'too_many_changes';
};

export type RecordedEvent =
  | InteractionEvent
  | TabEvent
  | MutationEvent;

/** Distributive Omit so the discriminator literal stays attached to each
 *  union variant. `Omit<RecordedEvent, 'id'|'t'>` would erase the variant
 *  shapes; this preserves them. Used by the runtime-message envelope and
 *  by the recorder's `pushEvent` so the content script can submit events
 *  without inventing placeholder ids/timestamps. */
export type RecordedEventWithoutBase = RecordedEvent extends infer T
  ? T extends RecordedEvent ? Omit<T, 'id' | 't'> : never
  : never;

export type RecordedSession = {
  version: 1;
  /** Absolute timestamp (Date.now) at recording start. */
  startedAt: number;
  /** Absolute timestamp at recording stop. */
  endedAt: number;
  durationMs: number;
  /** Window the recording was scoped to (focused window at start). */
  windowId: number;
  events: RecordedEvent[];
  /** Why the recording was auto-stopped, if applicable. */
  truncated?: 'event_limit' | 'time_limit';
};
