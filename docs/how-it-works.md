# How the store works, and how to make your own

This store answers one question for every OVOS skill (and soon plugin): *does
it work on this kind of device?* Here the device is
[Emkay](https://app.emkay.ai), OVOS in a browser, but nothing in the method is
tied to a browser. Fork it, point it at your device, and you have a store that
only offers what works there, plus a package index your control panel can
search.

Everything runs in GitHub Actions and is published as a static site on GitHub
Pages. There is no server and no database: the data is JSON files in this repo.

## The flow

```
klondike-mercantile ──► tools/candidates.py ──► tools/test_skills.mjs ──► data/compat.json
(what exists)            (what to test next)     (install + try in Emkay)   (the verdicts)
                                                                                 │
app.emkay.ai/build.json ─────────────────────────────────────────────────────────┤
(what Emkay ships)                                                               ▼
                                                                          tools/build.py
                                                                                 │
                                    ┌────────────────────────────────────────────┤
                                    ▼                                            ▼
                         site/ (the store pages)                site/simple/, site/pypi/
                         store.emkay.ai                         (a package index for the
                                                                 OVOS control panel)
```

1. **What exists.** [OVOS Klondike Mercantile](https://andlo.github.io/ovos-klondike-mercantile/)
   crawls GitHub for OVOS skills and plugins every night and publishes them in
   one `skills.json`, with names, descriptions and example phrases per
   language, PyPI version, licence and a *tier*. The store only looks at
   tier 1 (*Looks Complete*: a manifest, on PyPI, a release or in OVOS' own
   store), on PyPI and not archived.
2. **What to test next** (`tools/candidates.py`): never tested first, then a
   new PyPI version, then the ones tested longest ago (after 30 days).
   Packages the device already ships are skipped; so are verdicts written by
   hand (see *Overrides*).
3. **The test** (`tools/test_skills.mjs`, workflow
   [`test-skills.yml`](../.github/workflows/test-skills.yml), nightly). For each
   candidate it opens the live Emkay in headless Chrome with a fresh profile
   and does what a user does: opens the control panel, installs the package
   with the panel's Install button, and waits for pip. Then it checks that a
   new skill loaded, waits for the intents to train, and says the skill's own
   example phrases (from klondike, in English). The skill works if *it*
   answered (its `speak` or handler messages on the bus), not just anything.
4. **The verdicts** go into [`data/compat.json`](../data/compat.json), one entry
   per package, with the reason when something fails, taken from pip's or
   OVOS' own error ("No module named 'pwd'", "nested-lookup has no
   pure-Python wheel"). The job commits them and starts the store build.
5. **The build** (`tools/build.py`, workflow [`pages.yml`](../.github/workflows/pages.yml))
   joins klondike's data, the verdicts and what Emkay ships into the store
   pages and the package index.

## What a status means

| Status | Shown in the store | In the package index | Meaning |
|---|---|---|---|
| `builtin` | yes, "Comes with Emkay" | yes | Emkay ships it (from its `build.json`) |
| `works` | yes, "Works in Emkay" | yes | installed, loaded and answered one of its own examples |
| `untested` | yes, after the working ones, never featured | yes, marked "[Not tested in Emkay yet]" | not tried yet, or loads but could not be tried |
| `broken` | no | no | tried, and does not install or load here |

"Works" means it passed the test the way the device itself uses it, not just
that pip installed it.

## The package index for the control panel

The [OVOS control panel](https://github.com/OpenVoiceOS/ovos-control-panel)
searches a package index: `webui.pypi_index` in `mycroft.conf`, PyPI if not
set. It reads `<base>/simple/` for the names and `<base>/pypi/<name>/json` for
the details. `tools/build.py` writes both into the site, listing what is
`builtin`, `works` or `untested` (with "[Not tested in Emkay yet]" in front of
its summary, which the panel shows): the panel only installs what its index
has, so an untested package must be there for "Get" and the nightly test to
reach it. Broken packages are not listed. The JSON is a copy of PyPI's own, so the files still come
from PyPI; only the choice is ours. Emkay sets
`webui.pypi_index = https://store.emkay.ai`, so its panel's search, setup
wizard and recommendations offer only what works.

This works for any OVOS device, not only Emkay: point its panel at your own
store's index.

The panel currently only finds and installs packages named `ovos-*`
([ovos-control-panel#102](https://github.com/OpenVoiceOS/ovos-control-panel/issues/102),
fixed in [#103](https://github.com/OpenVoiceOS/ovos-control-panel/pull/103)), so
the index only lists those for now.

## Installing from the store

The store is a static site on another origin than the device, so it cannot
install anything itself, and it should not: the device's own panel installs,
and asks first.

- **Inside Emkay** (menu → Skill store) the store runs in a frame with
  `?in=emkay`; "Get" posts the package to the Emkay around it
  (`postMessage`, only to and from the two known origins).
- **On its own**, "Get" opens `app.emkay.ai/?install=<package>`. If Emkay
  already runs in another tab of that browser, the new tab hands the package
  to it (`BroadcastChannel`) instead of starting a second Emkay.

Either way Emkay opens its control panel searched for that package.

## Plugins

Plugins are tested like skills, then checked by kind, the way the device uses
them: the plugin is chosen in `mycroft.conf` (as in the panel's voice
settings) and then used by Emkay's own code, not called directly.

| Kind | Check |
|---|---|
| TTS | Emkay speaks "Hello, this is a test of the voice." with it: works if half a second or more of speech came from this plugin, not from the fallback TTS |
| STT | a recording of "what time is it" goes through Emkay's own path for recorded speech: works if the text has "time" in it |

A plugin that needs an API key (klondike's `requires_api_key`) is installed
and loaded but cannot be tried: `untested`, "needs an API key to try". The
checks are `CHECKS` in `tools/test_skills.mjs`, and the kinds tried are
`PLUGIN_KINDS` in `tools/candidates.py`; a kind joins when its check is written.

## Pipeline plugins: where they go

A pipeline plugin does nothing until it is in `intents.pipeline`, at the right
place. The device places it, not the store, by one rule taken from OVOS
itself rather than from READMEs: a pipeline plugin registers either one
stage or three (`<id>-high`, `-medium`, `-low`, as
`ovos-padatious-pipeline-plugin-high` in OVOS' default pipeline), and each
stage goes next to the stages of the same confidence; a single stage goes
before the medium fallbacks. Emkay does this on every boot and right after
an install, and has ovos-core load the plugin at once
(`intent.service.pipelines.reload`). Plugins whose README asks for something
else are listed as exceptions in Emkay's
[`pipeline_place.py`](https://github.com/emkay-voice/emkay/blob/main/py/emkay_mobile/pipeline_place.py).
A device that wants the same can copy that file: it only uses
ovos-plugin-manager.

## Overrides

Some verdicts a test cannot reach: a skill whose source site refuses
browsers (CORS) only when asked something specific, a voice that works but
sounds bad, a user who tried it on a phone. Those are written by hand in
`data/compat.json` **without** a `tested` field; the nightly job never
overwrites or retries them.

## Planned

- **More plugin kinds**: translate, language detection, solvers, pipelines,
  transformers, VAD and wake words, each with its own check (see *Plugins*).
  Plugins for hardware, media backends, microphones and GUIs make no sense in
  a browser and are left out.
- **"Works for me" / "Doesn't work"** buttons in the store that open a
  prefilled issue, so users' experience becomes overrides.

## Making your own store

1. Fork this repo.
2. In `tools/build.py` and `tools/candidates.py`, set `KLONDIKE` (or your own
   list in the same format) and `EMKAY` (your device's list of shipped
   packages, or none).
3. In `tools/test_skills.mjs`, point the test at your device. It drives Emkay
   through headless Chrome; for a device with a real control panel, drive its
   web UI the same way, or replace `testOne()` with whatever installs a
   package and talks to your OVOS bus.
4. Change the categories, featured rules and texts in `data/` and `locale/`,
   and the look in `site/`.
5. Set your domain in `site/CNAME`, enable GitHub Pages (from Actions), and
   point your devices' `webui.pypi_index` at it.
