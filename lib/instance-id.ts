// Per-instance unique id for this sidepanel/tab JS context.
//
// Generated once at module load; stable for the lifetime of the JS realm.
// A reload of the sidepanel/tab = new realm = new id (and from the BG's
// point of view, a new port → it can detect the change via `hello`).
//
// Used by:
// - recorder: gating who owns the active recording (initiatorInstanceId)
// - any future client→BG flow that needs to identify the originating
//   sidepanel without relying on windowId (which doesn't survive tab drag).
//
// IMPORTANT: do NOT import this from `entrypoints/background/*`. The BG
// has no instance of its own; it only ever *receives* an instanceId via
// the `hello` message.

export const myInstanceId: string = crypto.randomUUID();
