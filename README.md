# Emkay skills — store.emkay.ai

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
  A skill that does not work in a browser is left out.
  A nightly test job is planned in
  [emkay-voice/emkay#21](https://github.com/emkay-voice/emkay/issues/21).
- **Get:** opens `app.emkay.ai/?install=<package>` in the same browser, where
  your Emkay lives. Emkay opens its control panel at that package, and the
  panel's own Install button does the rest (it asks first).
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
- [`data/featured.json`](data/featured.json): the front page's featured skills
- [`data/compat.json`](data/compat.json): what has been tried in Emkay
- `tools/make_locale.py` seeded `locale/`; it only adds missing files
- `tools/shot.mjs URL OUT.png 390x844`: a screenshot in headless Chromium

The site is built nightly by GitHub Actions and published on GitHub Pages.

## License

Apache-2.0. The skills belong to their authors, under their own licenses.
