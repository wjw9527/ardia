import { sendToPlugin } from "../../platform/plugins";
import { grantsTopic, isStateTopic, STATE_TOPICS, type StateTopic } from "../../lib/pluginState";
import type { PluginManifest } from "../../lib/pluginManifest";
import { useBrowser, type BrowserState } from "../browser/store";
import { failure } from "../automation/automationMethods";
import type { Body } from "../automation/controlSocket";
import { notePlugin, notePluginTimes } from "../telemetry/pluginCounts";
import { consentToken, type ConsentToken } from "../telemetry/choice";
import { warnFor } from "../telemetry/consoleConsent";
import { acceptsRun } from "./process";
import { activeManifest, currentPlugins } from "./store";
import { redactedDownloads, redactedGroups, redactedTabs, redactedWindows, redactionFor, type Redaction } from "./pluginEventRedaction";

export const STATE_FLUSH_MS = 100;
export const STATE_CHUNK = 200;
export const MAX_STATE_EVENT_BYTES = 512 * 1024;
const SLOW_FLUSH_MS = 16;

type Caller = { name: string; run: number };
type Sent = Map<string, string>;
type Subscriber = Caller & { topics: Set<StateTopic>; sent: Map<StateTopic, Sent> };

const subscribers = new Map<string, Subscriber>();
let dirty = new Set<StateTopic>();
let timer: ReturnType<typeof setTimeout> | null = null;
let stopWatching: (() => void) | null = null;

const keyOf = (c: Caller) => `${c.name}#${c.run}`;

function markDirty(topics: Iterable<StateTopic>) {
  for (const topic of topics) dirty.add(topic);
  if (dirty.size && !timer && subscribers.size) timer = setTimeout(flushStateEvents, STATE_FLUSH_MS);
}

function onCommit(s: BrowserState, prev: BrowserState) {
  const topics: StateTopic[] = [];
  const layout = s.tabs !== prev.tabs || s.windows !== prev.windows || s.windowOrder !== prev.windowOrder || s.groups !== prev.groups || s.peeks !== prev.peeks;
  if (layout) topics.push("tabs", "navigation", "workspace");
  else if (s.ui.focusOrder !== prev.ui.focusOrder) topics.push("workspace");
  if (s.downloads !== prev.downloads || s.profiles !== prev.profiles) topics.push("downloads");
  if (topics.length) markDirty(topics);
}

function watch() {
  stopWatching ??= useBrowser.subscribeTo(["tabs", "windows", "windowOrder", "groups", "peeks", "ui", "downloads", "profiles"], onCommit);
}

function unwatchIfIdle() {
  if (subscribers.size) return;
  stopWatching?.();
  stopWatching = null;
  dirty = new Set();
  if (timer) clearTimeout(timer);
  timer = null;
}

export function subscribeState(c: Caller, m: PluginManifest, params: Record<string, unknown>): Body {
  const unknown = Object.keys(params).filter((key) => key !== "topics");
  if (unknown.length) return failure("bad_request", `state.subscribe takes topics, not ${unknown.slice(0, 4).join(", ")}.`);
  const given = params.topics;
  if (!Array.isArray(given) || given.length > STATE_TOPICS.length * 2) return failure("bad_request", `state.subscribe needs topics: a list of ${STATE_TOPICS.join(", ")}.`);
  const bad = given.findIndex((t) => !isStateTopic(t));
  if (bad >= 0) return failure("bad_request", `topics[${bad}] isn't one of ${STATE_TOPICS.join(", ")}.`);
  const topics = new Set(given as StateTopic[]);
  const refused = [...topics].filter((t) => !grantsTopic(m.permissions.state, t));
  if (refused.length) {
    notePlugin("plugin_state_subscribe_refusals", consentToken());
    return failure("refused", `This plugin's permissions.state.events don't list ${refused.join(", ")}.`);
  }
  const key = keyOf(c);
  const existing = subscribers.get(key);
  if (!topics.size) {
    subscribers.delete(key);
    unwatchIfIdle();
    return { result: { ok: true, topics: [] } };
  }
  const sub: Subscriber = existing ?? { name: c.name, run: c.run, topics, sent: new Map() };
  for (const topic of sub.sent.keys()) if (!topics.has(topic)) sub.sent.delete(topic);
  const added = [...topics].filter((t) => !sub.topics.has(t) || !existing);
  sub.topics = topics;
  subscribers.set(key, sub);
  watch();
  markDirty(existing ? added : topics);
  return { result: { ok: true, topics: [...topics] } };
}

export function dropStateSubscriptions(name: string) {
  for (const [key, sub] of subscribers) if (sub.name === name) subscribers.delete(key);
  unwatchIfIdle();
}

export const stateSubscriberCount = () => subscribers.size;

type Projection = { rows: Map<string, unknown> };

function projected(cache: Map<string, Projection>, key: string, make: () => [string, unknown][]): Projection {
  let hit = cache.get(key);
  if (!hit) cache.set(key, (hit = { rows: new Map(make()) }));
  return hit;
}

function projectionOf(topic: StateTopic, s: BrowserState, r: Redaction, cache: Map<string, Projection>): Projection {
  const level = `${topic}:${r.urls ? (r.full ? "full" : "short") : "none"}`;
  switch (topic) {
    case "tabs":
    case "navigation":
      return projected(cache, `tabs:${level}`, () => redactedTabs(s, r).map((t) => [t.id, t]));
    case "workspace":
      return projected(cache, "workspace", () => [...redactedWindows(s).map((w): [string, unknown] => [`w:${w.id}`, w]), ...redactedGroups(s).map((g): [string, unknown] => [`g:${g.id}`, g])]);
    case "downloads":
      return projected(cache, level, () => redactedDownloads(s, r).map((d) => [d.id, d]));
  }
}

type Diff = { changed: unknown[]; removed: string[]; initial: boolean };

function diffRows(sub: Subscriber, topic: StateTopic, rows: Map<string, unknown>, signature: (row: unknown) => string): Diff {
  const before = sub.sent.get(topic);
  const after: Sent = new Map();
  const changed: unknown[] = [];
  for (const [id, row] of rows) {
    const sig = signature(row);
    after.set(id, sig);
    if (before?.get(id) !== sig) changed.push(row);
  }
  const removed = before ? [...before.keys()].filter((id) => !after.has(id)) : [];
  sub.sent.set(topic, after);
  return { changed, removed, initial: !before };
}

function chunks<T>(list: T[]): T[][] {
  if (list.length <= STATE_CHUNK) return [list];
  const out: T[][] = [];
  for (let i = 0; i < list.length; i += STATE_CHUNK) out.push(list.slice(i, i + STATE_CHUNK));
  return out;
}

function send(sub: Subscriber, topic: StateTopic, data: Record<string, unknown>, time: number, consent: ConsentToken | null): number {
  const line = JSON.stringify({ event: `state.${topic}`, time, data });
  if (line.length > MAX_STATE_EVENT_BYTES) {
    notePlugin("plugin_state_events_dropped", consent);
    return 0;
  }
  sendToPlugin(sub.name, sub.run, line);
  return 1;
}

function eventsFor(sub: Subscriber, topic: StateTopic, p: Projection): Record<string, unknown>[] {
  if (topic === "navigation") {
    const urlOf = (row: unknown) => (row as { url: string | null }).url ?? "";
    const before = sub.sent.get(topic);
    const { changed } = diffRows(sub, topic, p.rows, urlOf);
    if (!before) return [];
    const commits = changed
      .map((row) => row as { id: string; windowId: string; url: string | null; title: string | null })
      .filter((t) => t.url !== null)
      .map((t) => ({ tabId: t.id, windowId: t.windowId, url: t.url, title: t.title }));
    return chunks(commits).filter((c) => c.length).map((c) => ({ commits: c }));
  }
  const { changed, removed, initial } = diffRows(sub, topic, p.rows, (row) => JSON.stringify(row));
  if (!initial && !changed.length && !removed.length) return [];
  if (topic === "workspace") {
    const windows = changed.filter((row) => (row as { kind?: unknown }).kind !== undefined);
    const groups = changed.filter((row) => (row as { kind?: unknown }).kind === undefined);
    const gone = (prefix: string) => removed.filter((id) => id.startsWith(prefix)).map((id) => id.slice(prefix.length));
    return [{ ...(initial ? { initial: true } : {}), windows, groups, removedWindows: gone("w:"), removedGroups: gone("g:") }];
  }
  const field = topic === "tabs" ? "tabs" : "downloads";
  return chunks(changed).map((part, i) => ({ ...(initial && i === 0 ? { initial: true } : {}), [field]: part, removed: i === 0 ? removed : [] }));
}

export function flushStateEvents() {
  timer = null;
  const topics = dirty;
  dirty = new Set();
  if (!topics.size || !subscribers.size) return;
  const started = Date.now();
  const consent = consentToken();
  const s = useBrowser.getState();
  const cache = new Map<string, Projection>();
  let sent = 0;
  for (const [key, sub] of [...subscribers]) {
    const m = activeManifest(currentPlugins(), sub.name);
    if (!m || !acceptsRun(sub.name, sub.run)) {
      subscribers.delete(key);
      continue;
    }
    const r = redactionFor(m.permissions);
    for (const topic of sub.topics) {
      if (!topics.has(topic) || !grantsTopic(m.permissions.state, topic)) continue;
      try {
        for (const data of eventsFor(sub, topic, projectionOf(topic, s, r, cache))) sent += send(sub, topic, data, started, consent);
      } catch (error) {
        sub.sent.delete(topic);
        notePlugin("plugin_state_events_dropped", consent);
        warnFor(consent, "[plugins] a state event couldn't be sent", error);
      }
    }
  }
  notePluginTimes("plugin_state_events", sent, consent);
  if (Date.now() - started > SLOW_FLUSH_MS) notePlugin("plugin_state_flushes_slow", consent);
  unwatchIfIdle();
}
