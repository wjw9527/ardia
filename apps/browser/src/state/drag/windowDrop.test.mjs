import assert from "node:assert/strict";
import { test } from "node:test";
const { useBrowser } = await import("../browser/store.ts");
const { rootPointIn, screenPoint, windowUnder, dropTabsOutside } = await import("./windowDrop.ts");
const { useInterfaceScale } = await import("../settings/interfaceScale.ts");
await import("../../test-native/index.ts");

const S = () => useBrowser.getState();
const atScale = (scale, run) => {
  useInterfaceScale.setState({ scale });
  try {
    return run();
  } finally {
    useInterfaceScale.setState({ scale: 1 });
  }
};

test("a root point leaves its window as a screen point at the window's scale, and comes back in another window's root points", () => {
  const id = S().createWindow({ url: "https://a.example/", frame: [100, 200, 1000, 800] });
  assert.deepEqual(screenPoint(S(), id, 40, 60), [140, 940]);
  atScale(1.25, () => {
    assert.deepEqual(screenPoint(S(), id, 40, 60), [150, 925]);
    assert.deepEqual(rootPointIn([100, 200, 1000, 800], [150, 925]), [40, 60]);
    assert.deepEqual(rootPointIn([600, 100, 500, 500], [850, 350]), [200, 200]);
  });
});

test("at a larger scale the window's edge is its physical width divided by the scale", () => {
  const id = S().createWindow({ url: "https://b.example/", frame: [0, 0, 1000, 800] });
  assert.equal(windowUnder(S(), id, 900, 100).outside, false);
  atScale(1.25, () => {
    assert.equal(windowUnder(S(), id, 790, 100).outside, false);
    assert.equal(windowUnder(S(), id, 801, 100).outside, true);
    assert.equal(windowUnder(S(), id, 100, 641).outside, true);
  });
});

test("a tab dropped outside opens a window whose grab offsets are root points at the scale", () => {
  const id = S().createWindow({ url: "https://c.example/", frame: [5000, 0, 1000, 800] });
  const extra = S().newTab(id, { url: "https://c.example/two" });
  let frame = null;
  atScale(1.5, () => dropTabsOutside([extra], id, 700, 100, (f) => (frame = f)));
  assert.deepEqual(frame, [5000 + 1050 - 135, 800 - 150 - 800 + 105, 1000, 800]);
});

test("detaching a group makes a blank window in the dragged tabs' Profile with its split and live tabs", () => {
  S().hydrate({});
  S().updateSettings({ shareTabsAcrossWindows: true });
  const work = S().createProfile({ name: "Work" });
  const source = S().createWindow({ profileId: work, url: "https://pinned.example/", frame: [5000, 0, 1000, 800] });
  const pin = S().windows[source].tabIds[0];
  S().togglePin(pin);
  const first = S().newTab(source, { url: "https://page.example/" });
  assert.ok(S().openSplitPane(source, { anchorTabId: first, url: "https://split.example/" }).ok);
  const split = Object.values(S().splits)[0];
  const tabs = S().windows[source].tabIds.filter((id) => id !== pin);
  const group = S().groupTabs(tabs, { name: "Research", pinned: false });
  const blank = dropTabsOutside(tabs, source, 1100, 100);
  assert.ok(blank);
  assert.equal(S().windows[blank].blank, true);
  assert.equal(S().windows[blank].profileId, work);
  assert.deepEqual(S().windows[blank].tabIds, tabs);
  assert.deepEqual(S().windows[source].tabIds, [pin]);
  assert.equal(S().groups[group].windowId, blank);
  assert.equal(S().splits[split.id].windowId, blank);
  assert.equal(S().tabs[first].page.kind, "loaded");

  const target = S().moveTabsToWindow(tabs, null);
  assert.ok(target);
  assert.equal(S().windows[target].blank, undefined);
  assert.equal(S().windows[target].profileId, work);
  assert.equal(S().tabs[first].windowId, target);
  assert.equal(S().groups[group].windowId, target);
  assert.equal(S().splits[split.id].windowId, target);
});

test("dropping on a blank window from a different Profile leaves the tab at its source", () => {
  S().hydrate({});
  const work = S().createProfile({ name: "Work" });
  const source = S().createWindow({ profileId: work, url: "https://work.example/", frame: [0, 0, 1000, 800] });
  const tab = S().windows[source].tabIds[0];
  const blank = S().createWindow({ blank: true, frame: [1000, 0, 1000, 800] });
  assert.equal(dropTabsOutside([tab], source, 1100, 100), null);
  assert.equal(S().tabs[tab].windowId, source);
  assert.equal(S().windows[blank].tabIds.length, 1);
});

test("dropping a group onto a blank window leaves its existing tabs in place", () => {
  S().hydrate({});
  const source = S().createWindow({ url: "https://stay.example/", frame: [0, 0, 1000, 800] });
  const first = S().newTab(source, { url: "https://first.example/" });
  const second = S().newTab(source, { url: "https://second.example/" });
  const group = S().groupTabs([first, second], { name: "Research", pinned: false });
  const members = S().groups[group].tabIds;
  const blank = S().createWindow({ blank: true, url: "https://local.example/", frame: [1000, 0, 1000, 800] });
  const local = S().windows[blank].tabIds[0];
  assert.equal(dropTabsOutside([first, second], source, 1100, 100), blank);
  assert.equal(S().windows[blank].tabIds.length, 3);
  assert.ok(S().windows[blank].tabIds.includes(local));
  assert.deepEqual(S().groups[group].tabIds, members);
});
