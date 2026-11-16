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
import { readFileSync, rmSync, writeFileSync } from "fs";

const candidates = JSON.parse(readFileSync(process.argv[2], "utf8"));
const app = process.argv[3] || "https://app.emkay.ai/";
const COMPAT = new URL("../data/compat.json", import.meta.url);
const WHEELS = new URL("../data/wheels.json", import.meta.url);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const t0 = Date.now();
const log = (m) => console.log(`[${((Date.now() - t0) / 1000).toFixed(0)}s] ${m}`);

/** One browser, one page, CDP helpers; worker console lines are kept. */
async function browser(name) {
  const port = 9400 + Math.floor(Math.random() * 400);
  // a profile left by an earlier run keeps its Emkay (its panel token, its
  // installed skills): every test starts from nothing, as a new user does
  rmSync(`/tmp/emkay-test-${name}`, { recursive: true, force: true });
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
  // as Emkay's own commands run (callPromising): what is started from here
  // may wait (JSPI), as speech does when a skill speaks
  const pyAsync = (code) => js(`window.emkay.call("python_async", {code: ${JSON.stringify(code)}}).catch((e) => "ERR " + e.message)`);
  const close = () => { ws.close(); chrome.kill(); };
  return { send, js, until, py, pyAsync, close, workerLog };
}

const SKILLS = "import json; from emkay_mobile import boot; json.dumps(sorted(boot._manager.plugin_skills))";
// every bus message from here on, for seeing who answered
const COLLECT = `import builtins
from emkay_mobile import boot
builtins._emkay_seen = []
boot.bus().on("message", lambda m: builtins._emkay_seen.append(m if isinstance(m, str) else m.serialize()))
"ok"`;
const answeredBy = (sid) => `import builtins, json
# its own speech or handler, or its answer to a pipeline that asked it (a
# common reading / common query / OCP provider answers with a ".response"
# message, and the pipeline speaks for it)
hits = [s for s in builtins._emkay_seen
        if ('"speak"' in s or 'skill.handler.start' in s or '.response"' in s) and ${JSON.stringify(sid)} in s]
builtins._emkay_seen.clear()
json.dumps(len(hits))`;

/** Known browser limits, said plainly ("ClientConnectorDNSError(ConnectionKey(host='x'..." is not). */
function plain(reason) {
  const host = reason.match(/host='([^']+)'/)?.[1];
  if (/ClientConnector|aiohttp|socket\.gaierror|OSError: \[Errno 50\]|websocket/i.test(reason)) {
    return `it opens its own network connection${host ? ` (to ${host})` : ""}, which a browser does not allow`;
  }
  const blocked = reason.match(/NetworkError: .*Failed to load '([^']+)'/);
  if (blocked) {
    return `it reads ${new URL(blocked[1]).host}, which does not let a browser read it (CORS)`;
  }
  return reason.replace(/\(ConnectionKey\(.*$/, "").slice(0, 200);
}

/** Lines that say why a skill did not install or load. */
function why(lines, fallback) {
  // ovos-core's ovos.pip.install.failed message: pip's own output is in data.detail
  lines = lines.flatMap((l) => {
    try { const m = JSON.parse(l); return [m.data?.error, ...String(m.data?.detail ?? "").split("\n")]; }
    catch { return [l]; }
  }).filter(Boolean).filter((l) => !/^Using \d+ constraints/.test(l));
  const flat = lines.flatMap((l) => String(l).split("\n"))
    // OVOS' log prefix: "2026-11-15 21:58:29.974 - emkay - module:func:210 - ERROR - "
    .map((l) => l.replace(/^\S+ \S+ - \S+ - \S+ - [A-Z]+ - /, "").trim());
  // the exception itself says most ("ModuleNotFoundError: No module named 'x'")
  const hit = flat.filter((l) => /^[\w.]*(Error|Exception): /.test(l)).at(-1)
    || flat.filter((l) => /error|exception|failed|no matching distribution|requires/i.test(l)).at(-1);
  return (hit || fallback).replace(/\s+/g, " ").trim().slice(0, 200);
}

// ------------------------------------------------------------- plugins
// A plugin works if it does its job the way Emkay uses it: chosen in
// mycroft.conf like a user does in the panel, then used by Emkay's own code
// (speech.py), not called directly. One check per kind; a kind not listed
// here is not tested yet.

/** The plugin ids an installed package registers for `kind` (its entry points). */
const pluginIds = (pkg, kind) => `import json
from importlib.metadata import distribution
json.dumps([ep.name for ep in distribution(${JSON.stringify(pkg)}).entry_points if ep.group in ${JSON.stringify(GROUPS[kind])}])`;

/** The entry point groups of each kind (ovos-plugin-manager's PluginTypes, and the old names it still reads). */
const GROUPS = {
  tts: ["opm.tts", "mycroft.plugin.tts"], stt: ["opm.stt", "mycroft.plugin.stt"],
  translate: ["opm.lang.translate", "neon.plugin.lang.translate"],
  lang_detect: ["opm.lang.detect", "neon.plugin.lang.detect"],
  solver: ["opm.solver.question", "neon.plugin.solver"], pipeline: ["opm.pipeline"],
  media_provider: ["opm.media.provider"],
};

/** Choose `id` in the `language` section, as OVOS' translation and detection factories read it. */
const chooseLanguage = (key, id) => `from emkay_mobile import boot
from ovos_config import Configuration
boot.write_user_config({"language": {${JSON.stringify(key)}: ${JSON.stringify(id)}}})
Configuration.reload()
"ok"`;

/** Python's result through Emkay's own (callPromising) path, or {error}. */
async function run(b, code) {
  const out = await b.pyAsync(code);
  if (!String(out).startsWith("ERR ")) return { value: String(out) };
  const text = String(out).slice(4);
  // a JS network refusal says most; else the exception line of the traceback
  return { error: text.match(/NetworkError: .*/)?.[0] || why(text.split("\n"), text.slice(-200)) };
}

/** Choose `id` as the `kind` plugin, as the panel's voice settings do. */
const choose = (kind, id) => `from emkay_mobile import boot, speech
from ovos_config import Configuration
boot.write_user_config({${JSON.stringify(kind)}: {"module": ${JSON.stringify(id)}}})
Configuration.reload()
speech.reload()
"ok"`;

const CHECKS = {
  /** Speak a sentence; it works if Emkay made the audio with this plugin. */
  async tts(b, id) {
    await b.py(choose("tts", id));
    const mark = b.workerLog.length;
    await b.pyAsync(`from emkay_mobile import boot
from emkay_mobile.browser import hand_over
hand_over(lambda: boot.emit("speak", {"utterance": "Hello, this is a test of the voice.", "lang": "en-US"}))
"ok"`);
    for (let i = 0; i < 60; i++) {
      await sleep(2000);
      const lines = b.workerLog.slice(mark);
      const failed = lines.find((l) => /\[emkay\] tts failed/.test(l));
      if (failed) return { ok: false, reason: why([failed.replace(/^.*tts failed \(/, "").replace(/\); using the fallback.*$/, "")], failed) };
      const done = lines.map((l) => l.match(/\[emkay\] tts ([\d.]+)s for ([\d.]+)s of audio/)).find(Boolean);
      if (done) {
        return Number(done[2]) >= 0.5 ? { ok: true, note: `${done[2]} s of speech in ${done[1]} s` }
          : { ok: false, reason: `made only ${done[2]} s of audio` };
      }
    }
    return { ok: false, reason: "no speech after 2 minutes" };
  },
  /** Transcribe a known recording ("what time is it") through Emkay's own
   *  path for recorded speech (worker_main.heard). */
  async stt(b, id) {
    await b.py(choose("stt", id));
    const text = await b.js(`(async () => {
      const r = await fetch("${TEST_WAV}");
      const wav = new Uint8Array(await r.arrayBuffer());
      const view = new DataView(wav.buffer);
      let off = 12, rate = 16000, data = null;
      while (off + 8 <= wav.length) {             // the WAV's chunks: fmt and data
        const id = String.fromCharCode(...wav.slice(off, off + 4)), size = view.getUint32(off + 4, true);
        if (id === "fmt ") rate = view.getUint32(off + 12, true);
        if (id === "data") { data = wav.slice(off + 8, off + 8 + size); break; }
        off += 8 + size + (size % 2);
      }
      return String(await Promise.race([
        window.emkay.call("heard", { pcm: data.buffer, rate }, [data.buffer]),
        new Promise((res) => setTimeout(() => res("TIMEOUT"), 240000))]));
    })()`);
    if (text === "TIMEOUT") return { ok: false, reason: "no transcription after 4 minutes" };
    if (/time/i.test(text || "")) return { ok: true, note: `heard "${text}"` };
    return { ok: false, reason: text ? `heard "${String(text).slice(0, 80)}" for "what time is it"`
      : `heard nothing: ${why(b.workerLog.slice(-40), "no text")}` };
  },
};
Object.assign(CHECKS, {
  /** "good morning" from English to Danish, through OVOS' translation factory. */
  async translate(b, id) {
    await b.py(chooseLanguage("translation_module", id));
    const r = await run(b, `from ovos_plugin_manager.language import OVOSLangTranslationFactory
OVOSLangTranslationFactory.create().translate("good morning", target="da", source="en")`);
    if (r.error) return { ok: false, reason: r.error };
    const text = r.value.trim();
    return text && text.toLowerCase() !== "good morning" ? { ok: true, note: `"good morning" -> "${text}"` }
      : { ok: false, reason: `"good morning" came back as "${text}"` };
  },
  /** An English and a Danish sentence, through OVOS' detection factory. */
  async lang_detect(b, id) {
    await b.py(chooseLanguage("detection_module", id));
    const r = await run(b, `import json
from ovos_plugin_manager.language import OVOSLangDetectionFactory
d = OVOSLangDetectionFactory.create()
json.dumps([d.detect("what time is it in London"), d.detect("hvad er klokken i København")])`);
    if (r.error) return { ok: false, reason: r.error };
    const [en, da] = JSON.parse(r.value).map((l) => String(l).toLowerCase());
    return en.startsWith("en") && da.startsWith("da") ? { ok: true, note: `en -> ${en}, da -> ${da}` }
      : { ok: false, reason: `detected ${en} for English and ${da} for Danish` };
  },
  /** "What is the capital of France?"; ovos-plugin-manager loads the solver,
   *  as a persona or common query skill does. */
  async solver(b, id) {
    const r = await run(b, `from ovos_plugin_manager.solvers import load_question_solver_plugin
load_question_solver_plugin(${JSON.stringify(id)})().spoken_answer("What is the capital of France?", lang="en") or ""`);
    if (r.error) return { ok: false, reason: r.error };
    return /paris/i.test(r.value) ? { ok: true, note: r.value.slice(0, 80) }
      : { ok: false, reason: r.value ? `answered "${r.value.slice(0, 80)}"` : "gave no answer" };
  },
  /** Emkay places a new pipeline plugin and has ovos-core load it right after
   *  the install (pipeline_place.py). It works if it is there, Emkay still
   *  answers "what time is it", and it matches one of its own examples. */
  async pipeline(b, id, c) {
    // Emkay places it when ovos-core reports the install done; give it a moment
    let st;
    for (let i = 0; i < 15; i++) {
      st = JSON.parse(await b.py(`import json
from emkay_mobile import boot
from ovos_config import Configuration
json.dumps({"placed": [p for p in Configuration()["intents"]["pipeline"] if p == ${JSON.stringify(id)} or p.startswith(${JSON.stringify(id + "-")})],
            "loaded": ${JSON.stringify(id)} in boot._manager.intents.pipeline_plugins})`));
      if (st.placed.length) break;
      await sleep(2000);
    }
    if (!st.placed.length) {
      log(`  placement: ${b.workerLog.filter((l) => /pipeline_place|pipeline: placed|pipelines_seen/.test(l)).slice(-5).join(" | ").slice(0, 600) || "nothing logged"}`);
    }
    if (!st.loaded) return { ok: false, reason: `installs, but ovos-core did not load it: ${why(b.workerLog.slice(-40), "no error logged")}` };
    if (!st.placed.length) return { ok: false, reason: "loads, but has no stage Emkay could place in the pipeline" };
    let mark = b.workerLog.length;
    await b.js(`window.emkay.call("say", {text: "what time is it"}); true`);
    await sleep(15000);
    if (!b.workerLog.slice(mark).some((l) => /date-time.*what_t|time.*skill.*match|\bmatch\b.*time/i.test(l))) {
      return { ok: false, reason: `with ${st.placed.join(", ")} in the pipeline, "what time is it" is not answered` };
    }
    const examples = c.examples.length ? c.examples : registeredExamples(b, id);
    for (const ex of examples) {
      mark = b.workerLog.length;
      await b.js(`window.emkay.call("say", {text: ${JSON.stringify(ex)}}); true`);
      await sleep(15000);
      if (b.workerLog.slice(mark).some((l) => l.includes(`${id}`) && /\bmatch\b/.test(l))) {
        return { ok: true, note: `placed as ${st.placed.join(", ")}; matched "${ex}"` };
      }
    }
    return { ok: null, reason: `placed as ${st.placed.join(", ")} and Emkay still answers, ` +
      (examples.length ? "but it matched none of its own examples" : "but it has no examples to try") };
  },
  /** OCP's MediaProviders: Emkay loads a new one into the running OCP right
   *  after the install (pipeline_place.reload_media_providers). It works if
   *  OCP has it and OCP's own provider search finds something playable for
   *  one of a few everyday words (its examples first, if it has any). */
  async media_provider(b, id, c) {
    const words = [...(c.examples || []).map((e) => e.replace(/^play\s+/i, "")), "news", "jazz", "radio", "music"];
    const r = await run(b, `import json
from emkay_mobile import boot
from ovos_utils.ocp import MediaType
ocp = next((p for p in boot._manager.intents.pipeline_plugins.values() if hasattr(p, "media_providers")), None)
out = {"loaded": bool(ocp) and ${JSON.stringify(id)} in ocp.media_providers, "found": None}
if out["loaded"]:
    for word in ${JSON.stringify(words)}:
        hits = [h for h in ocp._search_providers(word, MediaType.GENERIC, "en-us")
                if str(h.get("skill_id", "")).startswith(${JSON.stringify(id)}) and h.get("uri")]
        if hits:
            out["found"] = {"word": word, "count": len(hits), "title": hits[0].get("title"), "uri": hits[0]["uri"]}
            break
json.dumps(out)`);
    if (r.error) return { ok: false, reason: r.error };
    const st = JSON.parse(r.value);
    if (!st.loaded) return { ok: false, reason: `OCP did not load it: ${why(b.workerLog.slice(-40), "not among OCP's media providers")}` };
    if (!st.found) {
      const err = why(b.workerLog.slice(-60).filter((l) => /media_provider|Traceback|Error/.test(l)), "");
      return err ? { ok: false, reason: err } : { ok: null, reason: "found nothing for news, jazz, radio or music (may need to be set up)" };
    }
    const f = st.found;
    return { ok: true, note: `"${f.word}": ${f.count} results, e.g. ${String(f.title).slice(0, 40)} (${String(f.uri).split(":")[0]})` };
  },
});

/** The example phrases a plugin or skill registered itself (OVOS logs them:
 *  "<id>.<author> - INFO - Registering example utterances ... - ['...', ...]"),
 *  for when klondike has none. */
function registeredExamples(b, id) {
  const line = b.workerLog.find((l) => l.includes(id) && l.includes("Registering example utterances"));
  const list = line?.match(/\[(.*)\]\s*$/)?.[1];
  if (!list) return [];
  return [...list.matchAll(/'((?:[^'\\]|\\.)*)'|"((?:[^"\\]|\\.)*)"/g)].map((m) => m[1] ?? m[2]).slice(0, 3);
}

const TEST_WAV = "https://raw.githubusercontent.com/emkay-voice/emkay/main/tools/probes/audio/what_time.wav";

/** Check one installed plugin package; returns {status, reason}. */
async function checkPlugin(b, c, pkg) {
  const ids = JSON.parse(await b.py(pluginIds(pkg, c.kind)) || "[]");
  if (!ids.length) return { status: "broken", reason: `installs, but registers no ${c.kind} plugin` };
  log(`  ${c.kind} plugin ${ids[0]}`);
  if (c.api_key) return { status: "untested", reason: "installs; needs an API key to try" };
  const r = await CHECKS[c.kind](b, ids[0], c);
  log(`  ${r.ok ? "passed" : r.ok === null ? "not decided" : "failed"}: ${r.note || r.reason}`);
  if (r.ok) return { status: "works", reason: "", note: r.note };
  if (r.ok === null) return { status: "untested", reason: r.reason };
  // a plugin that wants a server address or a key first is not broken: it
  // needs setting up, which a test cannot do for the user
  if (/missing from .*config|not configured|no (api[ _-]?)?key|api[ _-]?key|requires? (an? )?(url|host|server)/i.test(r.reason)) {
    return { status: "untested", reason: `needs to be set up first: ${plain(r.reason)}` };
  }
  return { status: "broken", reason: `does not work here: ${plain(r.reason)}` };
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
      try { return JSON.parse(r.body); } catch { return { raw: String(r?.body ?? r).slice(-1500) }; }
    };
    await api("POST", "/api/auth/token", { new: "emkay-skill-test" });
    const before = JSON.parse(await b.py(SKILLS));

    // PyPI's normalized form: the panel takes no underscores (ovos_tts_plugin_marytts)
    const pkgName = c.package.toLowerCase().replace(/[-_.]+/g, "-");
    await b.py(COLLECT);   // the bus from here on: ovos-core's failure message has pip's own output
    const job = await api("POST", "/api/plugins/install", { package: pkgName });
    let state = job;
    let panel = true;
    let note = "";
    if (/plain OVOS package name/.test(job.detail || "")) {
      note = "the settings panel only installs packages named ovos-*";
    } else if (/does not have a package|PyPI does not have/.test(job.detail || "")) {
      // the store's own index leaves out what was found broken, so a retest
      // (a fix released upstream) cannot go through the panel
      note = "not in the store's package index (it was broken before)";
    } else if (/not one of the OVOS plugin families/.test(job.detail || "")) {
      // a family the panel does not know yet (ovos_webui pypi.FAMILIES),
      // e.g. ovos-media-provider-* until OpenVoiceOS/ovos-control-panel#104
      note = "the settings panel does not install this kind of plugin yet";
    } else if (!job.id) {
      // the panel itself failed (not pip): try the package anyway, and say so
      note = `the settings panel failed: ${String(job.detail || job.raw || "no answer").split("\n").pop().slice(0, 120)}`;
    }
    if (note) {
      // ask ovos-core's installer on the bus, as the panel itself does, so
      // the package is still tried
      panel = false;
      log("  the panel refuses the name; installing through ovos-core's installer");
      await b.py(`from emkay_mobile import boot
from emkay_mobile.browser import hand_over
from ovos_bus_client.message import Message
hand_over(lambda: boot.bus().emit(Message("ovos.pip.install", {"packages": [${JSON.stringify(pkgName)}]})))
"ok"`);
      state = { state: "running" };
      for (let i = 0; i < 120 && state.state === "running"; i++) {
        await sleep(5000);
        state = JSON.parse(await b.py(`import builtins, json
done = [s for s in builtins._emkay_seen if '"ovos.pip.install.complete"' in s or '"ovos.pip.install.failed"' in s]
json.dumps({"state": ("done" if "complete" in done[-1] else "failed") if done else "running", "lines": done[-1:]})`));
      }
    } else {
      // the panel's install job: wait for pip to finish
      for (let i = 0; i < 120 && job.id && !["done", "failed", "error"].includes(state.state); i++) {
        await sleep(5000);
        state = await api("GET", `/api/plugins/jobs/${job.id}`);
      }
    }
    const result = (r) => ({ ...r, reason: [r.reason, note].filter(Boolean).join("; "), panel });
    if (state.state !== "done" && panel) {
      // the panel's job says only "error in pip subprocess"; pip's output is
      // in ovos-core's ovos.pip.install.failed message
      const failed = await b.py(`import builtins
[s for s in builtins._emkay_seen if '"ovos.pip.install.failed"' in s][-1:] and [s for s in builtins._emkay_seen if '"ovos.pip.install.failed"' in s][-1] or ""`);
      if (failed) state.lines = [failed];
    }
    if (state.state !== "done") {
      return result({ status: "broken", reason: `does not install: ${why(state.lines || [], JSON.stringify(state).slice(0, 120))}` });
    }
    await sleep(8000);
    if (c.kind && c.kind !== "skill") return result(await checkPlugin(b, c, pkgName));
    const added = JSON.parse(await b.py(SKILLS)).filter((s) => !before.includes(s));
    if (!added.length) {
      return result({ status: "broken", reason: `installs, but does not load: ${why(b.workerLog.slice(-60), "no skill appeared")}` });
    }
    const sid = added[0];
    log(`  loaded as ${sid}`);
    if (!c.examples.length) return result({ status: "untested", reason: "loads; it has no examples to try" });

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
    if (answered) return result({ status: "works", reason: "" });
    return result({ status: "untested", reason: "loads, but did not answer its own examples here" });
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
  compat[c.package] = { ...result, kind: c.kind || "skill", version: c.version, tested: today };
  // a pure-Python package PyPI only has as source: tools/build_wheels.py
  // builds it at the next store build, and the skill is tried again then
  const sdistOnly = result.reason.match(/ERROR: (\S+) has no pure-Python wheel/)?.[1];
  if (sdistOnly) {
    const wheels = JSON.parse(readFileSync(WHEELS, "utf8"));
    if (!wheels.wanted.includes(sdistOnly) && !(sdistOnly in (wheels.not_pure || {}))) {
      wheels.wanted.push(sdistOnly);
      writeFileSync(WHEELS, JSON.stringify(wheels, null, 1) + "\n");
      log(`  ${sdistOnly}: wanted as a wheel (tools/build_wheels.py)`);
    }
  }
  writeFileSync(COMPAT, JSON.stringify(compat, null, 1) + "\n");   // after each, so a crash keeps the rest
}
