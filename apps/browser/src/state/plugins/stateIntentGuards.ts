import type { BrowserState } from "../browser/store";
import { inPinnedContainer } from "../browser/model";
import { rootOf } from "../groups/groups";
import type { TabPlacement } from "../pins/placing";
import { isSiteMuted } from "../tabs/mute";
import { withPanes } from "../automation/workspaceChecks";
import { destination, OpError, type Destination } from "../automation/workspaceTargets";
import type { Op } from "../automation/workspaceOps";

export type GuardProblem = { code: "bad_request" | "refused"; message: string };

type Zone = "tile" | "row" | "pinned-group" | "unpinned";

const ZONE_WORDS: Record<Zone, string> = { tile: "a Top Apps tile", row: "a pinned row", "pinned-group": "in a pinned group", unpinned: "unpinned" };

function zoneOfTab(s: BrowserState, id: string): Zone {
  const t = s.tabs[id]!;
  if (t.pin) return t.pin.as;
  return inPinnedContainer(s, id) ? "pinned-group" : "unpinned";
}

function zoneOfPlacement(s: BrowserState, p: TabPlacement): Zone {
  if (p.pinned) return p.row === false ? "tile" : "row";
  if (!p.groupId) return "unpinned";
  return rootOf(s.groups, p.groupId)?.pinned ? "pinned-group" : "unpinned";
}

function panesOf(s: BrowserState, ids: string[]): string[] | GuardProblem {
  try {
    return withPanes(s, ids);
  } catch (error) {
    return { code: "refused", message: error instanceof Error ? error.message.replace(/the ardia command/g, "this plugin") : "A tab in that split isn't one this plugin may use." };
  }
}

const refused = (message: string): GuardProblem => ({ code: "refused", message });

function staysPut(s: BrowserState, ids: string[], profileId: string, zone: Zone | "kept"): GuardProblem | null {
  for (const id of ids) {
    const t = s.tabs[id]!;
    if (t.profileId !== profileId) return refused(`Tab ${id} is in another profile than where it would go; a plugin can't move tabs between profiles.`);
    const own = zoneOfTab(s, id);
    if (zone === "kept" && own !== "unpinned") return refused(`Tab ${id} is ${ZONE_WORDS[own]}; a plugin moves only unpinned tabs to another window.`);
    if (zone !== "kept" && own !== zone) return refused(`Tab ${id} is ${ZONE_WORDS[own]} and would end up ${ZONE_WORDS[zone]}; pin or unpin it with tabs.pin or tabs.unpin first.`);
  }
  return null;
}

function moveProblem(s: BrowserState, op: Op): GuardProblem | null {
  const ids = panesOf(s, op.tabs as string[]);
  if (!Array.isArray(ids)) return ids;
  const groupId = op.group as string | null | undefined;
  const group = groupId === undefined ? undefined : groupId === null ? null : s.groups[groupId];
  if (groupId && !group) return refused(`There's no group ${groupId} this plugin may use.`);
  let dest: Destination | null;
  try {
    dest = destination([], op, new Set(ids), group);
  } catch (error) {
    return { code: error instanceof OpError && error.code === "no_window" ? "refused" : "bad_request", message: error instanceof Error ? error.message.replace(/the ardia command/g, "this plugin") : "That isn't a place tabs can go." };
  }
  if (dest) return staysPut(s, ids, dest.profileId, zoneOfPlacement(s, dest.placement));
  const windowId = op.window as string | undefined;
  if (windowId) return staysPut(s, ids, s.windows[windowId]!.profileId, "kept");
  const first = s.tabs[ids[0]!]!;
  return staysPut(s, ids, first.profileId, "unpinned");
}

function groupProblem(s: BrowserState, op: Op): GuardProblem | null {
  const ids = panesOf(s, op.tabs as string[]);
  if (!Array.isArray(ids)) return ids;
  const first = s.tabs[ids[0]!]!;
  for (const id of ids) {
    const t = s.tabs[id]!;
    if (t.windowId !== first.windowId || t.profileId !== first.profileId) return refused(`Tab ${id} is in another window or profile than tab ${first.id}; a plugin groups tabs only where they already are.`);
    if (zoneOfTab(s, id) !== "unpinned") return refused(`Tab ${id} is ${ZONE_WORDS[zoneOfTab(s, id)]}; a plugin groups only unpinned tabs.`);
  }
  return null;
}

function unmuteProblem(s: BrowserState, op: Op): GuardProblem | null {
  for (const id of op.tabs as string[]) {
    if (isSiteMuted(s, s.tabs[id]!)) return refused(`Tab ${id}'s site is muted in Ardia's settings; only you can unmute a site.`);
  }
  return null;
}

export function intentProblem(s: BrowserState, intent: string, op: Op): GuardProblem | null {
  if (intent === "tabs.move") return moveProblem(s, op);
  if (intent === "tabs.group") return groupProblem(s, op);
  if (intent === "tabs.unmute") return unmuteProblem(s, op);
  return null;
}
