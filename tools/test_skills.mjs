// The nightly skill test (emkay-voice/emkay#21): install each candidate
// skill in Emkay, in a real headless Chromium, the way a user does it
// (the stock control panel's install button), and see whether it loads and
// answers its own examples. Results go into data/compat.json, which the
// store build reads: "works" is shown as such, "broken" is not offered.
//
//   CHROME=/path/to/chrome node tools/test_skills.mjs candidates.json [emkay-url]
//
// Each skill gets a fresh browser profile, so one skill's leftovers never
// decide another's result. Only Emkay's public page is used: nothing here
// needs to be built first.
import { spawn } from "child_process";
import { readFileSync, writeFileSync } from "fs";

const candidates = JSON.parse(readFileSync(process.argv[2], "utf8"));
const app = process.argv[3] || "https://app.emkay.ai/";
const COMPAT = new URL("../data/compat.json", import.meta.url);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const t0 = Date.now();
const log = (m) => console.log(`[${((Date.now() - t0) / 1000).toFixed(0)}s] ${m}`);

/** One browser, one page, CDP helpers; worker console lines are kept. */
async function browser(name) {
  const port = 9400 + Math.floor(Math.random() * 400);
  const chrome = spawn(process.env.CHROME, [
    "--headless=new", `--remote-debugging-port=${port}`, `--user-data-dir=/tmp/emkay-test-${name}`,
    "--window-size=390,844", "--autoplay-policy=no-user-gesture-required", "--no-first-run",
    "--lang=en-US", "--accept-lang=en-US", "about:blank"], { stdio: "ignore" });
  let target;
  for (let i = 0; i < 150 && !target; i++) {
    await sleep(200);
    try {
      target = (await (await fetch(`http://127.0.0.1:${port}/json`)).json())
        .find((t) => t.type === "page" && t.url.startsWith("about:blank"));
    } catch {}
  }
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((r) => (ws.onopen = r));
  let id = 0;
  const pending = new Map();
  const workerLog = [];
  ws.onmessage = (e) => {
    const m = JSON.parse(e.data);
    if (m.id) { pending.get(m.id)?.(m); pending.delete(m.id); }
    if (m.method === "Target.attachedToTarget" && m.params.targetInfo.type === "worker") {
      ws.send(JSON.stringify({ id: ++id, method: "Runtime.enable", sessionId: m.params.sessionId }));
      ws.send(JSON.stringify({ id: ++id, method: "Runtime.runIfWaitingForDebugger", sessionId: m.params.sessionId }));
    }
    if (m.method === "Runtime.consoleAPICalled" && m.sessionId) {
      workerLog.push(m.params.args.map((a) => a.value ?? a.description ?? "").join(" "));
    }
  };
  const send = (method, params = {}) => new Promise((r) => {
    const i = ++id; pending.set(i, r); ws.send(JSON.stringify({ id: i, method, params }));
  });
  const js = async (expression) => {
    const r = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
    return r.result?.result?.value ?? r.result?.exceptionDetails?.exception?.description;
  };
  const until = async (expression, seconds, what) => {
    for (let i = 0; i < seconds * 2; i++) {
      const v = await js(expression);
      if (v) return v;
      await sleep(500);
    }
    throw new Error(`timed out waiting for ${what}`);
  };
  const py = (code) => js(`window.emkay.call("python", {code: ${JSON.stringify(code)}})`);
  const close = () => { ws.close(); chrome.kill(); };
  return { send, js, until, py, close, workerLog };
}

const SKILLS = "import json; from emkay_mobile import boot; json.dumps(sorted(boot._manager.plugin_skills))";
// every bus message from here on, for seeing who answered
const COLLECT = `import builtins
from emkay_mobile import boot
builtins._emkay_seen = []
boot.bus().on("message", lambda m: builtins._emkay_seen.append(m if isinstance(m, str) else m.serialize()))
"ok"`;
const answeredBy = (sid) => `import builtins, json
hits = [s for s in builtins._emkay_seen if ('"speak"' in s or 'skill.handler.start' in s) and ${JSON.stringify(sid)} in s]
builtins._emkay_seen.clear()
json.dumps(len(hits))`;

/** Lines that say why a skill did not install or load. */
function why(lines, fallback) {
  const flat = lines.flatMap((l) => String(l).split("\n"))
    // OVOS' log prefix: "2026-11-15 21:58:29.974 - emkay - module:func:210 - ERROR - "
    .map((l) => l.replace(/^\S+ \S+ - \S+ - \S+ - [A-Z]+ - /, "").trim());
  // the exception itself says most ("ModuleNotFoundError: No module named 'x'")
  const hit = flat.filter((l) => /^[\w.]*(Error|Exception): /.test(l)).at(-1)
    || flat.filter((l) => /error|exception|failed|no matching distribution|requires/i.test(l)).at(-1);
  return (hit || fallback).replace(/\s+/g, " ").trim().slice(0, 200);
}

/** Install, load and ask one skill; returns {status, reason}. */
async function testOne(c) {
  const b = await browser(c.package.replace(/\W+/g, "-"));
  try {
    await b.send("Target.setAutoAttach", { autoAttach: true, waitForDebuggerOnStart: false, flatten: true });
    await b.send("Page.navigate", { url: app });
    const booting = setInterval(async () =>
      log(`  boot: ${await b.js(`document.getElementById("boot-text")?.textContent`)}`), 30000);
    try {
      await b.until(`!!document.getElementById("start") && !document.getElementById("start").hidden`, 400, "Emkay boot");
    } finally {
      clearInterval(booting);
    }
    log("  booted");
    await b.js(`document.getElementById("start").click(); navigator.serviceWorker.ready.then(() => true)`);
    await b.js(`document.getElementById("menu-panel").click(); true`);
    const doc = `document.getElementById("panel-frame").contentDocument`;
    await b.until(`${doc}?.readyState === "complete" && ${doc}.title`, 120, "settings panel");
    const w = `document.getElementById("panel-frame").contentWindow`;
    const api = async (method, path, body) => {
      const r = await b.js(`${w}.fetch("${path}", {method: "${method}",
        headers: {"content-type": "application/json"}${body ? `, body: JSON.stringify(${JSON.stringify(body)})` : ""}})
        .then(async (r) => ({status: r.status, body: await r.text()}))`);
      try { return JSON.parse(r.body); } catch { return { raw: String(r?.body ?? r).slice(0, 200) }; }
    };
    await api("POST", "/api/auth/token", { new: "emkay-skill-test" });
    const before = JSON.parse(await b.py(SKILLS));

    const job = await api("POST", "/api/plugins/install", { package: c.package });
    let state = job;
    for (let i = 0; i < 120 && job.id && !["done", "failed", "error"].includes(state.state); i++) {
      await sleep(5000);
      state = await api("GET", `/api/plugins/jobs/${job.id}`);
    }
    if (state.state !== "done") {
      return { status: "broken", reason: `does not install: ${why(state.lines || [], JSON.stringify(state).slice(0, 120))}` };
    }
    await sleep(8000);
    const added = JSON.parse(await b.py(SKILLS)).filter((s) => !before.includes(s));
    if (!added.length) {
      return { status: "broken", reason: `installs, but does not load: ${why(b.workerLog.slice(-60), "no skill appeared")}` };
    }
    const sid = added[0];
    log(`  loaded as ${sid}`);
    if (!c.examples.length) return { status: "untested", reason: "loads; it has no examples to try" };

    await sleep(45000);   // padatious trains the new intents
    await b.py(COLLECT);
    let answered = 0;
    for (const ex of c.examples) {
      await b.js(`window.emkay.call("say", {text: ${JSON.stringify(ex)}}); true`);
      await sleep(15000);
      const n = Number(await b.py(answeredBy(sid)));
      log(`  "${ex}": ${n ? "answered" : "not answered"} by it`);
      if (n) { answered++; break; }   // one is enough
    }
    if (answered) return { status: "works", reason: "" };
    return { status: "untested", reason: "loads, but did not answer its own examples here" };
  } catch (e) {
    return { status: "untested", reason: `test did not finish: ${e.message}` };
  } finally {
    b.close();
  }
}

const compat = JSON.parse(readFileSync(COMPAT, "utf8"));
const today = new Date().toISOString().slice(0, 10);
for (const c of candidates) {
  log(`${c.package} ${c.version}`);
  const result = await testOne(c);
  log(`  -> ${result.status}${result.reason ? `: ${result.reason}` : ""}`);
  if (result.reason.startsWith("test did not finish")) continue;   // tried again next night
  compat[c.package] = { ...result, version: c.version, tested: today };
  writeFileSync(COMPAT, JSON.stringify(compat, null, 1) + "\n");   // after each, so a crash keeps the rest
}
