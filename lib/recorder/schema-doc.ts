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
  network?: NetworkSummary   present only if network recording was on
}

RecordedEvent base: { id, t, tIdx, kind }
  t: ms since startedAt (>= 0, non decreasing)
  tIdx: index into the tabs[] array above; tabs[tIdx] is the Chrome tabId
  kind: 'interaction' | 'tab' | 'mutation' | 'network'

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

network (one HTTP request, WebSocket or EventSource, in the same
timeline so it follows the click that caused it):
  id:       matches "_cebianId" in the HAR file (see har attr below)
  type:     'document' | 'fetch' | 'xhr' | 'eventsource' | 'websocket'
  method, url   url is the request URL (not the page URL)
  status?, ms?, error?, redirects?: number of redirects followed
  req?:     request body preview; reqOmitted?: why it was not recorded
  res?:     response body preview; resOmitted?: why it was not recorded
            ('binary' | 'too_large' | 'evicted' | 'unavailable' |
             'unsupported' = format that cannot be reliably redacted)
  shape?:   field names and types of a JSON response
  messages?: number of WebSocket / EventSource messages recorded

NetworkSummary {
  state: 'active' | 'aborted' (user stopped network recording at
         abortedAt ms; later requests are missing) | 'unavailable'
         (could not record, see unavailableReason)
  unavailableTabs?: number of tabs whose requests could not be recorded
                    (e.g. another debugger was attached); requests on
                    those tabs are missing
  requests: total recorded; included?: how many are in this timeline
            when fewer (size limit)
  filtered: analytics / monitoring requests skipped
  truncated?: 'entry_limit' | 'size_limit'   network recording stopped
  previews?: 'no_shape' | 'no_previews'   previews dropped for size;
             the HAR file still has the full bodies
}
Secrets (tokens, passwords, keys, auth headers, cookies) are replaced
with [redacted] or not recorded at all. Cookies are never recorded.

Notes:
  - Empty optional fields ('', undefined, null) are dropped from the JSON
    rather than emitted; their absence is not meaningful.
  - To find the active URL of a tab at any point in the timeline, scan
    backward from that point for the most recent tab event on the same
    tIdx that carries a 'url' field.

<recording> envelope attrs:
  name, mime
  event-count: non network events in this body
  network-count: network events in this body (network recording only)
  filtered-count: analytics / monitoring requests skipped
  network-state: 'aborted' | 'unavailable' when network recording did
                 not run normally
  har: path of the full network log (HAR 1.2, with headers and bodies),
       relative to /workspaces/{SESSION_ID}/. Each entry carries
       "_cebianId" equal to a network event id: search for it with
       fs_search, then read the nearby lines with fs_read_file.
  har-failed="true": the HAR could not be saved; only this body exists
  duration-ms: original session duration (covers trimmed events too)
  truncated="true": events were trimmed for size; original had more

Usage:
  - A <recording> describes what the user already did. Treat it as
    executable intent: when the user asks you to act on it, translate
    interaction events into the corresponding interact tool calls in
    timestamp order, using each event's target.selector. Insert a
    wait_navigation call wherever the timeline shows a tab navigation.
  - When the user wants to automate a site or extract its data, prefer
    calling the recorded API requests directly (method, url, request
    body shape from the HAR) over replaying clicks. Redacted values must
    come from the user or the live page, never be guessed.
  - When the user only asks about the recording (summarize, explain,
    inspect), describe it without executing.
  - Do not ask the user to confirm steps that are already in the
    recording; only ask when their request changes a value the
    recording does not specify.
-->`;
