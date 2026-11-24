import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";

const stub = await import("../../test-native/index.ts");
const { requireNativeModule } = await import("../../test-native/expo.ts");
const { useBrowser } = await import("../browser/store.ts");
const { activeTabId } = await import("../browser/model.ts");
const { startPlugins } = await import("./start.ts");
const { usePlugins } = await import("./store.ts");
const lifecycle = await import("./lifecycle.ts");
const { ensurePluginActivated } = await import("./activation.ts");
const { settledStops } = await import("./process.ts");
const { flushStateEvents, stateSubscriberCount, STATE_CHUNK } = await import("./stateEvents.ts");
const { consentLines } = await import("./consent.ts");
const { redactedDownloads, pluginStateUrl } = await import("./pluginEventRedaction.ts");
const { readManifest } = await import("../../lib/pluginManifest.ts");
const { takePluginCounts } = await import("../telemetry/pluginCounts.ts");
const { setConsentPeriod, consentToken } = await import("../telemetry/consentPeriod.ts");
setConsentPeriod(true, "plugin-state-hooks-test");

const S = () => useBrowser.getState();
const P = () => usePlugins.getState();
const host = stub.pluginHost;
const native = requireNativeModule("ArdiaPlugins");
const nativeEvent = native.event;
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
const settle = async () => {
  for (let i = 0; i < 8; i++) await tick();
};
let nextId = 0;

const ALL_TOPICS = ["tabs", "workspace", "navigation", "downloads"];
const ALL_INTENTS = ["tabs.group", "tabs.ungroup", "tabs.move", "tabs.pin", "tabs.unpin", "tabs.mute", "tabs.unmute", "tabs.activate", "groups.update"];

const plugin = (name, permissions) => ({ manifest: 2, name, title: name, main: "index.js", permissions, contributes: { commands: [{ name: "go", title: "Go" }] } });
const WATCHER = plugin("watcher", { tabs: "read", state: { events: ALL_TOPICS } });
const FULL = plugin("full", { tabs: "read", fullUrls: true, state: { events: ["tabs", "navigation", "downloads"] } });
const DOWNLOADS_ONLY = plugin("fetcher", { state: { events: ["downloads"] } });
const ACTOR = plugin("actor", { tabs: "write", state: { intents: ALL_INTENTS } });
const NARROW = plugin("narrow", { tabs: "write", state: { events: ["tabs"], intents: ["tabs.pin"] } });
const PLAIN = plugin("plain", { tabs: "write" });

async function enable(...docs) {
  S().hydrate({});
  startPlugins();
  for (const name of Object.keys(P().records)) lifecycle.disablePlugin(name, consentToken());
  await settledStops();
  for (const key of ["starts", "stops", "replies", "events"]) host[key].length = 0;
  host.folders = docs.map((doc) => ({ name: doc.name, status: "ok", text: JSON.stringify(doc) }));
  await lifecycle.rescanPlugins(consentToken());
  for (const doc of docs) {
    assert.deepEqual(P().listings[doc.name].problems, [], doc.name);
    assert.ok(lifecycle.requestPluginConsent(doc.name));
    assert.ok(lifecycle.enablePlugin(doc.name, P().consent.hash));
  }
  await settle();
}

async function ask(name, method, params, run) {
  const id = ++nextId;
  const before = host.replies.length;
  stub.emitPluginLine({ name, run, line: JSON.stringify({ id, method, params }) });
  await settle();
  const reply = host.replies.slice(before).map((r) => JSON.parse(r.line)).find((r) => r.id === id);
  assert.ok(reply, `a reply to ${method}`);
  return reply;
}

async function activated(name) {
  const waiting = ensurePluginActivated(name, "test");
  await settle();
  const run = P().processes[name].run;
  assert.deepEqual((await ask(name, "ready", {}, run)).result, { ok: true });
  assert.equal(await waiting, run);
  return run;
}

const stateEvents = (name, topic) =>
  host.events
    .filter((e) => e.name === name)
    .map((e) => JSON.parse(e.line))
    .filter((e) => e.event === `state.${topic}`)
    .map((e) => e.data);

async function subscribed(doc, topics, setup = () => {}) {
  await enable(doc);
  setup();
  const run = await activated(doc.name);
  assert.deepEqual((await ask(doc.name, "state.subscribe", { topics }, run)).result, { ok: true, topics });
  flushStateEvents();
  return run;
}

beforeEach(() => takePluginCounts());
afterEach(() => {
  native.event = nativeEvent;
});

const download = (fields) => ({ url: "https://files.example/a.zip?token=s3cret#x", filename: "a.zip", path: "/Users/me/Downloads/a.zip", state: "downloading", paused: false, received: 1, total: 10, speed: 0, mimeType: "application/zip", profile: "", startTime: 1, ...fields });

test("the manifest gates every topic and intent, and needs tabs for tab topics and tabs: write for intents", () => {
  const problems = (permissions) => readManifest(JSON.stringify(plugin("p", permissions))).problems;
  assert.deepEqual(problems({ tabs: "read", state: { events: ["tabs"] } }), []);
  assert.deepEqual(problems({ state: { events: ["downloads"] } }), []);
  assert.match(problems({ state: { events: ["tabs"] } }).join("\n"), /state\.events: tabs needs tabs/);
  assert.match(problems({ state: { events: ["navigation"] } }).join("\n"), /navigation needs tabs/);
  assert.match(problems({ tabs: "read", state: { intents: ["tabs.pin"] } }).join("\n"), /intents need tabs: write/);
  for (const name of ["plugins.json", "consent.approve", "secrets.set", "permissions.grant", "settings.update", "profiles.update", "updates.pin", "keychain.write", "__proto__", "constructor"]) {
    assert.match(problems({ tabs: "write", state: { intents: [name] } }).join("\n"), /state\.intents\[0\] must be one of/, name);
    assert.match(problems({ tabs: "read", state: { events: [name] } }).join("\n"), /state\.events\[0\] must be one of/, name);
  }
  assert.match(problems({ tabs: "write", state: { intents: ["tabs.pin"], writes: ["plugins"] } }).join("\n"), /writes/);
  assert.match(problems({ tabs: "write", state: true }).join("\n"), /permissions\.state must be an object/);
});

test("the consent sheet names what a plugin hears and which changes it may make", () => {
  const lines = (doc) => consentLines(readManifest(JSON.stringify(doc)).manifest).map((l) => l.text).join("\n");
  assert.match(lines(WATCHER), /Hears when your tabs change, when your windows and groups change, when a tab goes to a new page, when a download starts/);
  assert.match(lines(WATCHER), /Never private windows, private downloads or where a file was saved/);
  assert.match(lines(ACTOR), /Can group tabs, ungroup tabs, move tabs, pin tabs/);
  assert.doesNotMatch(lines(PLAIN), /Hears when|Can group/);
});

test("an unpermitted subscription is refused whole and subscribes to nothing", async () => {
  await enable(NARROW);
  const run = await activated("narrow");
  const refused = await ask("narrow", "state.subscribe", { topics: ["tabs", "navigation"] }, run);
  assert.equal(refused.error.code, "refused");
  assert.match(refused.error.message, /navigation/);
  assert.equal(stateSubscriberCount(), 0);
  assert.equal((await ask("narrow", "state.subscribe", { topics: ["plugins"] }, run)).error.code, "bad_request");
  assert.equal((await ask("narrow", "state.subscribe", { topics: "tabs" }, run)).error.code, "bad_request");
  assert.equal((await ask("narrow", "state.subscribe", { topics: ["tabs"], fullUrls: true }, run)).error.code, "bad_request");
  assert.equal(takePluginCounts().plugin_state_subscribe_refusals, 1);
  await enable(PLAIN);
  const plainRun = await activated("plain");
  assert.equal((await ask("plain", "state.subscribe", { topics: ["tabs"] }, plainRun)).error.code, "refused");
  assert.equal((await ask("plain", "state.intent", { intent: "tabs.pin", args: { tabs: ["x"] } }, plainRun)).error.code, "refused");
});

test("tab events leave out private windows, incognito tabs, file and internal pages, queries and credentials", async () => {
  await enable(WATCHER);
  const w = S().createWindow({ url: "https://bank.example/statement?account=42#row" });
  const local = S().newTab(w, { url: "file:///Users/me/secret-plan.txt" });
  const settings = S().newTab(w, { url: "ardia://history" });
  const creds = S().newTab(w, { url: "https://user:hunter2@login.example/" });
  const blank = S().newTab(w, { url: "about:blank" });
  const priv = S().createWindow({ kind: "private", url: "https://private.example/?q=hidden" });
  const run = await activated("watcher");
  assert.deepEqual((await ask("watcher", "state.subscribe", { topics: ["tabs"] }, run)).result, { ok: true, topics: ["tabs"] });
  flushStateEvents();
  const [first, ...rest] = stateEvents("watcher", "tabs");
  assert.equal(rest.length, 0);
  assert.equal(first.initial, true);
  const shown = JSON.stringify(first);
  for (const secret of ["account=42", "#row", "secret-plan", "file:", "ardia://", "hunter2", "user:", "private.example", "hidden", "about:blank"]) assert.ok(!shown.includes(secret), secret);
  assert.ok(first.tabs.every((t) => t.windowId === w), "no private window's tabs");
  assert.ok(!first.tabs.some((t) => S().tabs[t.id]?.windowId === priv));
  const byId = Object.fromEntries(first.tabs.map((t) => [t.id, t]));
  assert.equal(byId[local].url, null);
  assert.equal(byId[local].title, null);
  assert.equal(byId[settings].url, null);
  assert.equal(byId[creds].url, null);
  assert.equal(byId[blank].url, null);
  assert.equal(first.tabs.find((t) => t.url?.startsWith("https://bank.example")).url, "https://bank.example/statement");
});

test("with fullUrls a tab's address keeps its query but never its fragment or a query that looks like a secret", async () => {
  await enable(FULL);
  const w = S().createWindow({ url: "https://news.example/a?page=2#top" });
  S().newTab(w, { url: "https://api.example/cb?access_token=abc&x=1" });
  const run = await activated("full");
  await ask("full", "state.subscribe", { topics: ["tabs"] }, run);
  flushStateEvents();
  const urls = stateEvents("full", "tabs")[0].tabs.map((t) => t.url).sort();
  assert.deepEqual(urls, ["https://api.example/cb", "https://news.example/a?page=2"]);
});

test("events arrive after the commit, coalesced, as diffs: one change, one small event", async () => {
  let w;
  const run = await subscribed(WATCHER, ["tabs", "navigation", "workspace"], () => (w = S().createWindow({ url: "https://a.example/" })));
  host.events.length = 0;
  const before = host.events.length;
  const tab = S().newTab(w, { url: "https://b.example/one" });
  for (let i = 0; i < 50; i++) S().updateTab(tab, { url: `https://b.example/page${i}?secret=${i}` });
  assert.equal(host.events.length, before, "nothing is sent inside the commit");
  flushStateEvents();
  const tabs = stateEvents("watcher", "tabs");
  assert.equal(tabs.length, 1, "fifty commits coalesce into one event");
  const changed = Object.fromEntries(tabs[0].tabs.map((t) => [t.id, t]));
  assert.equal(changed[tab].url, "https://b.example/page49");
  assert.deepEqual(Object.keys(changed).sort(), [tab, ...Object.keys(changed).filter((id) => id !== tab)].sort());
  assert.ok(Object.values(changed).every((t) => t.id === tab || t.active === false), "only the new tab, and the one it took over from");
  assert.equal(tabs[0].initial, undefined);
  const commits = stateEvents("watcher", "navigation");
  assert.equal(commits.length, 1);
  assert.deepEqual(commits[0].commits.map((c) => [c.tabId, c.url]), [[tab, "https://b.example/page49"]]);
  assert.ok(!JSON.stringify(host.events).includes("secret="));
  host.events.length = 0;
  S().closeTab(tab);
  flushStateEvents();
  const closed = stateEvents("watcher", "tabs")[0];
  assert.deepEqual(closed.removed, [tab]);
  assert.ok(closed.tabs.every((t) => t.id !== tab));
  host.events.length = 0;
  flushStateEvents();
  assert.equal(host.events.length, 0, "no change, no event");
  assert.equal((await ask("watcher", "state.subscribe", { topics: [] }, run)).result.ok, true);
  assert.equal(stateSubscriberCount(), 0);
});

test("navigation never reports a file, internal or private page", async () => {
  let w, priv;
  await subscribed(WATCHER, ["navigation"], () => {
    w = S().createWindow({ url: "https://a.example/" });
    priv = S().createWindow({ kind: "private", url: "https://p.example/" });
  });
  host.events.length = 0;
  const tab = activeTabId(S(), w);
  S().updateTab(tab, { url: "file:///etc/passwd" });
  S().updateTab(activeTabId(S(), priv), { url: "https://p.example/secret" });
  flushStateEvents();
  S().updateTab(tab, { url: "ardia://downloads" });
  flushStateEvents();
  assert.deepEqual(stateEvents("watcher", "navigation"), []);
});

test("download events leave out private downloads, where files were saved, and addresses the plugin can't see", async () => {
  const seed = () => {
    const priv = S().createWindow({ kind: "private", url: "https://p.example/" });
    S().upsertDownload(download({ id: "d1" }));
    S().upsertDownload(download({ id: "d2", offTheRecord: true, profile: S().windows[priv].profileId, filename: "private-thing.zip" }));
  };
  await subscribed(DOWNLOADS_ONLY, ["downloads"], seed);
  const [event] = stateEvents("fetcher", "downloads");
  assert.equal(event.initial, true);
  assert.deepEqual(event.downloads.map((d) => d.id), ["d1"]);
  assert.equal(event.downloads[0].url, null, "no tabs permission, no address");
  assert.equal(event.downloads[0].filename, "a.zip");
  const text = JSON.stringify(event);
  for (const secret of ["/Users/me", "Downloads/", "private-thing", "s3cret", "files.example"]) assert.ok(!text.includes(secret), secret);
  host.events.length = 0;
  S().upsertDownload(download({ id: "d1", state: "finished", received: 10 }));
  flushStateEvents();
  assert.deepEqual(stateEvents("fetcher", "downloads").map((e) => e.downloads.map((d) => [d.id, d.state])), [[["d1", "finished"]]]);
  const hidden = redactedDownloads({ ...S(), downloads: [download({ id: "p1", offTheRecord: true, profile: "x" }), download({ id: "p2", profile: "incognito:1@default" })] }, { full: true, urls: true });
  assert.deepEqual(hidden, []);
  await subscribed(FULL, ["downloads"], seed);
  const [full] = stateEvents("full", "downloads");
  assert.equal(full.downloads.find((d) => d.id === "d1").url, "https://files.example/a.zip");
});

test("workspace events list eligible windows and groups only", async () => {
  await enable(ACTOR, WATCHER);
  const w = S().createWindow({ url: "https://a.example/" });
  const b = S().newTab(w, { url: "https://b.example/" });
  const priv = S().createWindow({ kind: "private", url: "https://p.example/" });
  const actor = await activated("actor");
  const watcher = await activated("watcher");
  await ask("watcher", "state.subscribe", { topics: ["workspace"] }, watcher);
  flushStateEvents();
  const [first] = stateEvents("watcher", "workspace");
  assert.equal(first.initial, true);
  assert.ok(first.windows.some((x) => x.id === w));
  assert.ok(!first.windows.some((x) => x.id === priv));
  host.events.length = 0;
  const grouped = await ask("actor", "state.intent", { intent: "tabs.group", args: { tabs: [b], name: "Reading", color: "blue" } }, actor);
  assert.equal(grouped.result.ok, true);
  flushStateEvents();
  const [change] = stateEvents("watcher", "workspace");
  assert.deepEqual(change.groups.map((g) => [g.id, g.name, g.color, g.tabIds]), [[grouped.result.group, "Reading", "blue", [b]]]);
});

test("intents change tabs through Ardia's own operations, in normal windows only", async () => {
  await enable(ACTOR);
  const w = S().createWindow({ url: "https://a.example/" });
  const a = activeTabId(S(), w);
  const b = S().newTab(w, { url: "https://b.example/" });
  const c = S().newTab(w, { url: "https://c.example/" });
  const priv = S().createWindow({ kind: "private", url: "https://p.example/" });
  const privTab = activeTabId(S(), priv);
  const run = await activated("actor");
  const intent = (name, args) => ask("actor", "state.intent", { intent: name, args }, run);
  const grouped = await intent("tabs.group", { tabs: [a, b], name: "Pair" });
  assert.equal(grouped.result.ok, true);
  const group = grouped.result.group;
  assert.deepEqual(S().groups[group].tabIds.slice().sort(), [a, b].sort());
  assert.equal((await intent("groups.update", { group, name: "Renamed", collapsed: true })).result.ok, true);
  assert.equal(S().groups[group].name, "Renamed");
  assert.equal((await intent("tabs.pin", { tabs: [c] })).result.ok, true);
  assert.notEqual(S().tabs[c].pin, null);
  assert.equal((await intent("tabs.unpin", { tabs: [c] })).result.ok, true);
  assert.equal((await intent("tabs.mute", { tabs: [c] })).result.ok, true);
  assert.equal(S().tabs[c].muted, true);
  assert.equal((await intent("tabs.move", { tabs: [c], before: a })).result.ok, true);
  assert.equal((await intent("tabs.ungroup", { group })).result.ok, true);
  assert.equal(S().groups[group], undefined);
  for (const [name, args] of [
    ["tabs.pin", { tabs: [privTab] }],
    ["tabs.mute", { tabs: [privTab] }],
    ["tabs.group", { tabs: [a, privTab] }],
    ["tabs.move", { tabs: [a], window: priv }],
    ["tabs.move", { tabs: [privTab], window: w }],
    ["tabs.activate", { tab: privTab }],
  ]) {
    const reply = await intent(name, args);
    assert.equal(reply.error.code, "refused", `${name} ${JSON.stringify(args)}`);
  }
  assert.equal(S().tabs[privTab].pin, null);
  assert.equal(S().tabs[privTab].muted, false);
  assert.equal(S().tabs[privTab].windowId, priv);
  const counts = takePluginCounts();
  assert.equal(counts.plugin_state_intents, 7);
  assert.equal(counts.plugin_state_intent_refusals, 6);
});

test("no intent reaches a security-sensitive slice, whatever it is called or carries", async () => {
  await enable(ACTOR);
  const w = S().createWindow({ url: "https://a.example/" });
  const a = activeTabId(S(), w);
  const run = await activated("actor");
  const recordsBefore = JSON.stringify(P().records);
  const settingsBefore = JSON.stringify(S().settings);
  const profilesBefore = JSON.stringify(S().profiles);
  const SENSITIVE = ["plugins.json", "plugins.enable", "plugins.approve", "consent.approve", "consent.grant", "permissions.grant", "permissions.set", "secrets.set", "keychain.set", "settings.update", "settings.set", "profiles.update", "profiles.create", "updates.pin", "official.pin", "workspace.apply", "apply", "__proto__", "constructor", "toString", "hasOwnProperty", "tabs.close", "tabs.open", "", null, 1, ["tabs.pin"], { intent: "tabs.pin" }];
  for (const intent of SENSITIVE) {
    const reply = await ask("actor", "state.intent", { intent, args: { tabs: [a], key: "approved", value: "*" } }, run);
    assert.equal(reply.error.code, "bad_request", JSON.stringify(intent));
  }
  for (const extra of ['"profile":"default"', '"urls":["https://evil.example/"]', '"approved":true', '"permissions":{"control":true}', '"__proto__":{"as":"tile"}', '"constructor":"x"', '"toString":"x"']) {
    const args = JSON.parse(`{"tabs":[${JSON.stringify(a)}],${extra}}`);
    assert.equal((await ask("actor", "state.intent", { intent: "tabs.pin", args }, run)).error.code, "bad_request", extra);
  }
  assert.equal((await ask("actor", "state.intent", { intent: "tabs.pin", args: { tabs: [a] }, profile: "default" }, run)).error.code, "bad_request");
  assert.equal(JSON.stringify(P().records), recordsBefore);
  assert.equal(JSON.stringify(S().settings), settingsBefore);
  assert.equal(JSON.stringify(S().profiles), profilesBefore);
  assert.equal(S().tabs[a].pin, null);
});

test("a plugin that lost an intent can't use it, and one granted only some intents gets only those", async () => {
  await enable(NARROW);
  const w = S().createWindow({ url: "https://a.example/" });
  const a = activeTabId(S(), w);
  const run = await activated("narrow");
  assert.equal((await ask("narrow", "state.intent", { intent: "tabs.group", args: { tabs: [a] } }, run)).error.code, "refused");
  assert.equal((await ask("narrow", "state.intent", { intent: "tabs.pin", args: { tabs: [a] } }, run)).result.ok, true);
  lifecycle.disablePlugin("narrow", consentToken());
  await settledStops();
  const before = host.replies.length;
  stub.emitPluginLine({ name: "narrow", run, line: JSON.stringify({ id: ++nextId, method: "state.intent", params: { intent: "tabs.unpin", args: { tabs: [a] } } }) });
  await settle();
  assert.equal(host.replies.length, before, "a stopped run is not heard");
  assert.notEqual(S().tabs[a].pin, null);
});

test("a slow, hung or throwing plugin never blocks or breaks a commit", async () => {
  let w;
  await subscribed(WATCHER, ["tabs", "navigation", "workspace", "downloads"], () => (w = S().createWindow({ url: "https://a.example/" })));
  let sends = 0;
  native.event = () => {
    sends++;
    throw new Error("the plugin's channel is full");
  };
  const started = performance.now();
  const tabs = [];
  for (let i = 0; i < 200; i++) tabs.push(S().newTab(w, { url: `https://t${i}.example/` }));
  for (const id of tabs.slice(0, 100)) S().activate(id);
  const elapsed = performance.now() - started;
  assert.equal(sends, 0, "no plugin work runs inside a commit");
  assert.equal(tabs.every((id) => S().tabs[id]), true);
  assert.ok(elapsed < 5000, `commits stayed fast (${elapsed} ms)`);
  assert.doesNotThrow(() => flushStateEvents());
  assert.ok(sends > 0, "the flush ran and its failure was contained");
  native.event = nativeEvent;
  host.events.length = 0;
  S().closeTab(tabs[0]);
  flushStateEvents();
  const [resent] = stateEvents("watcher", "tabs");
  assert.ok(resent.tabs.length >= 199, "a failed send is sent again whole, not lost");
  assert.ok(takePluginCounts().plugin_state_events_dropped >= 1);
});

test("a big window arrives in chunks", async () => {
  await subscribed(WATCHER, ["tabs"], () => {
    const w = S().createWindow({ url: "https://a.example/" });
    for (let i = 0; i < STATE_CHUNK + 10; i++) S().newTab(w, { url: `https://n${i}.example/` });
  });
  const parts = stateEvents("watcher", "tabs");
  assert.equal(parts.length, 2);
  assert.equal(parts[0].initial, true);
  assert.equal(parts[1].initial, undefined);
  assert.equal(parts[0].tabs.length + parts[1].tabs.length, STATE_CHUNK + 11);
});

test("subscriptions end with the run", async () => {
  await subscribed(WATCHER, ["tabs"]);
  assert.equal(stateSubscriberCount(), 1);
  lifecycle.disablePlugin("watcher", consentToken());
  await settledStops();
  assert.equal(stateSubscriberCount(), 0);
});
