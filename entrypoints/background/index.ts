import { setupOAuthRefresh } from './oauth-refresh';
import { seedDevStorage } from './dev-seed';
import { agentManager } from './agent-manager';
import { sessionStore } from './session-store';
import { AGENT_PORT_NAME, type ClientMessage, type ServerMessage } from '@/lib/protocol';

export default defineBackground(() => {
  console.log('Cebian background started', { id: browser.runtime.id });
  seedDevStorage();

  chrome.sidePanel
    .setPanelBehavior({ openPanelOnActionClick: true })
    .catch((error) => console.error(error));

  setupOAuthRefresh();

  // ─── Port management ───

  /** All connected ports and the session each is subscribed to. */
  const ports = new Map<chrome.runtime.Port, { subscribedSession: string | null }>();

  /** Send a message to all ports subscribed to a given session. */
  function broadcast(sessionId: string, msg: ServerMessage): void {
    for (const [port, state] of ports) {
      if (state.subscribedSession === sessionId) {
        try { port.postMessage(msg); } catch { /* port disconnected */ }
      }
    }
  }

  agentManager.setBroadcast(broadcast);

  chrome.runtime.onConnect.addListener((port) => {
    if (port.name !== AGENT_PORT_NAME) return;

    ports.set(port, { subscribedSession: null });
    port.postMessage({ type: 'connected' } satisfies ServerMessage);

    port.onMessage.addListener(async (msg: ClientMessage) => {
      try {
        await handleClientMessage(port, msg);
      } catch (err: any) {
        port.postMessage({
          type: 'error',
          sessionId: null,
          error: err.message ?? String(err),
        } satisfies ServerMessage);
      }
    });

    port.onDisconnect.addListener(() => {
      const disconnectedState = ports.get(port);
      const sessionId = disconnectedState?.subscribedSession;
      ports.delete(port);

      // If no other port is subscribed to this session, cancel the running agent
      if (sessionId) {
        const hasOtherSubscriber = [...ports.values()].some(s => s.subscribedSession === sessionId);
        if (!hasOtherSubscriber) {
          // No more subscribers — cancel running agent to free resources
          agentManager.cancel(sessionId);
        }
      }
    });
  });

  async function handleClientMessage(port: chrome.runtime.Port, msg: ClientMessage): Promise<void> {
    const state = ports.get(port);
    if (!state) return;

    switch (msg.type) {
      case 'subscribe': {
        state.subscribedSession = msg.sessionId;
        // Send current agent state if the agent is running for this session
        const agentState = agentManager.getSessionState(msg.sessionId);
        if (agentState) {
          port.postMessage({
            type: 'session_state',
            sessionId: msg.sessionId,
            messages: agentState.messages,
            isRunning: agentState.isRunning,
          } satisfies ServerMessage);
        } else {
          // Agent not running — load from DB
          const session = await sessionStore.load(msg.sessionId);
          if (session) {
            port.postMessage({
              type: 'session_loaded',
              session,
            } satisfies ServerMessage);
          } else {
            // Session not found in DB
            port.postMessage({
              type: 'session_loaded',
              session: null,
            } satisfies ServerMessage);
          }
        }
        break;
      }

      case 'unsubscribe':
        state.subscribedSession = null;
        break;

      case 'prompt': {
        const sessionId = msg.sessionId ?? crypto.randomUUID();
        state.subscribedSession = sessionId;
        // If this is a new session (no existing sessionId), notify the client so it can navigate
        if (!msg.sessionId) {
          port.postMessage({
            type: 'session_state',
            sessionId,
            messages: [],
            isRunning: true,
          } satisfies ServerMessage);
        }
        // Start the agent (async — events will be broadcast)
        agentManager.prompt(sessionId, msg.text, msg.attachments).catch((err) => {
          port.postMessage({
            type: 'error',
            sessionId,
            error: err.message ?? String(err),
          } satisfies ServerMessage);
        });
        break;
      }

      case 'cancel':
        agentManager.cancel(msg.sessionId);
        break;

      case 'resolve_tool':
        agentManager.resolveTool(msg.sessionId, msg.toolName, msg.response);
        break;

      case 'cancel_tool':
        agentManager.cancelTool(msg.sessionId, msg.toolName);
        break;

      case 'session_load': {
        const session = await sessionStore.load(msg.sessionId);
        port.postMessage({
          type: 'session_loaded',
          session: session ?? null,
        } satisfies ServerMessage);
        break;
      }

      case 'session_list': {
        const sessions = await sessionStore.list();
        port.postMessage({
          type: 'session_list_result',
          sessions,
        } satisfies ServerMessage);
        break;
      }

      case 'session_delete': {
        await sessionStore.delete(msg.sessionId);
        agentManager.destroySession(msg.sessionId);
        // Broadcast deletion to all connected ports
        for (const [p] of ports) {
          try {
            p.postMessage({
              type: 'session_deleted',
              sessionId: msg.sessionId,
            } satisfies ServerMessage);
          } catch { /* disconnected */ }
        }
        break;
      }
    }
  }
});
