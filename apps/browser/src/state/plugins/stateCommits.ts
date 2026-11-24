import { reportPageCommits } from "../../platform/tabs";
import { consentToken, type ConsentToken } from "../telemetry/choice";

export type PageCommit = { tabId: string; url: string; at: number; sameDocument: boolean; consent: ConsentToken | null };

const latest = new Map<string, { url: string; at: number }>();
let collected = new Map<string, PageCommit>();
let listener: (() => void) | null = null;
let listeningSince = 0;

export function notePluginStateCommit(tabId: string, url: string | undefined, at: number | undefined) {
  if (!listener || !url || at === undefined || !Number.isFinite(at) || url === "about:blank") return;
  const last = latest.get(tabId);
  if (!last) {
    latest.set(tabId, { url, at });
    if (at <= listeningSince) return;
  } else if (at <= last.at && url === last.url) return;
  const sameDocument = !!last && at <= last.at;
  latest.set(tabId, { url, at: Math.max(at, last?.at ?? at) });
  collected.set(tabId, { tabId, url, at, sameDocument, consent: collected.get(tabId)?.consent ?? consentToken() });
  listener();
}

export function takePluginStateCommits(): PageCommit[] {
  const taken = [...collected.values()];
  collected = new Map();
  return taken;
}

export function listenForPluginStateCommits(on: (() => void) | null) {
  if (!!on === !!listener) {
    listener = on;
    return;
  }
  listener = on;
  latest.clear();
  collected = new Map();
  listeningSince = Date.now();
  void reportPageCommits("pluginState", !!on).catch(() => {});
}
