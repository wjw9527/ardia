import { enqueueMicrotask } from "./reconciler";
import { HOST_METHODS as M } from "./protocol";
import type { Rpc } from "./rpc";
import type { Registry } from "./types";

export const STATE_PREFIX = "state.";

type Live = () => boolean;

export function createSubscriptionSync(rpc: Rpc, registry: Registry, report: (error: unknown) => void, live: Live) {
  let acknowledgedEvents = "";
  let acknowledgedTopics = "";
  let queued = false;
  let inFlight = false;
  let resyncing = false;

  const wantedEvents = () => [...registry.events.keys()].filter((name) => name !== "plugin.values").sort();
  const wantedTopics = () => [...registry.state.keys()].sort();

  const sync = () => {
    if (!live() || queued || inFlight) return;
    queued = true;
    enqueueMicrotask(() => {
      queued = false;
      void send();
    });
  };

  async function send() {
    if (!live() || inFlight) return;
    const events = wantedEvents();
    const signature = events.join(",");
    const topics = wantedTopics();
    const topicSignature = topics.join(",");
    if (signature === acknowledgedEvents && topicSignature === acknowledgedTopics) return;
    inFlight = true;
    let failedEvents = false;
    let failedTopics = false;
    try {
      if (signature !== acknowledgedEvents) {
        try {
          await rpc.request(M.subscribe, { events });
          acknowledgedEvents = signature;
        } catch (error) {
          failedEvents = true;
          report(error);
        }
      }
      if (topicSignature !== acknowledgedTopics) {
        try {
          await rpc.request(M.stateSubscribe, { topics });
          acknowledgedTopics = topicSignature;
        } catch (error) {
          failedTopics = true;
          report(error);
        }
      }
    } finally {
      inFlight = false;
    }
    const eventsMoved = wantedEvents().join(",") !== signature;
    const topicsMoved = wantedTopics().join(",") !== topicSignature;
    if ((!failedEvents && !failedTopics) || eventsMoved || topicsMoved) sync();
  }

  function deliverState(name: string, data: Record<string, unknown>, time: number | undefined) {
    for (const listener of [...(registry.state.get(name.slice(STATE_PREFIX.length)) ?? [])]) {
      try {
        listener(data, { name, time });
      } catch (error) {
        report(error);
      }
    }
  }

  async function resync() {
    if (!live() || resyncing || !registry.state.size) return;
    resyncing = true;
    try {
      const topics = wantedTopics();
      await rpc.request(M.stateSubscribe, { topics, resync: true });
      acknowledgedTopics = topics.join(",");
    } catch (error) {
      report(error);
    } finally {
      resyncing = false;
    }
  }

  const noteDropped = (dropped: unknown) => {
    if (typeof dropped === "number" && dropped > 0) void resync();
  };

  return { sync, deliverState, noteDropped };
}
