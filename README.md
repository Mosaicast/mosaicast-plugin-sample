# mosaicast-plugin-sample

> Reference plugin + build.sh as a copy template for plugin authors (incl. a test example).

Part of **[Mosaicast](https://github.com/mosaicast)** — an extensible website platform for podcasts. Status: **v1 in development**.

## What is this?
See `docs/ARCHITECTURE.md` for the big picture and `docs/BRIEF.md` for this repo's scope.

This particular plugin ("Episode Highlight", id `sample`) is a minimal but complete reference: a single
`sample-highlight` Web Component mounts at **episode** (`main`), **feed/podcast** (`feed`) and **site**
(`site`) scope. Anyone can read the markdown highlight for that scope (or a "no highlight yet" fallback);
a podcaster or admin additionally gets an **Edit** button opening a modal to write one. The backend
periodically recomputes a highlighted-episode count, shown on the site-scope instance. It demonstrates the
full plugin contract — manifest slots across three scopes, `ctx.store()`/`ctx.feeds()` on the backend,
`ctx.api`/`ctx.theme`/`ctx.locale`/`ctx.user` on the frontend, sanitized markdown rendering, shadow DOM
isolation, i18n, and tests on both sides — so it doubles as a copy template.

## Your first plugin in 5 minutes
**Prerequisite:** the SDK's Java artifacts (`dev.mosaicast:plugin-api`/`plugin-testkit`) are published to
GitHub Packages, which requires authentication even for public reads. Export a GitHub PAT with
`read:packages` before building the backend: `export GITHUB_TOKEN=<your PAT>` (and `GITHUB_ACTOR=<your
username>` if `gradle.properties`' `gpr.user` isn't set). CI supplies this automatically.

```bash
git clone <this-repo-url> my-plugin
cd my-plugin
./build.sh                          # -> dist/ (JAR + assets/sample.es.js + plugin.json)
export MOSAICAST_PLUGINS_DIR=/path/to/core/plugins
./install.sh                        # copies dist/ to $MOSAICAST_PLUGINS_DIR/sample
# restart mosaicast-core — the plugin loads and its two slots render
```
From here, rename `id`/`name` in `plugin.json`, the Java package under `backend/src/main/java/...`, and the
custom element tags in `frontend/src/sample-element.tsx`, and replace the highlight-note logic with your
own.

## Build & test
```bash
./build.sh        # -> dist/
cd backend && ./gradlew test  ;  cd ../frontend && npm test
```

### What `build.sh` does
```bash
( cd backend  && ./gradlew --quiet clean jar )   # compiles + packages backend/build/libs/sample.jar
( cd frontend && npm ci && npm run build )       # Vite bundles React + the SDK into frontend/build/sample.es.js
rm -rf dist && mkdir -p dist/assets
cp backend/build/libs/*.jar dist/                # the PF4J extension JAR
cp frontend/build/*.es.js   dist/assets/         # the Web Component bundle
cp plugin.json              dist/                # the manifest, read by core at plugin-load time
```
It only ever writes to `dist/` — nothing here touches `$MOSAICAST_PLUGINS_DIR` or core. Copying `dist/`
into place (manually, or via the optional `install.sh`) is a separate, deliberate step.

### Using a different frontend framework
`frontend/` is the only framework-specific part of this repo. A Vue/Svelte/etc. author can delete it
entirely and replace it with their own build, as long as the replacement still produces **one** JS bundle
at `frontend/build/*.es.js` that calls `defineMosaicastElement` (from `@mosaicast/plugin-sdk`) for each tag
name declared in `plugin.json`'s `frontend.elements`. `plugin.json`, `backend/`, and `build.sh` stay
untouched — `build.sh`'s frontend step is just `npm ci && npm run build`, so any toolchain that honors
those two npm scripts and that output path works unmodified.

## Contributing
Contributions welcome — see [`CONTRIBUTING.md`](CONTRIBUTING.md). In short: `git commit -s` (DCO, required), SPDX header in new files, add tests.

## License
**Apache License 2.0** — see [`LICENSE`](LICENSE). Header per source file:
```
// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 The Mosaicast Authors
```

## Name & trademark
"Mosaicast" and the logo denote the official project. Please rename forks.
