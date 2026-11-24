#!/usr/bin/env node
const usage = `engine-cli-check.mjs <Ardia.app> [metro host:port] [scratch dir]

Launches a hidden Ardia with control on and no DevTools port, and drives it only through ArdiaControl.sock to check the
engine's tab primitives (#4055): devtools.attach/send/batch/detach with pushed events, tabs.snapshot (refs across a
cross-site iframe and a closed shadow root, boxes that match the page's own geometry, covered elements, modal scope),
tabs.waitSettled over a delayed fetch, tabs.hitTest and tabs.click (blocked by a cookie banner, its dismiss button,
then the click landing, inside the cross-site iframe too, and a far element scrolled into view), a stale ref rebound
after the page re-renders it, and tabs.screenshot and Page.captureScreenshot of a tab that isn't on screen. Every
shared hostile input is sent as each new method's params and must be refused. A Debug build needs its Metro as the
second argument. The run uses a new folder inside the scratch dir and removes only that folder.`;

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import { join, resolve } from "node:path";
import { session } from "../../../scripts/lib/instance.mjs";
import { HOSTILE_VALUES } from "../../../scripts/security/hostile-inputs.mjs";

const [appArg, metroArg, scratchArg] = process.argv.slice(2);
if (!appArg || appArg === "-h" || appArg === "--help") {
  console.log(usage);
  process.exit(appArg ? 0 : 64);
}
const app = resolve(appArg);
const scratch = resolve(scratchArg ?? process.env.TMPDIR ?? "/tmp");
fs.mkdirSync(scratch, { recursive: true });
const work = fs.mkdtempSync(join(scratch, "ac-engine-cli-"));
const data = join(work, "d");
fs.mkdirSync(data, { recursive: true });
fs.writeFileSync(join(data, "session.json"), JSON.stringify(session({ settings: { cliControl: true } })));
fs.writeFileSync(join(data, "onboarding.json"), JSON.stringify({ version: 1, completedAt: 1 }));

let failures = 0;
const check = (name, ok, detail) => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${ok || detail === undefined ? "" : `  (${JSON.stringify(detail).slice(0, 700)})`}`);
  if (!ok) failures++;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let port = 0;
const page = (body) => `<!doctype html><html><head><meta charset="utf-8"><title>t</title><style>body{font:16px sans-serif;margin:0;padding:20px}</style></head><body>${body}</body></html>`;
const pages = {
  "/main": () =>
    page(`<h1>Main page</h1>
<button id="save" style="position:absolute;left:40px;top:300px;width:120px;height:40px" onclick="document.title='saved'">Save</button>
<div id="host" style="position:absolute;left:300px;top:120px"></div>
<iframe id="f" src="http://127.0.0.1:${port}/frame" style="position:absolute;left:40px;top:120px;width:220px;height:120px;border:0"></iframe>
<div id="banner" style="position:fixed;left:0;right:0;top:260px;height:140px;background:#eee;z-index:10"><p>We use cookies</p><button onclick="document.getElementById('banner').remove()">Reject all</button> <button onclick="document.getElementById('banner').remove()">Accept all</button></div>
<script>
const root = document.getElementById('host').attachShadow({mode:'closed'});
root.innerHTML = '<button id="sh">Shadow action</button>';
root.getElementById('sh').onclick = () => { document.title = 'shadow'; };
addEventListener('message', (e) => { if (e.data === 'frame-click') document.title = 'frame'; });
window.rerender = () => { const b = document.getElementById('save'); const c = b.cloneNode(true); b.replaceWith(c); };
</script>`),
  "/frame": () => page(`<button id="fb" style="width:150px;height:40px" onclick="parent.postMessage('frame-click','*')">Frame button</button>`),
  "/slow": () => page(`<h1>Slow</h1><script>addEventListener('load',()=>{setTimeout(()=>fetch('/delay?ms=1500').then(()=>{document.title='fetched'}),50)})</script>`),
  "/modal": () => page(`<h1>Behind</h1><button>Outside</button><dialog id="d"><h2>Confirm</h2><button onclick="d.close()">Close</button><button>Keep</button></dialog><script>d.showModal()</script>`),
  "/scroll": () => page(`<div style="height:2400px"></div><button id="far" onclick="document.title='far'">Far button</button><div style="height:400px"></div>`),
};
const server = http.createServer((req, res) => {
  const url = new URL(req.url, "http://x");
  if (url.pathname === "/delay") {
    setTimeout(() => {
      res.writeHead(200, { "content-type": "text/plain" });
      res.end("ok");
    }, Number(url.searchParams.get("ms") ?? 1000));
    return;
  }
  const route = pages[url.pathname];
  res.writeHead(route ? 200 : 404, { "content-type": "text/html" });
  res.end(route ? route() : "");
});
await new Promise((done) => server.listen({ port: 0, host: "127.0.0.1" }, done));
port = server.address().port;
const origin = `http://localhost:${port}`;

let appPid = 0;
let client = null;
function cleanup(code) {
  try { client?.socket.destroy(); } catch {}
  if (appPid) {
    try { process.kill(appPid, "SIGTERM"); } catch {}
    for (let i = 0; i < 50; i++) {
      try { process.kill(appPid, 0); } catch { break; }
      execFileSync("sleep", ["0.1"]);
    }
    try { process.kill(appPid, "SIGKILL"); } catch {}
  }
  server.close();
  fs.rmSync(work, { recursive: true, force: true });
  process.exit(code);
}
setTimeout(() => {
  console.log("FAIL  the check ran past its 6 minute deadline");
  cleanup(2);
}, 360_000).unref();

execFileSync("open", ["-g", "-n", "--env", "ARDIA_BACKGROUND=1", "--env", `ARDIA_DATA_DIR=${data}`, ...(metroArg ? ["--env", `ARDIA_INSTANCE=jsLocation=${metroArg}`] : []), "--stdout", join(data, "app.out.log"), "--stderr", join(data, "app.out.log"), app]);

function connect(path) {
  return new Promise((done, fail) => {
    const socket = net.connect(path);
    let buffer = "";
    let nextId = 0;
    const waiting = new Map();
    const events = [];
    socket.on("data", (chunk) => {
      buffer += chunk.toString("utf8");
      let at;
      while ((at = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, at);
        buffer = buffer.slice(at + 1);
        if (!line) continue;
        const msg = JSON.parse(line);
        if (msg.event) events.push(msg);
        else waiting.get(msg.id)?.(msg);
      }
    });
    socket.on("error", fail);
    socket.on("connect", () =>
      done({
        socket,
        events,
        call: (method, params) =>
          new Promise((answer) => {
            const id = ++nextId;
            const timer = setTimeout(() => {
              waiting.delete(id);
              answer({ error: { code: "timeout", message: `no reply to ${method} in 30 s` } });
            }, 30_000);
            waiting.set(id, (msg) => {
              clearTimeout(timer);
              waiting.delete(id);
              answer(msg);
            });
            socket.write(JSON.stringify({ id, method, ...(params ? { params } : {}) }) + "\n");
          }),
      }),
    );
  });
}

const sockPath = join(data, "ArdiaControl.sock");
for (let i = 0; i < 300 && !client; i++) {
  if (fs.existsSync(sockPath)) {
    try {
      client = await connect(sockPath);
      const hello = await client.call("hello", {});
      if (hello.error) {
        client.socket.destroy();
        client = null;
        await sleep(300);
      }
    } catch {
      client = null;
      await sleep(300);
    }
  } else await sleep(300);
}
if (!client) {
  console.log("FAIL  the control socket never answered");
  cleanup(1);
}
const status = await client.call("windows", {});
for (let i = 0; i < 40 && !(status.result ?? []).length; i++) await sleep(250);
try {
  appPid = Number(execFileSync("lsof", ["-t", sockPath]).toString().trim().split("\n")[0]) || 0;
} catch {}
check("the instance runs with no DevTools port", !fs.existsSync(join(data, "Chromium", "DevToolsActivePort")));

const ok = async (method, params) => {
  const reply = await client.call(method, params);
  if (reply.error) throw new Error(`${method}: ${JSON.stringify(reply.error)}`);
  return reply.result;
};
const run = async (name, work) => {
  try {
    await work();
  } catch (error) {
    check(name, false, String(error?.message ?? error));
  }
};

async function openTab(path, activate = false) {
  const applied = await ok("apply", { ops: [{ op: "open", urls: [`${origin}${path}`], ...(activate ? { activate: true } : {}) }] });
  const tab = applied.results?.[0]?.tabs?.[0] ?? applied.tabs?.[0];
  for (let i = 0; i < 60; i++) {
    const row = await client.call("tabs.get", { tab });
    if (row.result && !row.result.loading && row.result.url?.includes(path)) break;
    await sleep(250);
  }
  await ok("tabs.waitSettled", { tab, timeoutMs: 8000 }).catch(() => undefined);
  return tab;
}

const shown = await openTab("/main", true);
const background = await openTab("/scroll");

let attached = null;
await run("devtools.attach opens a session with no prompt and events come back on the connection", async () => {
  attached = await ok("devtools.attach", { tab: shown });
  const before = client.events.length;
  await ok("devtools.send", { session: attached.session, method: "Runtime.enable" });
  await ok("devtools.send", { session: attached.session, method: "Runtime.evaluate", params: { expression: "console.log('ping-4055')" } });
  for (let i = 0; i < 40 && !client.events.slice(before).some((e) => e.event === "devtools.event" && e.data.method === "Runtime.consoleAPICalled"); i++) await sleep(100);
  const consoleEvent = client.events.slice(before).find((e) => e.event === "devtools.event" && e.data.method === "Runtime.consoleAPICalled");
  check("a console event is pushed on the connection", consoleEvent?.data.params?.args?.[0]?.value === "ping-4055", consoleEvent);
  const value = await ok("devtools.send", { session: attached.session, method: "Runtime.evaluate", params: { expression: "1+2", returnByValue: true } });
  check("devtools.send answers a command", value.result?.result?.value === 3, value);
  const batch = await ok("devtools.batch", { session: attached.session, commands: [{ method: "Runtime.evaluate", params: { expression: "location.pathname", returnByValue: true } }, { method: "No.suchMethod" }, { method: "Runtime.evaluate", params: { expression: "2" } }] });
  check("devtools.batch answers in order and stops at the first error", batch.completed === 1 && batch.stopped && batch.results[0].result?.result?.value === "/main", batch);
  const auto = await ok("devtools.send", { session: attached.session, method: "Target.setAutoAttach", params: { autoAttach: true, waitForDebuggerOnStart: false, flatten: true } });
  for (let i = 0; i < 20 && !client.events.some((e) => e.data?.method === "Target.attachedToTarget"); i++) await sleep(100);
  const child = client.events.find((e) => e.data?.method === "Target.attachedToTarget" && e.data.params?.targetInfo?.type === "iframe");
  check("a flattened child session for the cross-site iframe is reported", !!child && !!auto, child?.data.params?.targetInfo);
  if (child) {
    const inFrame = await ok("devtools.send", { session: attached.session, sessionId: child.data.params.sessionId, method: "Runtime.evaluate", params: { expression: "location.host", returnByValue: true } });
    check("a command runs in the child session", String(inFrame.result?.result?.value).startsWith("127.0.0.1"), inFrame);
  }
});

let snap = null;
await run("tabs.snapshot", async () => {
  snap = await ok("tabs.snapshot", { tab: shown });
  const by = (name) => snap.refs.find((r) => r.name === name);
  const save = by("Save");
  const frameButton = by("Frame button");
  const shadow = by("Shadow action");
  check("the snapshot lists the page, the cross-site iframe's button and the closed shadow root's button", !!save && !!frameButton && !!shadow && snap.counts.frames >= 2, snap.refs.map((r) => `${r.ref}:${r.role}:${r.name ?? ""}`));
  const rect = await ok("devtools.send", { session: attached.session, method: "Runtime.evaluate", params: { expression: "JSON.stringify(document.getElementById('save').getBoundingClientRect())", returnByValue: true } });
  const real = JSON.parse(rect.result.result.value);
  const off = save ? Math.max(Math.abs(save.box[0] - real.x), Math.abs(save.box[1] - real.y), Math.abs(save.box[2] - real.width), Math.abs(save.box[3] - real.height)) : 999;
  check("a ref's box matches the page's own geometry within a pixel", off <= 1, { box: save?.box, real });
  const frameReal = { x: 40 + 20, y: 120 + 20 };
  check("an iframe's element is placed in the main viewport", frameButton && Math.abs(frameButton.box[0] - (40 + 8)) <= 30 && Math.abs(frameButton.box[1] - 128) <= 30, { box: frameButton?.box, frameReal });
  check("the covered Save button says what covers it", !!save?.occludedBy && snap.refs.some((r) => r.ref === save.occludedBy && r.blocker), save);
  const again = await ok("tabs.snapshot", { tab: shown });
  check("refs stay the same across snapshots", again.refs.find((r) => r.name === "Save")?.ref === save?.ref);
});

await run("tabs.hitTest and tabs.click", async () => {
  const save = snap.refs.find((r) => r.name === "Save");
  const hit = await ok("tabs.hitTest", { tab: shown, ref: save.ref });
  check("the hit test says the banner covers Save", hit.blocked === true && !!hit.blocker, hit);
  check("the banner's dismiss button is found, reject before accept", hit.dismiss?.name === "Reject all" && hit.dismiss?.kind === "reject" && hit.choices?.length === 2, hit.dismiss);
  const held = await ok("tabs.click", { tab: shown, ref: save.ref });
  check("a click on the covered button is held back", held.clicked === false && held.blocked === true, held);
  const dismissed = await ok("tabs.click", { tab: shown, ref: hit.dismiss.ref });
  check("clicking the dismiss button lands", dismissed.clicked === true, dismissed);
  await sleep(200);
  await ok("devtools.send", { session: attached.session, method: "Runtime.evaluate", params: { expression: "document.getElementById('save').addEventListener('click', (e) => { window.trustedClick = e.isTrusted; })" } });
  const clicked = await ok("tabs.click", { tab: shown, ref: save.ref });
  const title = await ok("devtools.send", { session: attached.session, method: "Runtime.evaluate", params: { expression: "document.title + ':' + window.trustedClick", returnByValue: true } });
  check("the click lands once the banner is gone, as trusted input", clicked.clicked === true && title.result.result.value === "saved:true", { clicked, title: title.result.result.value });
  const frameButton = snap.refs.find((r) => r.name === "Frame button");
  const frameClick = await ok("tabs.click", { tab: shown, ref: frameButton.ref });
  await sleep(300);
  const frameTitle = await ok("devtools.send", { session: attached.session, method: "Runtime.evaluate", params: { expression: "document.title", returnByValue: true } });
  check("a click inside the cross-site iframe lands", frameClick.clicked === true && frameTitle.result.result.value === "frame", { frameClick, title: frameTitle.result.result.value });
  const shadow = snap.refs.find((r) => r.name === "Shadow action");
  await ok("tabs.click", { tab: shown, ref: shadow.ref });
  const shadowTitle = await ok("devtools.send", { session: attached.session, method: "Runtime.evaluate", params: { expression: "document.title", returnByValue: true } });
  check("a click on a closed shadow root's button lands", shadowTitle.result.result.value === "shadow", shadowTitle.result.result.value);
  await ok("devtools.send", { session: attached.session, method: "Runtime.evaluate", params: { expression: "rerender()" } });
  const rebound = await ok("tabs.click", { tab: shown, ref: save.ref });
  check("a ref whose element was replaced is found again by role and name", rebound.clicked === true && rebound.rebound === true, rebound);
});

await run("tabs.click scrolls a far element into view", async () => {
  const far = (await ok("tabs.snapshot", { tab: background })).refs.find((r) => r.name === "Far button");
  check("the far button is listed as offscreen", far?.offscreen === true, far);
  const clicked = await ok("tabs.click", { tab: background, ref: far.ref });
  const session = await ok("devtools.attach", { tab: background });
  const title = await ok("devtools.send", { session: session.session, method: "Runtime.evaluate", params: { expression: "document.title", returnByValue: true } });
  check("the click scrolled it into view and landed, on a tab that isn't shown", clicked.clicked === true && title.result.result.value === "far", { clicked, title: title.result.result.value });
  await ok("devtools.detach", { session: session.session });
});

await run("tabs.snapshot scopes to an open modal dialog", async () => {
  const tab = await openTab("/modal");
  const modal = await ok("tabs.snapshot", { tab });
  check("only the topmost modal is listed", modal.scope === "modal" && modal.refs.some((r) => r.name === "Close") && !modal.refs.some((r) => r.name === "Outside"), modal);
  const whole = await ok("tabs.snapshot", { tab, wholePage: true });
  check("wholePage takes the page as its scope, where what showModal made inert stays out", whole.scope === "page" && whole.refs.some((r) => r.name === "Close") && !whole.refs.some((r) => r.name === "Outside"), whole.refs.map((r) => r.name));
});

await run("tabs.waitSettled", async () => {
  const tab = (await ok("apply", { ops: [{ op: "open", urls: [`${origin}/slow`] }] })).results?.[0]?.tabs?.[0];
  await sleep(300);
  const settled = await ok("tabs.waitSettled", { tab, timeoutMs: 10000, quietMs: 300 });
  check("the wait outlasts the delayed fetch and settles", settled.settled === true && settled.waitedMs >= 1200 && settled.network.seen >= 1 && settled.network.inflight === 0, settled);
  const short = await ok("tabs.waitSettled", { tab, timeoutMs: 100, quietMs: 5000 });
  check("a wait that runs out says so instead of failing", short.settled === false && short.timedOut === true, short);
});

await run("screenshots of a tab that isn't on screen", async () => {
  const shot = await ok("tabs.screenshot", { tab: background });
  const bytes = Buffer.from(shot.data ?? "", "base64");
  check("tabs.screenshot copies a hidden tab's surface", shot.hidden === true && bytes.length > 1000 && bytes[0] === 0xff && bytes[1] === 0xd8 && shot.width > 100, { hidden: shot.hidden, width: shot.width, height: shot.height, bytes: bytes.length });
  const png = await ok("tabs.screenshot", { tab: background, format: "png", clip: { x: 0, y: 0, width: 200, height: 100 } });
  const pngBytes = Buffer.from(png.data ?? "", "base64");
  check("a clipped PNG", pngBytes.slice(1, 4).toString() === "PNG" && png.width >= 200 && png.width <= 800, { width: png.width, height: png.height });
  const session = await ok("devtools.attach", { tab: background });
  const cdp = await ok("devtools.send", { session: session.session, method: "Page.captureScreenshot", params: { format: "jpeg", quality: 60 } });
  check("Page.captureScreenshot on a hidden tab is answered offscreen", typeof cdp.result?.data === "string" && cdp.result.data.length > 1000, { offscreen: cdp.offscreen, size: cdp.result?.data?.length });
  await ok("devtools.detach", { session: session.session });
});

await run("every shared hostile input is refused before the engine acts", async () => {
  let refused = 0;
  let total = 0;
  for (const { id, value } of HOSTILE_VALUES) {
    if (value === undefined) continue;
    const cases = [
      ["devtools.send", { session: attached.session, method: value }],
      ["devtools.send", { session: attached.session, method: "Runtime.evaluate", sessionId: value }],
      ["devtools.send", { session: value, method: "Runtime.evaluate" }],
      ["tabs.click", { tab: shown, ref: value }],
      ["tabs.hitTest", { tab: shown, x: value, y: 10 }],
      ["tabs.snapshot", { tab: value }],
      ["tabs.screenshot", { tab: shown, quality: value }],
      ["tabs.waitSettled", { tab: shown, timeoutMs: value }],
    ];
    for (const [method, params] of cases) {
      const valid =
        (typeof value === "string" && /^[A-Za-z][A-Za-z0-9]{0,63}\.[A-Za-z][A-Za-z0-9_]{0,63}$/.test(value) && params.method === value) ||
        (typeof value === "string" && /^[A-Za-z0-9]{1,128}$/.test(value) && params.sessionId === value) ||
        (typeof value === "string" && /^e[0-9]{1,9}$/.test(value) && params.ref === value) ||
        (typeof value === "number" && Number.isFinite(value) && Math.abs(value) <= 100000 && params.x === value) ||
        (Number.isSafeInteger(value) && value >= 1 && value <= 100 && params.quality === value) ||
        (Number.isSafeInteger(value) && value >= 100 && value <= 60000 && params.timeoutMs === value) ||
        (Number.isSafeInteger(value) && value >= 1 && params.session === value);
      if (valid) continue;
      total++;
      const reply = await client.call(method, params);
      if (reply.error) refused++;
      else check(`${method} refused ${id}`, false, params);
    }
  }
  check(`all ${total} hostile requests were refused`, refused === total, { refused, total });
});

await run("devtools.detach and a closed tab end sessions", async () => {
  const before = client.events.length;
  const detached = await ok("devtools.detach", { session: attached.session });
  check("devtools.detach ends the session", detached.closed === true);
  const after = await client.call("devtools.send", { session: attached.session, method: "Runtime.evaluate" });
  check("a detached session can't be used", after.error?.code === "no_window", after.error);
  const again = await ok("devtools.attach", { tab: background });
  await ok("apply", { ops: [{ op: "tab.close", tabs: [background] }] }).catch(async () => ok("apply", { ops: [{ op: "tab.close", tab: background }] }));
  for (let i = 0; i < 40 && !client.events.slice(before).some((e) => e.event === "devtools.detached" && e.data.session === again.session); i++) await sleep(100);
  check("closing the tab pushes devtools.detached", client.events.slice(before).some((e) => e.event === "devtools.detached" && e.data.session === again.session));
});

const status2 = await client.call("windows", {});
check("the instance is still serving", !status2.error);
console.log(failures ? `${failures} failed` : "all passed");
cleanup(failures ? 1 : 0);
