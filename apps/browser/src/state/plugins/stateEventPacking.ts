export const STATE_EVENT_BUDGET_BYTES = 256 * 1024;
export const STATE_ROUND_BYTES = 1024 * 1024;

export type Event = Record<string, unknown>;
export type Item = { key: string | null; field: string; value: unknown };
export type Packed = { events: Event[]; lines: string[]; sentKeys: Set<string>; held: boolean };

const encoder = new TextEncoder();
export const byteLength = (text: string) => encoder.encode(text).length;

const LONGEST_TIME = 9_999_999_999_999;
const PAGE_ROOM = 64;

export const wireLine = (topic: string, time: number, data: Event) => JSON.stringify({ event: `state.${topic}`, time, data });

function envelopeBytes(topic: string, fields: readonly string[]): number {
  const data: Event = { initial: true, more: true, ...Object.fromEntries(fields.map((f) => [f, []])) };
  return byteLength(wireLine(topic, LONGEST_TIME, data)) + 1;
}

function pagedGroup(value: Record<string, unknown>, room: number): Record<string, unknown>[] | null {
  const ids = value.tabIds;
  if (!Array.isArray(ids)) return null;
  const base = byteLength(JSON.stringify({ ...value, tabIds: [], tabIdsPage: { index: ids.length, count: ids.length } })) + PAGE_ROOM;
  if (base >= room) return null;
  const pages: unknown[][] = [];
  let page: unknown[] = [];
  let size = base;
  for (const id of ids) {
    const bytes = byteLength(JSON.stringify(id)) + 1;
    if (page.length && size + bytes > room) {
      pages.push(page);
      page = [];
      size = base;
    }
    page.push(id);
    size += bytes;
  }
  pages.push(page);
  return pages.map((tabIds, index) => ({ ...value, tabIds, tabIdsPage: { index, count: pages.length } }));
}

function fitted(items: Item[], room: number): Item[] {
  return items.flatMap((item) => {
    if (byteLength(JSON.stringify(item.value)) + 1 <= room) return [item];
    const pages = typeof item.value === "object" && item.value !== null ? pagedGroup(item.value as Record<string, unknown>, room) : null;
    if (!pages) throw new Error(`A ${item.field} entry is larger than one state event.`);
    return pages.map((value) => ({ ...item, value }));
  });
}

export function packEvents(topic: string, fields: readonly string[], given: Item[], options: { initial: boolean; time: number; roundBytes?: number; budget?: number }): Packed {
  const budget = options.budget ?? STATE_EVENT_BUDGET_BYTES;
  const envelope = envelopeBytes(topic, fields);
  const items = fitted(given, budget - envelope);
  const empty = (): Event => Object.fromEntries(fields.map((f) => [f, [] as unknown[]]));
  const events: Event[] = [];
  const sentKeys = new Set<string>();
  let current = empty();
  let size = envelope;
  let inCurrent = 0;
  let spent = 0;
  let held = false;
  for (let i = 0; i < items.length; i++) {
    const item = items[i]!;
    const startsKey = i === 0 || item.key === null || items[i - 1]!.key !== item.key;
    if (startsKey && spent + (inCurrent ? size : 0) >= (options.roundBytes ?? Infinity)) {
      held = true;
      break;
    }
    const bytes = byteLength(JSON.stringify(item.value)) + 1;
    if (inCurrent && size + bytes > budget) {
      events.push(current);
      spent += size;
      current = empty();
      size = envelope;
      inCurrent = 0;
    }
    (current[item.field] as unknown[]).push(item.value);
    if (item.key !== null) sentKeys.add(item.key);
    size += bytes;
    inCurrent++;
  }
  if (!options.initial && (!items.length || (held && !sentKeys.size))) return { events: [], lines: [], sentKeys, held };
  if (inCurrent || !events.length) events.push(current);
  if (options.initial) events[0] = { initial: true, ...events[0] };
  if (held) events[events.length - 1] = { ...events[events.length - 1], more: true };
  const lines = events.map((data) => wireLine(topic, options.time, data));
  for (const line of lines) if (byteLength(line) + 1 > budget) throw new Error("A state event came out larger than its budget.");
  return { events, lines, sentKeys, held };
}
