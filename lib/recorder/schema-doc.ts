// Schema documentation for the <recording> attachment body, injected as
// an XML comment at the top of the <attachments> block whenever a user
// message includes at least one <recording> element. Gives the agent
// enough structure info to interpret the JSON body without guessing.
//
// IMPORTANT: the string MUST NOT contain the sequence `--` (XML comment
// body rule). Keep prose single-hyphen only.

export const RECORDING_SCHEMA_COMMENT = `<!--
<recording> body = JSON RecordedSession the user captured by pressing
record, doing things across one or more tabs, then stopping. Read it
to understand what they just did.

RecordedSession {
  version: 1
  startedAt, endedAt: Unix ms
  durationMs, windowId
  tabs: number[]   Chrome tabIds in first-seen order; events reference
                   them by tIdx (an index into this array, not the tabId)
  events: RecordedEvent[]   ordered by t ascending
  truncated?: 'event_limit' | 'time_limit'   set if auto stopped
}

RecordedEvent base: { id, t, tIdx, kind }
  t: ms since startedAt (>= 0, non decreasing)
  tIdx: index into the tabs[] array above; tabs[tIdx] is the Chrome tabId
  kind: 'interaction' | 'tab' | 'mutation'

interaction (a user action):
  action:   'click' | 'input' | 'change' | 'submit' | 'keypress' | 'scroll'
  target:   { selector, tag, role?, label?, type? }
  value?:   for input/change; debounced to final typed text;
            omitted for password / cc / otp fields
  key?:     for keypress (e.g. 'Enter', 'Backspace')
  modifiers?: ('ctrl' | 'shift' | 'alt' | 'meta')[]
  repeat?:  N >= 2 when N rapid Backspace/Delete were merged;
            t is the first press
  scroll?:  { deltaY, deltaX }   aggregated window scroll deltas

tab (navigation / lifecycle):
  event:    'focus_changed' | 'navigated' | 'reloaded' | 'created' | 'closed'
  url?:     the new URL after this event (the active URL of tabs[tIdx]
            from this point onward, until the next tab event on this
            tIdx changes it). Omitted for events that don't carry a URL
            (e.g. 'created' before the destination loads).
  title?, openerTabId?

mutation (batched DOM changes since previous mutation event):
  changes: [{ op: 'appeared'|'disappeared', tag, role?, label?,
              textPreview?, size?: {w,h}, childCount? }]
  note?:   'too_many_changes' (raw buffer overflowed; changes empty)

Notes:
  - Empty optional fields ('', undefined, null) are dropped from the JSON
    rather than emitted; their absence is not meaningful.
  - To find the active URL of a tab at any point in the timeline, scan
    backward from that point for the most recent tab event on the same
    tIdx that carries a 'url' field.

<recording> envelope attrs:
  name, mime
  event-count: events.length in this body
  duration-ms: original session duration (covers trimmed events too)
  truncated="true": events were trimmed for size; original had more

Usage:
  - A <recording> describes what the user already did. Treat it as
    executable intent: when the user asks you to act on it, translate
    interaction events into the corresponding interact tool calls in
    timestamp order, using each event's target.selector. Insert a
    wait_navigation call wherever the timeline shows a tab navigation.
  - When the user only asks about the recording (summarize, explain,
    inspect), describe it without executing.
  - Do not ask the user to confirm steps that are already in the
    recording; only ask when their request changes a value the
    recording does not specify.
-->`;
