#!/usr/bin/env python3
"""Wheels for pure-Python packages that PyPI only has as source.

Emkay's pip (OVOS in the browser) installs wheels only: there is no compiler
and no setup.py run in a browser. Some packages are pure Python but were only
ever published as a source distribution (nested-lookup, for one), so a skill
that needs them cannot be installed, although nothing in them needs
compiling.

This builds those wheels here, from the source distribution on PyPI, and
publishes them in site/wheels/ with an index Emkay's pip reads when PyPI has
no wheel for a release (emkay-voice/emkay, py/emkay_mobile/pip.py):

    site/wheels/index.json   {name: {version: [file entries as in PyPI's JSON]}}
    site/wheels/<file>.whl

What to build is data/wheels.json "wanted": requirements the nightly test
saw fail with "has no pure-Python wheel" (tools/test_skills.mjs adds them).
Only a build that comes out as a pure wheel (`none-any`) is published; one
that needs compiling stays out and is noted in "not_pure", so it is not
built every night for nothing. The package itself is still the one on PyPI,
built unchanged.

Usage: python tools/build_wheels.py
"""
import hashlib
import json
import subprocess
import sys
import tempfile
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
DATA = REPO / "data/wheels.json"
OUT = REPO / "site/wheels"
SITE_URL = "https://store.emkay.ai/wheels/"


def norm(name: str) -> str:
    import re
    return re.sub(r"[-_.]+", "-", name or "").lower()


def build(spec: str, tmp: Path):
    """The pure wheel built from `spec`'s newest matching sdist, or (None, why)."""
    src, whl = tmp / "src", tmp / "whl"
    for d in (src, whl):
        d.mkdir(parents=True, exist_ok=True)
    pip = [sys.executable, "-m", "pip", "-q", "--disable-pip-version-check"]
    r = subprocess.run(pip + ["download", "--no-deps", "--no-binary", ":all:", "-d", str(src), spec],
                       capture_output=True, text=True)
    if r.returncode:
        return None, f"no source to build: {r.stderr.strip().splitlines()[-1:]}"
    sdist = next(src.iterdir())
    r = subprocess.run(pip + ["wheel", "--no-deps", "-w", str(whl), str(sdist)], capture_output=True, text=True)
    if r.returncode:
        return None, f"does not build: {r.stderr.strip().splitlines()[-1:]}"
    wheel = next(whl.glob("*.whl"))
    if not wheel.name.endswith("-none-any.whl"):
        return None, f"builds, but not as pure Python ({wheel.name})"
    return wheel, ""


def main():
    data = json.loads(DATA.read_text())
    OUT.mkdir(parents=True, exist_ok=True)
    index = {}
    for spec in sorted(set(data.get("wanted", []))):
        if spec in data.get("not_pure", {}):
            continue
        with tempfile.TemporaryDirectory() as t:
            wheel, why = build(spec, Path(t))
            if wheel is None:
                print(f"  {spec}: {why}")
                data.setdefault("not_pure", {})[spec] = why
                continue
            (OUT / wheel.name).write_bytes(wheel.read_bytes())
        from packaging.utils import parse_wheel_filename
        name, version, _, _ = parse_wheel_filename(wheel.name)
        body = (OUT / wheel.name).read_bytes()
        index.setdefault(norm(name), {}).setdefault(str(version), []).append({
            "filename": wheel.name,
            "url": SITE_URL + wheel.name,
            "packagetype": "bdist_wheel",
            "digests": {"sha256": hashlib.sha256(body).hexdigest()},
            "size": len(body),
            "requires_python": None,
            "yanked": False,
            "built_by": "emkay-voice/store tools/build_wheels.py",
        })
        print(f"  {spec}: {wheel.name}")
    (OUT / "index.json").write_text(json.dumps(index, indent=1))
    DATA.write_text(json.dumps(data, indent=1) + "\n")
    print(f"{sum(len(v) for v in index.values())} wheels built")


if __name__ == "__main__":
    main()
