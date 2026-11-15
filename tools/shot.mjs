// Screenshot a page in headless Chromium: node tools/shot.mjs URL OUT.png [WIDTHxHEIGHT] [JS-to-run-first]
import { spawn } from "child_process";
import { writeFileSync } from "fs";

const [url, out, size = "390x844", pre = ""] = process.argv.slice(2);
const [w, h] = size.split("x").map(Number);
const port = 9351;
const chrome = spawn(process.env.CHROME, ["--headless=new", `--remote-debugging-port=${port}`,
  "--user-data-dir=/tmp/emkay-store-shot", "--hide-scrollbars", `--lang=${process.env.LANG_TAG || "en-US"}`, "about:blank"], { stdio: "ignore" });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let target;
for (let i = 0; i < 100 && !target; i++) {
  await sleep(200);
  try { target = (await (await fetch(`http://127.0.0.1:${port}/json`)).json()).find((t) => t.type === "page"); } catch {}
}
const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((r) => (ws.onopen = r));
let id = 0; const pending = new Map();
ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id) { pending.get(m.id)?.(m); pending.delete(m.id); } };
const send = (method, params = {}) => new Promise((r) => { const i = ++id; pending.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
await send("Emulation.setDeviceMetricsOverride", { width: w, height: h, deviceScaleFactor: 1, mobile: w < 700 });
await send("Page.navigate", { url });
await sleep(2500);
if (pre) { const r = await send("Runtime.evaluate", { expression: pre, awaitPromise: true, returnByValue: true }); console.log(JSON.stringify(r.result?.result?.value ?? r.result?.exceptionDetails?.text)); await sleep(800); }
const r = await send("Page.captureScreenshot", { format: "png" });
writeFileSync(out, Buffer.from(r.result.data, "base64"));
console.log("ok", out);
ws.close(); chrome.kill();
