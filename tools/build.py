"""Build the Emkay skill store (store.emkay.ai) into site/.

Where the skills come from:
  * ovos-klondike-mercantile's skills.json: every OVOS skill, plugin and tool
    found on GitHub, cross-referenced with PyPI, the OVOS store and
    ovos-localize, with names, descriptions and example phrases in many
    languages. The store keeps the skills that can be installed (on PyPI).
  * Emkay's own build.json (app.emkay.ai): the skills that come with Emkay.
  * data/compat.json: what has been tried in Emkay - works, or does not and
    why. Later written by a test job (emkay-voice/emkay#21), for now by hand.
    What does not work is left out of the store.

Only skills klondike calls "Looks Complete" (tier 1) are taken.
  * data/categories.json: the store's categories, the words that place a
    skill in one, and per-package overrides.
  * data/featured.json: how the "Featured" row is picked (pick_featured).

What it writes:
  site/data/skills.json   one slim record per skill, texts per language
  site/texts.json         the store's own texts, from locale/<lang>/*.dialog
  site/build.json         when and from what the store was built

Usage:
  python3 tools/build.py [--klondike FILE_OR_URL] [--emkay FILE_OR_URL]
"""
import argparse
import json
import re
import sys
import time
import urllib.request
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

REPO = Path(__file__).resolve().parent.parent
SITE = REPO / "site"

KLONDIKE = "https://andlo.github.io/ovos-klondike-mercantile/skills.json"
EMKAY = "https://app.emkay.ai/build.json"

#: The languages Emkay supports (80 % or more on ovos-localize), as Emkay's
#: locale folders name them. The store speaks these.
LANGS = ["en-us", "da-dk", "de-de", "fr-fr", "it-it", "es-es", "gl-es", "ca-es",
         "eu-es", "pt-pt", "pt-br", "nl-nl"]


#: the store shelf for each plugin kind the test can try
PLUGIN_CATEGORIES = {"tts": "voices", "stt": "listening", "translate": "language",
                     "lang_detect": "language", "solver": "answers", "pipeline": "pipelines"}


def load(source: str):
    """JSON from a file or a URL."""
    if source.startswith(("http://", "https://")):
        req = urllib.request.Request(source, headers={"User-Agent": "emkay-store-build"})
        with urllib.request.urlopen(req, timeout=60) as r:  # noqa: S310 - https only
            return json.load(r)
    return json.loads(Path(source).read_text())


def norm(name: str) -> str:
    """A package name as pip compares them (PEP 503)."""
    return re.sub(r"[-_.]+", "-", name or "").lower()


def categorize(skill: dict, rules: dict) -> str:
    """The store category: an override, else the first rule whose words occur
    in the name, package, description or tags, else klondike's own category
    when it is one of ours, else "other"."""
    pkg = norm(skill.get("package_name"))
    if pkg in rules["overrides"]:
        return rules["overrides"][pkg]
    text = " ".join([skill.get("name") or "", skill.get("package_name") or "",
                     skill.get("description") or "", " ".join(skill.get("tags") or [])]).lower()
    for cat in rules["order"]:
        if any(re.search(rf"\b{re.escape(w)}", text) for w in rules["words"][cat]):
            return cat
    kc = (skill.get("category") or "").lower()
    return rules["klondike"].get(kc, "other")


def display_name(skill: dict, names: dict) -> str:
    """A name for people: the manifest's, unless it is just the package name;
    then data/categories.json "names", else the package name made readable
    ("ovos-skill-date-time" -> "Date Time")."""
    pkg = skill.get("package_name") or ""
    name = skill.get("name") or ""
    if name and norm(name) != norm(pkg):
        return name
    if norm(pkg) in names:
        return names[norm(pkg)]
    core = re.sub(r"^(ovos-skill-|neon-skill-|skill-ovos-|skill-)|(-skill)$", "", norm(pkg))
    return " ".join(w.upper() if len(w) <= 2 else w.capitalize() for w in core.replace("_", "-").split("-"))


def texts_for(skill: dict, names: dict, descriptions: dict) -> dict:
    """Name, description and examples per language; English from the main
    record, the others from klondike's locale_content where there is one."""
    out = {"en-us": {"name": display_name(skill, names),
                     "description": descriptions.get(norm(skill.get("package_name")))
                     or (skill.get("description") if norm(skill.get("description")) != norm(skill.get("package_name")) else "")
                     or "",
                     "examples": (skill.get("examples") or [])[:6]}}
    for lang, t in (skill.get("locale_content") or {}).items():
        lang = lang.lower()
        if lang in LANGS and lang != "en-us":
            out[lang] = {"name": t.get("name") or out["en-us"]["name"],
                         "description": t.get("description") or "",
                         "examples": (t.get("examples") or [])[:6]}
            if norm(out[lang]["name"]) == norm(skill.get("package_name")):
                out[lang]["name"] = out["en-us"]["name"]
            if norm(out[lang]["description"]) == norm(skill.get("package_name")):
                out[lang]["description"] = out["en-us"]["description"]
    return out


def pick_featured(skills: list, rules: dict, today=None) -> list:
    """The "Featured" row: only skills that work in Emkay. New and recently
    updated ones first (newest first, at most max_fresh), then pinned ones,
    last the skill of the week: one of the other working skills, changing
    with the ISO week, the same for everyone all week."""
    import datetime as dt
    today = today or dt.date.today()
    working = [s for s in skills if s["status"] in ("builtin", "works")]
    fresh = sorted((s for s in working if s["new"] or s["fresh"]),
                   key=lambda s: s["updated"], reverse=True)[: rules.get("max_fresh", 5)]
    out = [{"package": s["package"], "kind": "new" if s["new"] else "updated"} for s in fresh]
    for p in rules.get("pinned", []):
        if any(norm(s["package"]) == norm(p) for s in working) and p not in {o["package"] for o in out}:
            out.append({"package": p, "kind": "pinned"})
    pool = sorted(s["package"] for s in working if s["package"] not in {o["package"] for o in out})
    if pool:
        year, week, _ = today.isocalendar()
        out.append({"package": pool[(year * 53 + week) % len(pool)], "kind": "week"})
    colors = rules.get("colors", {})
    cat = {s["package"]: s["category"] for s in skills}
    for o in out:
        o["colors"] = colors.get(cat[o["package"]], colors.get("other", ["#283048", "#859398"]))
    return out


def locale_texts() -> dict:
    """The store's own texts: locale/<lang>/<key>.dialog, one text per file,
    as in an OVOS skill (and as Emkay's app does)."""
    out = {}
    for d in sorted((REPO / "locale").iterdir()):
        if d.is_dir():
            out[d.name] = {f.stem: f.read_text().strip() for f in sorted(d.glob("*.dialog"))}
    return out


def kind_of(s):
    """"skill", a plugin kind (candidates.PLUGIN_KINDS), or None."""
    from candidates import kind_of as k
    return k(s)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--klondike", default=KLONDIKE)
    ap.add_argument("--emkay", default=EMKAY)
    args = ap.parse_args()

    found = load(args.klondike)
    try:
        emkay = load(args.emkay)
    except Exception as e:  # the store still builds, without "built in"
        print(f"no Emkay build.json ({e}); no skill is marked built in", file=sys.stderr)
        emkay = {}
    builtin = {norm(v.split("==")[0]) for v in emkay.get("versions", [])}
    compat = {norm(k): v for k, v in json.loads((REPO / "data/compat.json").read_text()).items()
              if not k.startswith("_")}
    rules = json.loads((REPO / "data/categories.json").read_text())
    rules["overrides"] = {norm(k): v for k, v in rules.get("overrides", {}).items()}
    names = {norm(k): v for k, v in rules.get("names", {}).items()}
    descriptions = {norm(k): v for k, v in rules.get("descriptions", {}).items()}
    feat_rules = json.loads((REPO / "data/featured.json").read_text())

    skills, seen, hidden = [], set(), []
    for s in found:
        pkg = s.get("package_name")
        # only what klondike calls "Looks Complete" (tier 1: a manifest, on
        # PyPI, a release or in OVOS' own store), not archived
        # skills, and the plugin kinds the nightly test can try
        # (tools/candidates.py, PLUGIN_KINDS)
        kind = kind_of(s)
        if not kind or s.get("tier") != 1 or not s.get("on_pypi") or not pkg or s.get("archived"):
            continue
        key = norm(pkg)
        if key in seen:      # the same package from a fork: keep the first (klondike ranks them)
            continue
        seen.add(key)
        c = compat.get(key, {})
        # broken wins: Emkay's bundle also holds a skill it switches off
        # (ovos-skill-boot-finished)
        status = c.get("status") if c.get("status") == "broken" else \
            "builtin" if key in builtin else c.get("status", "untested")
        if status == "broken":   # tried and does not work here: not offered at all
            hidden.append(pkg)
            continue
        skills.append({
            "package": pkg,
            "id": s.get("id"),
            "kind": kind,
            "category": categorize(s, rules) if kind == "skill" else PLUGIN_CATEGORIES[kind],
            "status": status,
            "reason": c.get("reason", ""),
            "texts": texts_for(s, names, descriptions),
            "languages": sorted({l.lower() for l in s.get("languages") or []}),
            "icon": s.get("icon") if (s.get("icon") or "").startswith("https://") else None,
            "author": s.get("author"),
            "source": s.get("source"),
            "version": s.get("pypi_version"),
            "license": s.get("license"),
            "api_key": bool(s.get("requires_api_key")),
            "official": bool(s.get("in_ovos_store")),
            "stars": s.get("stars") or 0,
            "updated": (s.get("last_updated") or "")[:10],
            "new": bool(s.get("is_new_repo")),
            "fresh": bool(s.get("is_recently_updated")),
        })
    rank = {"builtin": 0, "works": 1, "untested": 2, "broken": 3}
    skills.sort(key=lambda x: (rank.get(x["status"], 2), -x["stars"], x["package"]))

    (SITE / "data").mkdir(parents=True, exist_ok=True)
    (SITE / "data/skills.json").write_text(json.dumps(skills, ensure_ascii=False, separators=(",", ":")))
    (SITE / "texts.json").write_text(json.dumps(locale_texts(), ensure_ascii=False))
    (SITE / "build.json").write_text(json.dumps({
        "built": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "skills": len(skills),
        "categories": rules["order"] + ["other"] + list(dict.fromkeys(PLUGIN_CATEGORIES.values())),
        "langs": LANGS,
        "featured": pick_featured([x for x in skills if x["kind"] == "skill"], feat_rules),
        "emkay": {k: emkay.get(k) for k in ("version", "build", "commit")},
    }, indent=1))
    index = write_package_index(
        [x["package"] for x in skills if x["status"] in ("builtin", "works")]
        + [v.split("==")[0] for v in emkay.get("versions", [])],
        untested=[x["package"] for x in skills if x["status"] == "untested"])
    print(f"package index for the control panel: {index} packages")
    by = {}
    for s in skills:
        by[s["category"]] = by.get(s["category"], 0) + 1
    print(f"{len(skills)} skills: " + ", ".join(f"{k} {v}" for k, v in sorted(by.items()))
          + f"; built in {sum(s['status'] == 'builtin' for s in skills)}"
          + f"; left out (does not work in a browser): {', '.join(hidden) or 'none'}")



#: put before an untested package's summary in the index, so the panel
#: shows it next to the package
UNTESTED_NOTE = "[Not tested in Emkay yet] "


def write_package_index(packages, untested=()) -> int:
    """A package index for Emkay's control panel (emkay-voice/emkay#21).

    The panel searches a package index (`webui.pypi_index`, ovos_webui's
    pypi.py): `<base>/simple/` for the names and `<base>/pypi/<name>/json`
    for the details. Emkay points it here, so the panel's search, the setup
    wizard and the recommendations offer only what Emkay ships or what the
    nightly test found working, not all of PyPI. The packages themselves
    still come from PyPI: the JSON is PyPI's own, with its file URLs.
    Untested packages are listed too, marked (UNTESTED_NOTE in their
    summary): the panel installs only what its index has, so without them
    neither the store's "Get" nor the nightly test could install them.
    Broken ones are not listed. Only names the panel can install (ovos-*)
    are listed; it would refuse the others anyway.
    """
    marked = {norm(p) for p in untested}
    names = sorted({norm(p) for p in [*packages, *untested] if norm(p).startswith("ovos-")})
    kept = []
    for name in names:
        try:
            data = load(f"https://pypi.org/pypi/{name}/json")
        except Exception as e:  # not on PyPI (any more): not offered
            print(f"  {name}: no PyPI entry ({e})", file=sys.stderr)
            continue
        if name in marked and name not in {norm(p) for p in packages}:
            info = data.setdefault("info", {})
            info["summary"] = UNTESTED_NOTE + (info.get("summary") or "")
        d = SITE / "pypi" / name
        d.mkdir(parents=True, exist_ok=True)
        (d / "json").write_text(json.dumps(data, separators=(",", ":")))
        files = data.get("urls") or []
        links = "\n".join(f'<a href="{f["url"]}#sha256={f["digests"]["sha256"]}">{f["filename"]}</a><br>'
                          for f in files)
        (SITE / "simple" / name).mkdir(parents=True, exist_ok=True)
        (SITE / "simple" / name / "index.html").write_text(
            f"<!DOCTYPE html><html><body>\n{links}\n</body></html>\n")
        kept.append(name)
    (SITE / "simple" / "index.html").write_text(
        "<!DOCTYPE html><html><body>\n"
        + "\n".join(f'<a href="/simple/{n}/">{n}</a>' for n in kept)
        + "\n</body></html>\n")
    return len(kept)


if __name__ == "__main__":
    main()
