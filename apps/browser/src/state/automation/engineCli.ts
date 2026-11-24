import { errorText } from "../../lib/errors";
import { controlCancel, controlDevToolsClose, controlDevToolsOpen, controlDevToolsSend, onControlDevTools, type ControlDevToolsEvent } from "../../platform/control";
import type { CdpEventListener, CdpParams, TransportOpener } from "./devToolsSession";
import { OpError } from "./workspaceTargets";

export type EngineCliPush = (connection: number, name: "devtools.event" | "devtools.detached", data: Record<string, unknown>) => void;

type SocketSession = { connection: number; tab: string; targetId: string };

let epoch = 0;
let push: EngineCliPush | null = null;
let subscription: { remove(): void } | null = null;
const socketSessions = new Map<number, SocketSession>();
const inspectListeners = new Map<number, Set<CdpEventListener>>();

export const ownerOf = (connection: number) => `s${epoch}c${connection}`;
const inspectOwner = () => `s${epoch}inspect`;

export const engineFailure = (error: unknown) => (error instanceof OpError ? error : new OpError("failed", errorText(error)));

function route(event: ControlDevToolsEvent) {
  const session = event.session;
  if (typeof session !== "number") return;
  if (event.closed !== undefined) {
    const owned = socketSessions.get(session);
    socketSessions.delete(session);
    inspectListeners.delete(session);
    if (owned) push?.(owned.connection, "devtools.detached", { session, reason: event.closed });
    return;
  }
  if (typeof event.method !== "string") return;
  const listeners = inspectListeners.get(session);
  if (listeners) {
    for (const listener of [...listeners]) listener(event.method, (event.params ?? {}) as CdpParams);
    return;
  }
  const owned = socketSessions.get(session);
  if (!owned) return;
  push?.(owned.connection, "devtools.event", {
    session,
    method: event.method,
    ...(event.sessionId ? { sessionId: event.sessionId } : {}),
    ...(event.cut ? { cut: true, bytes: event.bytes ?? 0 } : { params: event.params ?? {} }),
  });
}

export function startEngineCli(pusher: EngineCliPush) {
  push = pusher;
  subscription ??= onControlDevTools(route);
}

export function stopEngineCli() {
  subscription?.remove();
  subscription = null;
  push = null;
}

export async function attachSession(connection: number, tab: string) {
  const opened = await controlDevToolsOpen(tab, ownerOf(connection), "full").catch((error: unknown) => {
    throw engineFailure(error);
  });
  socketSessions.set(opened.session, { connection, tab, targetId: opened.targetId });
  return opened;
}

export function ownedSession(connection: number, session: number): SocketSession {
  const owned = socketSessions.get(session);
  if (!owned || owned.connection !== connection) throw new OpError("no_window", `There's no DevTools session ${session} on this connection.`);
  return owned;
}

export async function sendOn(connection: number, send: { session: number; method: string; params?: Record<string, unknown>; sessionId?: string; timeoutMs?: number }) {
  ownedSession(connection, send.session);
  return await controlDevToolsSend({ ...send, owner: ownerOf(connection) }).catch((error: unknown) => {
    throw engineFailure(error);
  });
}

export async function detachSession(connection: number, session: number) {
  ownedSession(connection, session);
  socketSessions.delete(session);
  const closed = await controlDevToolsClose(session, ownerOf(connection)).catch(() => ({ closed: false }));
  return { closed: closed.closed };
}

export const sessionsOf = (connection: number) =>
  [...socketSessions.entries()].filter(([, owned]) => owned.connection === connection).map(([session, owned]) => ({ session, tab: owned.tab, targetId: owned.targetId }));

export function closeEngineCliFor(connection: number) {
  for (const [session, owned] of [...socketSessions]) if (owned.connection === connection) socketSessions.delete(session);
  void controlCancel(ownerOf(connection)).catch(() => undefined);
}

export function closeAllEngineCli() {
  socketSessions.clear();
  epoch++;
}

export const liveEngineSessions = () => socketSessions.size;

export const engineInspectionOpener: TransportOpener = async (tabId) => {
  const owner = inspectOwner();
  const opened = await controlDevToolsOpen(tabId, owner, "inspect").catch((error: unknown) => {
    throw engineFailure(error);
  });
  const listeners = new Set<CdpEventListener>();
  inspectListeners.set(opened.session, listeners);
  return {
    send: async (method, params) => (await controlDevToolsSend({ session: opened.session, owner, method, params }).catch((error: unknown) => {
      throw engineFailure(error);
    })).result,
    onEvent: (listener) => {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
    close: async () => {
      inspectListeners.delete(opened.session);
      await controlDevToolsClose(opened.session, owner).catch(() => undefined);
    },
  };
};
