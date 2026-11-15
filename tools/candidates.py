#!/usr/bin/env python3
"""Pick the skills the nightly test (tools/test_skills.mjs) tries next.

The same skills the store lists (tools/build.py: klondike tier 1, on PyPI,
not archived), minus the ones Emkay ships, in this order:
  1. never tested
  2. tested on an older version than PyPI's
  3. tested longest ago, if more than RETEST_DAYS ago
Entries in data/compat.json without "tested" were written by hand (a
reason the test cannot see, such as CORS for a site the skill only reads
when asked); those are never retested.

Writes a JSON list of {package, version, skill_id, examples} to stdout.
Usage: python tools/candidates.py [--max N]
"""
import argparse
import datetime
import json
import sys

from build import EMKAY, KLONDIKE, REPO, load, norm

RETEST_DAYS = 30


def english_examples(s) -> list:
    """The skill's example utterances in English (what Emkay's test speaks)."""
    loc = (s.get("locale_content") or {}).get("en-us") or {}
    return [e for e in (loc.get("examples") or s.get("examples") or []) if isinstance(e, str)][:3]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--max", type=int, default=8)
    args = ap.parse_args()
    try:
        builtin = {norm(v.split("==")[0]) for v in load(EMKAY).get("versions", [])}
    except Exception as e:
        print(f"no Emkay build.json: {e}", file=sys.stderr)
        builtin = set()
    compat = {norm(k): v for k, v in json.loads((REPO / "data/compat.json").read_text()).items()
              if not k.startswith("_")}
    today = datetime.date.today()
    picks, seen = [], set()
    for s in load(KLONDIKE):
        pkg = s.get("package_name")
        if s.get("type_group") != "Skill" or s.get("tier") != 1 or not s.get("on_pypi") \
                or not pkg or s.get("archived"):
            continue
        key = norm(pkg)
        if key in seen or key in builtin:
            continue
        seen.add(key)
        c = compat.get(key)
        version = s.get("pypi_version") or ""
        if c is None:
            rank = (0, 0)
        elif "tested" not in c:
            continue                       # written by hand
        elif c.get("version") != version:
            rank = (1, 0)
        else:
            age = (today - datetime.date.fromisoformat(c["tested"])).days
            if age <= RETEST_DAYS:
                continue
            rank = (2, -age)
        picks.append((rank, -(s.get("stars") or 0), {
            "package": pkg, "version": version, "skill_id": s.get("skill_id") or "",
            "examples": english_examples(s)}))
    picks.sort(key=lambda p: (p[0], p[1]))
    out = [p[2] for p in picks[:args.max]]
    print(f"{len(picks)} skills want a test; trying {len(out)}", file=sys.stderr)
    print(json.dumps(out, indent=1))


if __name__ == "__main__":
    main()
