# <img src='site/icon.svg' width='50' height='50' style='vertical-align:bottom'/> Emkay skills — store.emkay.ai

The skill store for [Emkay](https://app.emkay.ai), OpenVoiceOS in the browser:
OVOS skills you can add to Emkay, by category, in your language, with what
to say to them.

- **What is in it:** the skills
  [OVOS Klondike Mercantile](https://andlo.github.io/ovos-klondike-mercantile/)
  finds on GitHub and calls *Looks Complete* (a manifest, on PyPI, a release
  or in OpenVoiceOS' own store). Names, descriptions and example phrases are
  shown in the visitor's language when the skill has them.
- **Works in Emkay?** Each skill says whether it comes with Emkay (from
  [app.emkay.ai/build.json](https://app.emkay.ai/build.json)), has been tried
  and works, or has not been tested yet ([data/compat.json](data/compat.json)).
  A skill that does not work in a browser is left out. A nightly job installs
  the next skills in Emkay and tries them
  ([emkay-voice/emkay#21](https://github.com/emkay-voice/emkay/issues/21)).
- **A package index for the control panel:** `store.emkay.ai/simple/` lists
  only what works, and Emkay's control panel searches it instead of all of
  PyPI. Any OVOS device can use it (`webui.pypi_index`).
- **Get:** inside Emkay (menu → Skill store) it hands the package to that
  Emkay; on its own it opens `app.emkay.ai/?install=<package>`, which hands it
  to an Emkay already open in that browser. Emkay opens its control panel at
  that package, and the panel's own Install button does the rest (it asks first).
- **Emkay Dev:** every skill on GitHub has *Open in Emkay Code* (VS Code for
  the Web) and *View on GitHub*, and a skill – not a plugin – *Open in Emkay
  Blocks* too, which opens it as blocks; folded away, and not on a phone.

**How it all works, and how to make a store like this for your own device:
[docs/how-it-works.md](docs/how-it-works.md).**
- **Languages:** the twelve Emkay speaks (80 % or more on ovos-localize). The
  store's own texts are in [`locale/`](locale), one `.dialog` file per text, as
  in an OVOS skill.

## Building

```bash
python3 tools/build.py            # klondike's skills.json + Emkay's build.json -> site/
cd site && python3 -m http.server 8090
```

- [`data/categories.json`](data/categories.json): the store's categories, the
  words that place a skill in one, overrides, readable names and descriptions
- [`data/featured.json`](data/featured.json): how the front page's *Featured* row is picked: only skills that work in Emkay; new and recently updated ones first, then the skill of the week (changes every ISO week)
- [`data/compat.json`](data/compat.json): what has been tried in Emkay; the
  nightly test writes entries with `tested`, entries without it are written
  by hand and never retried
- `tools/candidates.py` picks the next skills to test; `tools/test_skills.mjs`
  installs and tries them in Emkay (workflow `test-skills.yml`)
- `tools/make_locale.py` seeded `locale/`; it only adds missing files
- `tools/shot.mjs URL OUT.png 390x844`: a screenshot in headless Chromium

The site is built nightly by GitHub Actions and published on GitHub Pages.

## License

Apache-2.0. The skills belong to their authors, under their own licenses.
