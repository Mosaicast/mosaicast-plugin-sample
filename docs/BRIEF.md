# Brief: mosaicast-plugin-sample

> Prerequisite: `docs/ARCHITECTURE.md` §7. Depends **only** on `mosaicast-plugin-sdk`.
> Goal: lowest possible entry barrier for plugin authors. `git clone` → `./build.sh` → copy `dist/` to `$MOSAICAST_PLUGINS_DIR` → restart core → it runs. The folder layout is **not enforced** (see ARCHITECTURE §7.1).

## Purpose
End-to-end reference implementation of the plugin contract + a **`build.sh`** that builds the JAR and frontend and writes the drop-in format. Deliberately **React-specific** in `frontend/` — a Vue developer just replaces the `frontend/` folder, manifest/backend/build.sh stay.

## Structure
```
mosaicast-plugin-sample/
├── backend/                 # Gradle, depends only on plugin-api (compileOnly), NO core
│   └── src/.../SamplePlugin.java
├── frontend/                # @mosaicast/plugin-sdk + react + vite
│   ├── vite.config.ts       # builds ONE sample.es.js, React BUNDLED (not external)
│   └── src/sample-element.tsx
├── plugin.json              # full, commented manifest
├── build.sh                 # builds both, writes to dist/
└── dist/                    # finished plugin (JAR + assets/ + plugin.json)
```

## What the sample must demonstrate
- **Manifest** with at least two slots in different scopes (e.g. `episode/main` visible to all + `site/sidebar` podcaster-only) and `storage: "doc"`.
- **Backend:** an endpoint that reads/writes a value per scope via `ctx.store()`, plus use of `ctx.feeds().episodesIn(scope)`.
- **Frontend:** a Web Component via `defineMosaicastElement` from the SDK that reads `this.ctx`, injects the **theme tokens as CSS custom properties into the shadow root** (demonstrate it!), and talks to the backend via `ctx.api`.
- **Shadow DOM encapsulation:** show that host styles don't bleed through and `ctx.theme` is the way to blend into the host design.
- **Plugin i18n (minimal):** a tiny `locales/en.json` + `de.json` used via the SDK's `createPluginI18n`, reacting to `ctx.locale` — so every plugin author sees the translation convention.

## build.sh (target behavior)
**Important: `build.sh` writes only to `dist/` and never touches core.** Distribution is a separate, deliberate step by the user.
```bash
#!/usr/bin/env bash
set -euo pipefail
( cd backend  && ./gradlew --quiet clean jar )
( cd frontend && npm ci && npm run build )       # Vite → frontend/build/sample.es.js
rm -rf dist && mkdir -p dist/assets
cp backend/build/libs/*.jar dist/
cp frontend/build/*.es.js   dist/assets/
cp plugin.json              dist/
echo "✓ dist/ ready — copy to \$MOSAICAST_PLUGINS_DIR and restart core"
```

## Optional: install.sh (shortcut, not a default)
A **separate** script that copies `dist/` to `$MOSAICAST_PLUGINS_DIR` — **only if** the variable is set, otherwise abort with a hint. It enforces no folder layout; pure convenience for people who configured a fixed plugins folder.
```bash
#!/usr/bin/env bash
set -euo pipefail
: "${MOSAICAST_PLUGINS_DIR:?Set MOSAICAST_PLUGINS_DIR or copy dist/ manually}"
dest="$MOSAICAST_PLUGINS_DIR/sample"
rm -rf "$dest" && mkdir -p "$dest"
cp -r dist/* "$dest/"
echo "✓ installed to $dest — restart core"
```

## Definition of Done
README with "your first plugin in 5 minutes", an explained `build.sh`, and the **note on how to replace `frontend/` with another framework**. `dist/` loads in core and renders visibly in its slots.

## Tests (§13.5)
The sample demonstrates **how to test**: a backend unit test with `FakePluginContext` from the Java test kit and a frontend test with `makeMockCtx` from `@mosaicast/plugin-sdk/testing`. So every plugin author has a copy template.

## SDK & license
- Depends **only** on the SDK; consume via `mavenLocal()`/`includeBuild` and `npm link` (ARCHITECTURE §3.5). **Exact signatures from the SDK Javadoc/TSDoc, don't guess.**
- **License: Apache-2.0** (copy template — must not be copyleft). SPDX headers in source files. Take `CONTRIBUTING.md` + DCO workflow from the templates.
