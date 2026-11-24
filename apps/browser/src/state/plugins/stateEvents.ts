import { sendToPlugin } from "../../platform/plugins";
import { grantsTopic, isStateTopic, STATE_TOPICS, type StateTopic } from "../../lib/pluginState";
import type { PluginManifest } from "../../lib/pluginManifest";
import { useBrowser, type BrowserState } from "../browser/store";
import { failure } from "../automation/automationMethods";
import type { Body } from "../automation/controlSocket";
import { isEligibleTab } from "../automation/automationWindows";
import { notePlugin, notePluginTimes } from "../telemetry/pluginCounts";
import { consentToken, type ConsentToken } from "../telemetry/choice";
import { warnFor } from "../telemetry/consoleConsent";
import { acceptsRun } from "./process";
import { activeManifest, currentPlugins } from "./store";
import { listenForPluginStateCommits, takePluginStateCommits, type PageCommit } from "./stateCommits";
import { cleanStateText, pluginStateUrl, redactedDownloads, redactedGroups, redactedTabs, redactedWindows, redactionFor, type Redaction } from "./pluginEventRedaction";

export const STATE_FLUSH_MS = 100;
export const STATE_EVENT_BUDGET_BYTES = 256 * 1024;
export const MAX_STATE_LINE_BYTES = 1_048_576;
const SLOW_FLUSH_MS = 16;

type Caller = { name: string; run: number };
type Sent = Map<string, string>;
type Subscriber = Caller & { topics: Set<StateTopic>; sent: Map<StateTopic, Sent> };
type Rows = Map<string, unknown>;
type Event = Record<string, unknown>;

const subscribers = new Map<string, Subscriber>();
let dirty = new Set<StateTopic>();
let timer: ReturnType<typeof setTimeout> | null = null;
let stopWatching: (() => void) | null = null;
const encoder = new TextEncoder();
const byteLength = (text: string) => encoder.encode(text).length;

const keyOf = (c: Caller) => `${c.name}#${c.run}`;

function markDirty(topics: Iterable<StateTopic>) {
  for (const topic of topics) dirty.add(topic);
  if (dirty.size && !timer && subscribers.size) timer = setTimeout(flushStateEvents, STATE_FLUSH_MS);
}

function onCommit(s: BrowserState, prev: BrowserState) {
  const topics: StateTopic[] = [];
  const layout = s.tabs !== prev.tabs || s.windows !== prev.windows || s.windowOrder !== prev.windowOrder || s.groups !== prev.groups || s.peeks !== prev.peeks;
  if (layout) topics.push("tabs", "workspace");
  else if (s.ui.focusOrder !== prev.ui.focusOrder) topics.push("workspace");
  if (s.downloads !== prev.downloads || s.profiles !== prev.profiles) topics.push("downloads");
  if (topics.length) markDirty(topics);
}

const onPageCommit = () => markDirty(["navigation"]);

const wantsCommits = () => [...subscribers.values()].some((sub) => sub.topics.has("navigation"));

function syncWatching() {
  if (subscribers.size) stopWatching ??= useBrowser.subscribeTo(["tabs", "windows", "windowOrder", "groups", "peeks", "ui", "downloads", "profiles"], onCommit);
  if (wantsCommits()) {
    listenForPluginStateCommits(onPageCommit, () => Object.values(useBrowser.getState().tabs).map((t): [string, string] => [t.id, t.url]));
  } else listenForPluginStateCommits(null);
  if (subscribers.size) return;
  stopWatching?.();
  stopWatching = null;
  dirty = new Set();
  if (timer) clearTimeout(timer);
  timer = null;
}

const SUBSCRIBE_KEYS = ["topics", "resync"];

export function subscribeState(c: Caller, m: PluginManifest, params: Record<string, unknown>): Body {
  const unknown = Object.keys(params).filter((key) => !SUBSCRIBE_KEYS.includes(key));
  if (unknown.length) return failure("bad_request", `state.subscribe takes topics and resync, not ${unknown.slice(0, 4).map((k) => k.slice(0, 40)).join(", ")}.`);
  if (params.resync !== undefined && typeof params.resync !== "boolean") return failure("bad_request", "resync is true or false.");
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
    syncWatching();
    return { result: { ok: true, topics: [] } };
  }
  const sub: Subscriber = existing ?? { name: c.name, run: c.run, topics, sent: new Map() };
  const resync = params.resync === true;
  if (resync && existing) notePlugin("plugin_state_resyncs", consentToken());
  for (const topic of [...sub.sent.keys()]) if (!topics.has(topic) || resync) sub.sent.delete(topic);
  const added = [...topics].filter((t) => resync || !existing || !sub.topics.has(t));
  sub.topics = topics;
  subscribers.set(key, sub);
  syncWatching();
  markDirty(added);
  return { result: { ok: true, topics: [...topics] } };
}

export function dropStateSubscriptions(name: string) {
  for (const [key, sub] of subscribers) if (sub.name === name) subscribers.delete(key);
  syncWatching();
}

export const stateSubscriberCount = () => subscribers.size;

function projected(cache: Map<string, Rows>, key: string, make: () => [string, unknown][]): Rows {
  let hit = cache.get(key);
  if (!hit) cache.set(key, (hit = new Map(make())));
  return hit;
}

const levelOf = (r: Redaction) => (r.urls ? (r.full ? "full" : "short") : "none");

function rowsOf(topic: Exclude<StateTopic, "navigation">, s: BrowserState, r: Redaction, cache: Map<string, Rows>): Rows {
  switch (topic) {
    case "tabs":
      return projected(cache, `tabs:${levelOf(r)}`, () => redactedTabs(s, r).map((t) => [t.id, t]));
    case "workspace":
      return projected(cache, "workspace", () => [...redactedWindows(s).map((w): [string, unknown] => [`w:${w.id}`, w]), ...redactedGroups(s).map((g): [string, unknown] => [`g:${g.id}`, g])]);
    case "downloads":
      return projected(cache, `downloads:${levelOf(r)}`, () => redactedDownloads(s, r).map((d) => [d.id, d]));
  }
}

type Diff = { changed: [string, unknown][]; removed: string[]; initial: boolean; after: Sent };

function diffRows(sub: Subscriber, topic: StateTopic, rows: Rows): Diff {
  const before = sub.sent.get(topic);
  const after: Sent = new Map();
  const changed: [string, unknown][] = [];
  for (const [id, row] of rows) {
    const sig = JSON.stringify(row);
    after.set(id, sig);
    if (before?.get(id) !== sig) changed.push([id, row]);
  }
  const removed = before ? [...before.keys()].filter((id) => !after.has(id)) : [];
  return { changed, removed, initial: !before, after };
}

export function packedEvents(fields: Record<string, unknown[]>, initial: boolean, budget = STATE_EVENT_BUDGET_BYTES): Event[] {
  const names = Object.keys(fields);
  const empty = (): Event => Object.fromEntries(names.map((n) => [n, [] as unknown[]]));
  const overhead = byteLength(JSON.stringify(empty())) + 32;
  const events: Event[] = [];
  let current = empty();
  let size = overhead;
  let inCurrent = 0;
  let total = 0;
  for (const name of names) {
    for (const item of fields[name]!) {
      const bytes = byteLength(JSON.stringify(item)) + 1;
      if (inCurrent && size + bytes > budget) {
        events.push(current);
        current = empty();
        size = overhead;
        inCurrent = 0;
      }
      (current[name] as unknown[]).push(item);
      size += bytes;
      inCurrent++;
      total++;
    }
  }
  if (!total && !initial) return [];
  if (inCurrent || !events.length) events.push(current);
  if (initial) events[0] = { initial: true, ...events[0] };
  return events;
}

function eventsFor(diff: Diff, topic: Exclude<StateTopic, "navigation">): Event[] {
  const { changed, removed, initial } = diff;
  if (!initial && !changed.length && !removed.length) return [];
  if (topic === "workspace") {
    const gone = (prefix: string) => removed.filter((id) => id.startsWith(prefix)).map((id) => id.slice(prefix.length));
    return packedEvents(
      {
        windows: changed.filter(([id]) => id.startsWith("w:")).map(([, row]) => row),
        groups: changed.filter(([id]) => id.startsWith("g:")).map(([, row]) => row),
        removedWindows: gone("w:"),
        removedGroups: gone("g:"),
      },
      initial,
    );
  }
  return packedEvents({ [topic]: changed.map(([, row]) => row), removed }, initial);
}

function commitsFor(s: BrowserState, commits: PageCommit[], r: Redaction): Event[] {
  const shown = commits.flatMap((c) => {
    const t = s.tabs[c.tabId];
    if (!t || !isEligibleTab(s, c.tabId)) return [];
    const url = pluginStateUrl(c.url, r);
    if (url === null) return [];
    const title = t.url === c.url ? cleanStateText(t.customTitle || t.title, 500) : null;
    return [{ tabId: c.tabId, windowId: t.windowId, url, title, sameDocument: c.sameDocument }];
  });
  return shown.length ? packedEvents({ commits: shown }, false) : [];
}

function sendAll(sub: Subscriber, topic: StateTopic, events: Event[], time: number): number {
  const lines = events.map((data) => JSON.stringify({ event: `state.${topic}`, time, data }));
  if (lines.some((line) => byteLength(line) > MAX_STATE_LINE_BYTES)) throw new Error("A state event is larger than the channel takes.");
  for (const line of lines) sendToPlugin(sub.name, sub.run, line);
  return lines.length;
}

function deliver(sub: Subscriber, topic: StateTopic, s: BrowserState, r: Redaction, cache: Map<string, Rows>, commits: PageCommit[], time: number): number {
  if (topic === "navigation") return sendAll(sub, topic, commitsFor(s, commits, r), time);
  const diff = diffRows(sub, topic, rowsOf(topic, s, r, cache));
  const count = sendAll(sub, topic, eventsFor(diff, topic), time);
  sub.sent.set(topic, diff.after);
  return count;
}

type Delivered = { state: number; navigation: number };

function flushFor(sub: Subscriber, topics: Set<StateTopic>, s: BrowserState, cache: Map<string, Rows>, commits: PageCommit[], time: number, consent: ConsentToken | null): Delivered {
  const delivered: Delivered = { state: 0, navigation: 0 };
  const m = activeManifest(currentPlugins(), sub.name);
  if (!m || !acceptsRun(sub.name, sub.run)) {
    subscribers.delete(keyOf(sub));
    return delivered;
  }
  const r = redactionFor(m.permissions);
  for (const topic of sub.topics) {
    if (!topics.has(topic) || !grantsTopic(m.permissions.state, topic)) continue;
    try {
      delivered[topic === "navigation" ? "navigation" : "state"] += deliver(sub, topic, s, r, cache, commits, time);
    } catch (error) {
      sub.sent.delete(topic);
      notePlugin("plugin_state_events_dropped", consent);
      warnFor(consent, "[plugins] a state event couldn't be sent", error);
    }
  }
  return delivered;
}

export function flushStateEvents() {
  timer = null;
  const topics = dirty;
  dirty = new Set();
  const commits = takePluginStateCommits();
  if (!topics.size || !subscribers.size) return;
  const started = Date.now();
  const consent = consentToken();
  const s = useBrowser.getState();
  const cache = new Map<string, Rows>();
  const total: Delivered = { state: 0, navigation: 0 };
  for (const sub of [...subscribers.values()]) {
    const delivered = flushFor(sub, topics, s, cache, commits, started, consent);
    total.state += delivered.state;
    total.navigation += delivered.navigation;
  }
  notePluginTimes("plugin_state_events", total.state, consent);
  notePluginTimes("plugin_state_events", total.navigation, commits[0]?.consent ?? consent);
  if (Date.now() - started > SLOW_FLUSH_MS) notePlugin("plugin_state_flushes_slow", consent);
  syncWatching();
}
