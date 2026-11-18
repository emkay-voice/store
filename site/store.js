// Emkay's skill store: browse, search and filter the skills in data/skills.json
// (tools/build.py), in the visitor's language, and hand one to Emkay to install.
//
// The front page is a shop window: featured skills as big cards (new and
// updated ones, then the skill of the week; tools/build.py picks them, only
// among skills that work in Emkay), then one shelf per category. A search or a category turns it
// into a grid of the skills that match.
//
// Install: the store is another site than Emkay (store.emkay.ai, app.emkay.ai),
// so it cannot reach the user's Emkay itself. "Get" opens
// app.emkay.ai/?install=<package> in this browser - where the user's Emkay
// lives - and Emkay opens its control panel at that package, where the
// panel's own Install button (and its own "are you sure?") does the rest.
// If Emkay already runs in another tab, that tab gets it (app.js asks its
// own tabs first). Shown inside Emkay (menu → Skill store: a frame with
// ?in=emkay), "Get" posts the package to that Emkay instead.

const APP = "https://app.emkay.ai/";
const IN_EMKAY = window.parent !== window && new URLSearchParams(location.search).get("in") === "emkay";

// inside Emkay: "Get" goes to the Emkay around this frame, not a new tab
if (IN_EMKAY) {
  document.addEventListener("click", (e) => {
    const get = e.target.closest("[data-get]");
    if (!get) return;
    e.preventDefault();
    const pkg = new URL(get.href).searchParams.get("install");
    window.parent.postMessage({ emkayInstall: pkg }, new URL(APP).origin);
  }, true);
  // the header's "Open Emkay" becomes "Back to Emkay": it closes the store
  // frame instead of opening a second Emkay
  const back = document.querySelector(".open-emkay");
  back.dataset.t = "back_to_emkay";
  back.addEventListener("click", (e) => {
    e.preventDefault();
    window.parent.postMessage({ emkayClose: true }, new URL(APP).origin);
  });
}
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

const [skills, texts, build] = await Promise.all(
  ["data/skills.json", "texts.json", "build.json"].map((u) => fetch(u, { cache: "no-cache" }).then((r) => r.json())));
const byPackage = Object.fromEntries(skills.map((s) => [s.package, s]));

// ------------------------------------------------------------ language
/** The visitor's language among the store's: saved choice, else the browser's. */
function pickLang() {
  const asked = new URLSearchParams(location.search).get("lang")?.toLowerCase();   // Emkay's language, from Emkay
  if (asked && texts[asked]) return asked;
  const saved = localStorage.getItem("emkay-store-lang");
  if (saved && texts[saved]) return saved;
  for (const want of navigator.languages || [navigator.language]) {
    const w = want.toLowerCase();
    const exact = build.langs.find((l) => l === w);
    const base = build.langs.find((l) => l.split("-")[0] === w.split("-")[0]);
    if (exact || base) return exact || base;
  }
  return "en-us";
}
let lang = pickLang();
const t = (key, vars = {}) => (texts[lang]?.[key] ?? texts["en-us"]?.[key] ?? key)
  .replace(/\{(\w+)\}/g, (_, k) => vars[k] ?? "");

// ------------------------------------------------------------ sideways rows
/** A row that scrolls sideways (featured, categories) gets ‹ › buttons and a
 *  fade at each edge with more behind it: its scrollbar is hidden, and a mouse
 *  wheel does not scroll sideways, so without them a desktop visitor neither
 *  sees there is more nor can get to it. On touch screens the buttons hide and
 *  the row is swiped. Safe to call again after the row is re-rendered. */
function sideways(row) {
  let wrap = row.parentElement;
  if (!wrap.classList.contains("sideways")) {
    wrap = document.createElement("div");
    wrap.className = "sideways";
    row.before(wrap);
    wrap.append(row);
    for (const dir of [-1, 1]) {
      const b = document.createElement("button");
      b.type = "button";
      b.className = `nudge ${dir < 0 ? "prev" : "next"}`;
      b.dataset.tAria = dir < 0 ? "scroll.prev" : "scroll.next";
      b.setAttribute("aria-label", t(b.dataset.tAria));
      b.textContent = dir < 0 ? "‹" : "›";
      // most of a row's width, so the next cards or chips come into view; the
      // featured row's scroll snap then lines a card up at the start
      b.onclick = () => row.scrollBy({ left: dir * row.clientWidth * 0.8, behavior: "smooth" });
      wrap.append(b);
    }
  }
  const update = () => {
    const max = row.scrollWidth - row.clientWidth;
    wrap.classList.toggle("more-left", row.scrollLeft > 2);
    wrap.classList.toggle("more-right", row.scrollLeft < max - 2);
  };
  row.onscroll = update;
  if (!row.dataset.sideways) {   // the categories row is the same element on every render
    row.dataset.sideways = "1";
    new ResizeObserver(update).observe(row);
  }
  update();
}

/** A skill's name, description and examples in the visitor's language, else English. */
const local = (s) => s.texts[lang] || s.texts["en-us"];
const speaksMine = (s) => s.languages.includes(lang) || !!s.texts[lang];

function applyTexts() {
  document.documentElement.lang = lang;
  document.title = t("title");
  for (const el of document.querySelectorAll("[data-t]")) el.textContent = t(el.dataset.t);
  for (const el of document.querySelectorAll("[data-t-placeholder]")) el.placeholder = t(el.dataset.tPlaceholder);
  for (const el of document.querySelectorAll("[data-t-aria]")) el.setAttribute("aria-label", t(el.dataset.tAria));
  $("built").textContent = new Date(build.built).toLocaleDateString(lang);
}

const sel = $("lang");
sel.innerHTML = build.langs.map((l) => `<option value="${l}">${esc(texts[l]?.["lang.name"] || l)}</option>`).join("");
sel.value = lang;
sel.onchange = () => { lang = sel.value; localStorage.setItem("emkay-store-lang", lang); applyTexts(); render(); };

// ------------------------------------------------------------ filters
const params = new URLSearchParams(location.search);
const state = { q: params.get("q") || "", cat: params.get("category") || "", mylang: false };
$("q").value = state.q;
$("q").oninput = () => { state.q = $("q").value; render(); };
$("mylang").onchange = () => { state.mylang = $("mylang").checked; render(); };

const visible = () => skills.filter((s) => !state.mylang || speaksMine(s));

function matches(s) {
  if (state.cat && s.category !== state.cat) return false;
  if (!state.q) return true;
  const q = state.q.toLowerCase();
  const tx = local(s);
  return [tx.name, tx.description, s.package, s.author, ...(tx.examples || [])]
    .some((x) => (x || "").toLowerCase().includes(q));
}

function renderCats(list) {
  const counts = {};
  for (const s of list) counts[s.category] = (counts[s.category] || 0) + 1;
  const cats = build.categories.filter((c) => counts[c]);
  const btn = (c, label, n) => `<button type="button" data-cat="${c}" aria-pressed="${state.cat === c}">${esc(label)}<span class="n">${n}</span></button>`;
  $("cats").innerHTML = btn("", t("all"), list.length) + cats.map((c) => btn(c, t(`category.${c}`), counts[c])).join("");
  for (const b of $("cats").querySelectorAll("button")) b.onclick = () => showCategory(b.dataset.cat);
  sideways($("cats"));
}

function showCategory(cat) {
  state.cat = cat;
  render();
  scrollTo({ top: 0, behavior: "smooth" });
}

// ------------------------------------------------------------ pieces
/** The skill's icon on a light tile (as an app icon), or its initial on its
 * category's colour when it has none. */
function icon(s, big = false) {
  const tx = local(s);
  const letter = esc((tx.name || s.package)[0]?.toUpperCase() || "•");
  const cls = `icon cat-${s.category}${big ? " big" : ""}`;
  return s.icon
    ? `<div class="${cls} img"><img src="${esc(s.icon)}" alt="" loading="lazy" data-letter="${letter}"></div>`
    : `<div class="${cls}">${letter}</div>`;
}
/** A broken icon link turns into the initial (no inline handlers: CSP-friendly). */
addEventListener("error", (e) => {
  const img = e.target;
  if (img.tagName === "IMG" && img.dataset.letter) {
    const tile = img.parentElement;
    tile.classList.remove("img");
    tile.textContent = img.dataset.letter;
  }
}, true);

function badge(s) {
  return `<span class="tag ${s.status}">${esc(t(`status.${s.status}`))}</span>`;
}
function tags(s) {
  const out = [badge(s)];
  if (!speaksMine(s)) out.push(`<span class="tag lang-miss">${esc(t("not_in_lang"))}</span>`);
  if (s.api_key) out.push(`<span class="tag">${esc(t("api_key"))}</span>`);
  return out.join("");
}

/** The "Get" button as in an app store: a pill; included skills say so. */
function getButton(s) {
  if (s.status === "builtin") return `<span class="pill done">${esc(t("included"))}</span>`;
  return `<a class="pill" href="${APP}?install=${encodeURIComponent(s.package)}" data-get>${esc(t("get"))}</a>`;
}

function card(s) {
  const tx = local(s);
  const say = (tx.examples || [])[0];
  return `<article class="card" data-p="${esc(s.package)}" tabindex="0">
    <div class="head">${icon(s)}<div class="title"><h3>${esc(tx.name)}</h3>
      <div class="by">${esc(t(`category.${s.category}`))}</div></div>${getButton(s)}</div>
    <p>${esc(tx.description)}</p>
    ${say ? `<div class="say">“${esc(say)}”</div>` : ""}
    <div class="tags">${tags(s)}</div></article>`;
}

/** A small row entry for a shelf (icon, name, one line, Get). */
function tile(s) {
  const tx = local(s);
  return `<article class="tile" data-p="${esc(s.package)}" tabindex="0">${icon(s)}
    <div class="title"><h3>${esc(tx.name)}</h3><div class="by">${esc(tx.description || "")}</div></div>
    ${getButton(s)}</article>`;
}

function hero(f) {
  const s = byPackage[f.package];
  const tx = local(s);
  const say = (tx.examples || [])[0];
  return `<article class="hero" data-p="${esc(s.package)}" tabindex="0"
      style="background:linear-gradient(135deg, ${esc(f.colors[0])}, ${esc(f.colors[1])})">
    <div class="kicker">${esc(f.kind === "pinned" ? t(`category.${s.category}`) : t(`featured.${f.kind}`))}</div>
    <h2>${esc(tx.name)}</h2>
    <p>${esc(tx.description)}</p>
    ${say ? `<div class="say">“${esc(say)}”</div>` : ""}
    <div class="hero-foot">${icon(s, true)}${getButton(s)}</div></article>`;
}

/** "See the code / make your own": the skill's GitHub repository in VS Code
 * for the Web, which offers to fork it on the first save – how newcomers learn
 * from real skills (emkay-voice/store#2). Only for skills whose source is on GitHub. */
function codeLink(s) {
  const m = (s.source || "").match(/^https:\/\/github\.com\/([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?$/);
  if (!m) return "";
  return `<p><a class="code-btn" href="https://vscode.dev/github/${esc(m[1])}/${esc(m[2])}" target="_blank" rel="noopener">${esc(t("code.own"))}</a></p>
    <p class="hint">${esc(t("code.own.hint"))}</p>`;
}

// ------------------------------------------------------------ pages
function render() {
  const list = visible();
  renderCats(list);
  const front = !state.q && !state.cat;
  $("front").hidden = !front;
  $("grid").hidden = front;
  $("count").textContent = front ? "" : t("count", { n: list.filter(matches).length });
  if (front) {
    const feat = (build.featured || []).filter((f) => byPackage[f.package] && list.includes(byPackage[f.package]));
    const shelves = build.categories.map((c) => [c, list.filter((s) => s.category === c)]).filter(([, l]) => l.length);
    $("front").innerHTML =
      (feat.length ? `<h2 class="shelf-title">${esc(t("featured"))}</h2><div class="heroes">${feat.map(hero).join("")}</div>` : "")
      + shelves.map(([c, l]) => `<div class="shelf">
          <div class="shelf-head"><h2 class="shelf-title">${esc(t(`category.${c}`))}</h2>
            <button class="link" data-cat="${c}">${esc(t("see_all"))}</button></div>
          <div class="tiles">${l.slice(0, 9).map(tile).join("")}</div></div>`).join("");
    for (const b of $("front").querySelectorAll("[data-cat]")) b.onclick = () => showCategory(b.dataset.cat);
    const heroes = $("front").querySelector(".heroes");
    if (heroes) sideways(heroes);
  } else {
    const shown = list.filter(matches);
    $("grid").innerHTML = shown.length ? shown.map(card).join("") : `<div class="empty">${esc(t("empty"))}</div>`;
  }
  for (const el of document.querySelectorAll("[data-p]")) {
    const open = (e) => { if (!e.target.closest("[data-get]")) openDetail(byPackage[el.dataset.p]); };
    el.onclick = open;
    el.onkeydown = (e) => { if (e.key === "Enter") open(e); };
  }
  const url = new URL(location);
  state.q ? url.searchParams.set("q", state.q) : url.searchParams.delete("q");
  state.cat ? url.searchParams.set("category", state.cat) : url.searchParams.delete("category");
  history.replaceState(null, "", url);
}

// ------------------------------------------------------------ detail
function openDetail(s) {
  const tx = local(s);
  const examples = (tx.examples || []).map((e) => `<li>${esc(e)}</li>`).join("");
  let names;   // language names in the visitor's language (Intl), else the code
  try { names = new Intl.DisplayNames([lang], { type: "language" }); } catch { names = null; }
  const langs = s.languages.map((l) => {
    try { return names?.of(l.replace(/-(\w+)$/, (_, r) => "-" + r.toUpperCase())) || l; } catch { return l; }
  }).join(", ");
  $("detail-body").innerHTML = `
    <div class="dhead">${icon(s, true)}
      <div><h2>${esc(tx.name)}</h2><div class="by">${esc(s.author || "")} · ${esc(t(`category.${s.category}`))}</div>
        <div class="dget">${getButton(s)}</div></div></div>
    <div class="tags">${tags(s)}${s.official ? `<span class="tag">${esc(t("official"))}</span>` : ""}</div>
    <p class="desc">${esc(tx.description)}</p>
    ${s.note ? `<p class="note">${esc(t(s.note))}</p>` : ""}
    ${examples ? `<h4>${esc(t("examples"))}</h4><ul class="say">${examples}</ul>` : ""}
    ${langs ? `<h4>${esc(t("languages"))}</h4><p class="meta">${esc(langs)}</p>` : ""}
    <p class="meta">${esc(s.package)} ${esc(s.version || "")}${s.license ? ` · ${esc(s.license)}` : ""}${s.updated ? ` · ${esc(s.updated)}` : ""}
      ${s.source ? ` · <a href="${esc(s.source)}" target="_blank" rel="noopener">${esc(t("source"))}</a>` : ""}</p>
    ${codeLink(s)}
    ${s.status !== "builtin" ? `<p class="hint">${esc(t("install.hint"))}</p>` : ""}`;
  $("detail").showModal();
  const url = new URL(location);
  url.searchParams.set("skill", s.package);
  history.replaceState(null, "", url);
}
$("detail").addEventListener("click", (e) => { if (e.target === $("detail")) $("detail").close(); });
$("detail").addEventListener("close", () => {
  const url = new URL(location);
  url.searchParams.delete("skill");
  history.replaceState(null, "", url);
});

applyTexts();
render();
const deep = params.get("skill");   // store.emkay.ai/?skill=<package> opens one
if (deep && byPackage[deep]) openDetail(byPackage[deep]);
