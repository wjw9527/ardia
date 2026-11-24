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
import { byteLength, packEvents, STATE_ROUND_BYTES, type Item } from "./stateEventPacking";
import { cleanStateText, pluginStateUrl, redactedDownloads, redactedGroups, redactedTabs, redactedWindows, redactionFor, type Redaction } from "./pluginEventRedaction";

export const STATE_FLUSH_MS = 100;
const SLOW_FLUSH_MS = 16;

type Caller = { name: string; run: number };
type Sent = Map<string, string>;
type Subscriber = Caller & { topics: Set<StateTopic>; sent: Map<StateTopic, Sent> };
type Rows = Map<string, unknown>;

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
    listenForPluginStateCommits(onPageCommit);
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
  const askedResync = params.resync;
  if (askedResync !== undefined && typeof askedResync !== "boolean" && !(Array.isArray(askedResync) && askedResync.length <= STATE_TOPICS.length && askedResync.every(isStateTopic))) {
    return failure("bad_request", "resync is true, false or a list of the topics to send whole again.");
  }
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
  const resyncing = new Set<StateTopic>(askedResync === true ? topics : Array.isArray(askedResync) ? (askedResync as StateTopic[]).filter((t) => topics.has(t)) : []);
  if (askedResync === true && existing) notePlugin("plugin_state_resyncs", consentToken());
  for (const topic of [...sub.sent.keys()]) if (!topics.has(topic) || resyncing.has(topic)) sub.sent.delete(topic);
  const added = [...topics].filter((t) => resyncing.has(t) || !existing || !sub.topics.has(t));
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

type Diff = { changed: [string, unknown][]; removed: string[]; before: Sent | undefined; signatures: Sent };

function diffRows(sub: Subscriber, topic: StateTopic, rows: Rows): Diff {
  const before = sub.sent.get(topic);
  const signatures: Sent = new Map();
  const changed: [string, unknown][] = [];
  for (const [id, row] of rows) {
    const sig = JSON.stringify(row);
    signatures.set(id, sig);
    if (before?.get(id) !== sig) changed.push([id, row]);
  }
  const removed = before ? [...before.keys()].filter((id) => !signatures.has(id)) : [];
  return { changed, removed, before, signatures };
}

const REMOVED = "\u0000removed:";

function itemsFor(diff: Diff, topic: Exclude<StateTopic, "navigation">): { fields: string[]; items: Item[] } {
  const removedItems = (prefix: string, field: string): Item[] => diff.removed.filter((id) => id.startsWith(prefix)).map((id) => ({ key: REMOVED + id, field, value: id.slice(prefix.length) }));
  if (topic === "workspace") {
    return {
      fields: ["windows", "groups", "removedWindows", "removedGroups"],
      items: [
        ...diff.changed.filter(([id]) => id.startsWith("w:")).map(([key, value]) => ({ key, field: "windows", value })),
        ...diff.changed.filter(([id]) => id.startsWith("g:")).map(([key, value]) => ({ key, field: "groups", value })),
        ...removedItems("w:", "removedWindows"),
        ...removedItems("g:", "removedGroups"),
      ],
    };
  }
  return { fields: [topic, "removed"], items: [...diff.changed.map(([key, value]) => ({ key, field: topic, value })), ...removedItems("", "removed")] };
}

function nextBaseline(diff: Diff, sentKeys: Set<string>): Sent {
  const next: Sent = new Map(diff.before ?? []);
  for (const [id] of diff.changed) if (sentKeys.has(id)) next.set(id, diff.signatures.get(id)!);
  for (const id of diff.removed) if (sentKeys.has(REMOVED + id)) next.delete(id);
  return next;
}

function commitItems(s: BrowserState, commits: PageCommit[], r: Redaction): Item[] {
  return commits.flatMap((c) => {
    const t = s.tabs[c.tabId];
    if (!t || !isEligibleTab(s, c.tabId)) return [];
    const url = pluginStateUrl(c.url, r);
    if (url === null) return [];
    const title = t.url === c.url ? cleanStateText(t.customTitle || t.title, 500) : null;
    return [{ key: null, field: "commits", value: { tabId: c.tabId, windowId: t.windowId, url, title, sameDocument: c.sameDocument } }];
  });
}

function send(sub: Subscriber, lines: string[]): number {
  for (const line of lines) sendToPlugin(sub.name, sub.run, line);
  return lines.length;
}

type Round = { left: number };

function deliver(sub: Subscriber, topic: StateTopic, s: BrowserState, r: Redaction, cache: Map<string, Rows>, commits: PageCommit[], time: number, round: Round): number {
  if (topic === "navigation") {
    const items = commitItems(s, commits, r);
    return items.length ? send(sub, packEvents(topic, ["commits"], items, { initial: false, time }).lines) : 0;
  }
  const diff = diffRows(sub, topic, rowsOf(topic, s, r, cache));
  if (diff.before && !diff.changed.length && !diff.removed.length) return 0;
  const { fields, items } = itemsFor(diff, topic);
  const packed = packEvents(topic, fields, items, { initial: !diff.before, time, roundBytes: Math.max(0, round.left) });
  round.left -= packed.lines.reduce((n, line) => n + byteLength(line) + 1, 0);
  const count = send(sub, packed.lines);
  sub.sent.set(topic, nextBaseline(diff, packed.sentKeys));
  if (packed.held) markDirty([topic]);
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
  const round: Round = { left: STATE_ROUND_BYTES };
  for (const topic of sub.topics) {
    if (!topics.has(topic) || !grantsTopic(m.permissions.state, topic)) continue;
    try {
      delivered[topic === "navigation" ? "navigation" : "state"] += deliver(sub, topic, s, r, cache, commits, time, round);
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
