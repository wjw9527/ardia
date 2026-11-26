import { sampleAppMemory, type SystemState } from "../../platform/performance";
import { everySlowly } from "../../platform/slowTimers";
import { webviews } from "../../platform/webviews";
import { withDeadline } from "../../lib/deadline";
import { PLATFORM_FEATURES } from "../../lib/platformFeatures";
import { PLATFORM_IDS } from "../../lib/platformTerms";
import { isQuitting } from "../app/quit";
import { useBrowser, type BrowserState } from "../browser/store";
import { tabEngine } from "../engines/engines";
import { isPlaying, useMedia } from "../media/media";
import { withSharedFamily } from "../pins/pinShare";
import type { Settings } from "../settings/settings";
import { withPinnedPanes } from "../splits/splits";
import { noteBudgetSweep, noteTabSleptOverBudget, noteTabSleptOverBudgetReopened } from "../telemetry/tabSleepCounts";
import { consentToken } from "../telemetry/client";
import { hasPage } from "./pageSession";
import { usePages } from "./pageState";
import { shownTabIds } from "./shownTabs";
import { isSleeping } from "./sleepingTabs";
import { liveOf } from "./tabLive";

export type LoadedTabBudget = { tabs: number; hiddenMs: number };
type AppMemoryReading = Pick<SystemState, "appMemoryBytes" | "appMemoryLimitBytes">;

const MINUTE = 60_000;
const GIB = 2 ** 30;
const SWEEP_MS = MINUTE;
const APP_MEMORY_SWEEP_MS = 15_000;
const APP_MEMORY_SAMPLE_DEADLINE_MS = 3000;
const APP_MEMORY_BUDGET: LoadedTabBudget = { tabs: 0, hiddenMs: 30_000 };
const MODES: Record<Settings["memorySaverMode"], { floor: number; perGib: number; hiddenMs: number }> = {
  moderate: { floor: 20, perGib: 2, hiddenMs: 120 * MINUTE },
  balanced: { floor: 10, perGib: 1, hiddenMs: 60 * MINUTE },
  maximum: { floor: 5, perGib: 0.5, hiddenMs: 30 * MINUTE },
};
const HIDDEN_UNDER_PRESSURE_MS = 10 * MINUTE;
const SLEEPS_PER_SWEEP = 4;
const ANSWER_WITHIN_MS = 1500;
const ASK_AGAIN_MS = 10 * MINUTE;
const KEPT_RECENTLY_MS = 60 * MINUTE;
const REOPENED_SOON_MS = 30 * MINUTE;
const RECENTLY_VISIBLE = 7;

export function loadedTabBudget(settings: Pick<Settings, "memorySaver" | "memorySaverMode">, sys: SystemState | null): LoadedTabBudget | null {
  if (!PLATFORM_FEATURES.sleepsTabsOverBudget || settings.memorySaver === false || !sys) return null;
  const mode = MODES[settings.memorySaverMode] ?? MODES.balanced;
  if (sys.memoryPressure !== "normal") return { tabs: mode.floor, hiddenMs: Math.min(mode.hiddenMs, HIDDEN_UNDER_PRESSURE_MS) };
  return { tabs: Math.max(mode.floor, Math.round((sys.physicalMemory / GIB) * mode.perGib)), hiddenMs: mode.hiddenMs };
}

export function inUse(s: BrowserState, id: string): boolean {
  const media = useMedia.getState();
  const access = usePages.getState().pages[id]?.mediaAccess;
  return (
    liveOf(id).playingAudio ||
    !!media.pipOpen[id] ||
    isPlaying(media.sessions[id]) ||
    !!(access && (access.camera || access.microphone || access.screen)) ||
    !!media.tabShares[id] ||
    Object.values(media.tabShares).some((share) => share.capturedTabId === id)
  );
}

const awakeOf = (s: BrowserState, loaded: Iterable<string>) => [...loaded].filter((id) => s.tabs[id] && hasPage(s.tabs[id]!) && !isSleeping(id));

function protectedTabs(s: BrowserState) {
  return new Set(withSharedFamily(s, withPinnedPanes(s, [...shownTabIds(s)])));
}

function canSleep(s: BrowserState, id: string, shown: ReadonlySet<string>) {
  const tab = s.tabs[id];
  return !!tab && hasPage(tab) && !isSleeping(id) && !shown.has(id) && tabEngine(s, id) === "chromium" && /^https?:\/\//i.test(tab.url) && !inUse(s, id);
}

export function tabsOverBudget(
  s: BrowserState,
  loaded: Iterable<string>,
  budget: LoadedTabBudget,
  now: number,
  seenAt: ReadonlyMap<string, number> = new Map(),
  askAgainAt: ReadonlyMap<string, number> = new Map(),
  skippedLoading: string[] = [],
): string[] {
  const awake = awakeOf(s, loaded);
  if (awake.length <= budget.tabs) return [];
  const shown = protectedTabs(s);
  const lastSeen = (id: string) => (shown.has(id) ? now : Math.max(s.tabs[id]!.lastActiveAt, seenAt.get(id) ?? 0));
  return awake
    .sort((a, b) => lastSeen(b) - lastSeen(a))
    .slice(budget.tabs)
    .filter(
      (id) =>
        canSleep(s, id, shown) &&
        now - lastSeen(id) >= budget.hiddenMs &&
        (askAgainAt.get(id) ?? 0) <= now &&
        !(liveOf(id).isLoading && skippedLoading.push(id)),
    )
    .reverse();
}

const seenAt = new Map<string, number>();
const askAgainAt = new Map<string, number>();
const sleptAt = new Map<string, number>();
const keptAt = new Map<string, number>();
let sweeping = false;

export function sleepTabsOverBudget(budget: LoadedTabBudget | null, now = Date.now()): Promise<string[]> {
  return budget ? sleepEligibleTabs(budget, now) : Promise.resolve([]);
}

export function sleepTabsOverAppMemory(readMemory: () => Promise<AppMemoryReading | null> = sampleAppMemory, now = Date.now()): Promise<string[]> {
  return sleepEligibleTabs(APP_MEMORY_BUDGET, now, async () => {
    const sample = await withDeadline(Promise.resolve().then(readMemory).catch(() => null), APP_MEMORY_SAMPLE_DEADLINE_MS, null);
    const { appMemoryBytes: used, appMemoryLimitBytes: limit } = sample ?? {};
    return typeof used === "number" && typeof limit === "number" && Number.isSafeInteger(used) && Number.isSafeInteger(limit) && limit > 0 && used > limit;
  });
}

async function sleepEligibleTabs(budget: LoadedTabBudget, now: number, shouldSleep?: () => Promise<boolean>): Promise<string[]> {
  if (sweeping || isQuitting()) return [];
  const s = useBrowser.getState();
  for (const id of shownTabIds(s)) seenAt.set(id, now);
  for (const id of seenAt.keys()) if (!s.tabs[id]) seenAt.delete(id);
  for (const [id, at] of askAgainAt) if (!s.tabs[id] || at <= now) askAgainAt.delete(id);
  for (const [id, at] of keptAt) if (!s.tabs[id] || now - at >= KEPT_RECENTLY_MS) keptAt.delete(id);
  const skippedLoading: string[] = [];
  const candidates = tabsOverBudget(s, webviews.keys(), budget, now, seenAt, askAgainAt, skippedLoading);
  const asking = [...candidates.filter((id) => !keptAt.has(id)), ...candidates.filter((id) => keptAt.has(id))].slice(0, SLEEPS_PER_SWEEP);
  if (shouldSleep && !asking.length) return [];
  const slept: string[] = [];
  sweeping = true;
  try {
    if (shouldSleep && !(await shouldSleep())) return [];
    noteBudgetSweep(skippedLoading.length, candidates.slice(0, SLEEPS_PER_SWEEP).filter((id) => !asking.includes(id)).length);
    const consent = consentToken();
    for (const [index, id] of asking.entries()) {
      if (isQuitting()) break;
      const latest = useBrowser.getState();
      if (!canSleep(latest, id, protectedTabs(latest)) || liveOf(id).isLoading) continue;
      const asked = Promise.resolve().then(() => webviews.get(id)?.sleepIfHidden(budget.hiddenMs / 1000)).catch(() => undefined);
      const keptBy = await withDeadline(asked, ANSWER_WITHIN_MS, undefined);
      if (keptBy?.length === 0) {
        slept.push(id);
        sleptAt.set(id, now);
        keptAt.delete(id);
        noteTabSleptOverBudget(consent);
        if (shouldSleep && index + 1 < asking.length && !(await shouldSleep())) break;
      } else if (keptBy?.includes(RECENTLY_VISIBLE)) seenAt.set(id, now);
      else {
        askAgainAt.set(id, now + ASK_AGAIN_MS);
        keptAt.set(id, now);
      }
    }
  } finally {
    sweeping = false;
  }
  return slept;
}

export function noteTabWoke(tabId: string, now = Date.now()) {
  const at = sleptAt.get(tabId);
  if (at === undefined) return;
  sleptAt.delete(tabId);
  if (now - at < REOPENED_SOON_MS) noteTabSleptOverBudgetReopened();
}

export function noteTabGone(tabId: string) {
  sleptAt.delete(tabId);
}

let started = false;

export function startLoadedTabBudget(system: () => SystemState | null) {
  if (started) return;
  started = true;
  const budget = () => loadedTabBudget(useBrowser.getState().settings, system());
  everySlowly({
    every: SWEEP_MS,
    run: () => void sleepTabsOverBudget(budget()),
    needed: () => awakeOf(useBrowser.getState(), webviews.keys()).length > (budget()?.tabs ?? Infinity),
  });
  if (PLATFORM_IDS.report === "macos") everySlowly({
    every: APP_MEMORY_SWEEP_MS,
    run: () => void sleepTabsOverAppMemory(),
  });
  if (__DEV__) (globalThis as { acLoadedTabBudget?: unknown }).acLoadedTabBudget = { sleepTabsOverBudget, budget, tabsOverBudget };
}
