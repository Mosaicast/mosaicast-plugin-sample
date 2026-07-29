# mosaicast-plugin-sample

> Reference plugin + build.sh as a copy template for plugin authors (incl. a test example).

Part of **[Mosaicast](https://github.com/mosaicast)** — an extensible website platform for podcasts. Status: **v1 in development**.

## What is this?
See `docs/ARCHITECTURE.md` for the big picture and `docs/BRIEF.md` for this repo's scope.

This plugin ("Episode Highlight", id `sample`) is a podcaster-editable markdown highlight shown at
**episode**, **feed/podcast** and **site** scope. That feature is intentionally simple — the point of this
repo is not the highlight, it's that **every field of `ctx` and every optional backend extension point
the platform currently offers a plugin is exercised somewhere in this codebase**, so a new plugin author
has one real, tested example of each to copy from. Version **2.1.0** brought the plugin from "demonstrates
the basics" to "demonstrates the whole v1 contract"; **2.2.0** fixed a real bug this plugin had against a
then-just-landed core (see [Changelog](#changelog) and "Deep links need a `page` slot" below) and confirmed
every feature against the now-complete host — consent, the generic config-admin UI, and deep
links/share-metadata/sitemap all merged to `master` since 2.1.0. **2.3.0** moves the plugin onto **SDK
0.4.0**, landing in parallel with core's own 0.4.0 migration: service-level consent (`request()`/
`granted()`/a real `onChange`), backend `ctx.logger()`/frontend `ctx.log()`, and the Jackson-3-shaped
`DocEntry.value()` are all now exercised — see [Changelog](#changelog).

## What's demonstrated, and where

### Frontend `ctx` (ARCHITECTURE §7.5) — `frontend/src/components/Highlight.tsx` unless noted
| `ctx` field | What this plugin does with it |
|---|---|
| `scope` | Addresses the doc store (`data/{scopeType}/{scopeId}/highlight`) and picks the i18n title. |
| `episodes` / `episodeLabels` | Site scope renders a "browse highlighted episodes" index, linking each episode's public slug to its own deep link. |
| `episode?.status` | An "Upcoming episode — no spoilers yet" badge while `PLANNED`. |
| `user` | Gates the **Edit** button to `podcaster`/`admin` (in addition to the slot's own `visibleTo`, which the settings panel relies on instead — see below). |
| `api` | Every read/write — the highlight doc, the backend-computed stats doc, the site-wide settings doc, and (read-only) another episode's highlight in the deep-link view. |
| `consent` | `components/ConsentExtras.tsx` — one widget per service declared in `plugin.json`'s `consent.services[]`: `analytics` (a gated, fire-and-forget view ping — a side effect, not markup), `functional` (a gated `<img>` from a declared service host, with a real click-to-load button calling `consent.request('functional')`), and `social`, a category the **host doesn't know** — proving a plugin isn't limited to `necessary`/`functional`/`analytics`. `consent.granted()` drives a one-line summary; `consent.onChange` re-renders on any change (a withdrawal, or a grant from elsewhere), the full 0.4.0 flow in one component. |
| `filter` | A read-only "Filtered to season N" note at feed/site scope when the host's URL filter selects a season. Never defines a filter axis itself (§6.1). |
| `player` | An optional per-highlight "key moment" (seconds): a "▶ Jump to mm:ss" button calls `player.seekTo()` (and logs via `ctx.log`), and `player.on('timeupdate', …)` + `player.currentTime()` flips on a "✓ played" indicator once playback passes it. `player.on` returns an `Unsubscribe` since 0.4.0 — returned from the effect so the listener detaches on unmount/re-render instead of leaking. |
| `route` | The `site`/`page`-placement slot mounts this same element at `/p/sample/...`; `ctx.route.path` of `highlight/<episodeSlug>` switches it into a read-only single-highlight view (title from `episodeLabels`, a back-link to `/p/sample/`), matching `SamplePlugin.metaFor`/`.urls()` server-side (see below and "Deep links need a `page` slot"). |
| `locale` | `createPluginI18n` + `locales/{en,de}.json`, reacting to `ctx.locale.onChange`; the translator instance is memoized and its `dispose()` called on cleanup (a leak `createPluginI18n`'s own docs flag as worth fixing once `onChange` returns something to unsubscribe with). |
| `progress` | An **opt-in** spoiler gate: a highlight the podcaster explicitly marks `spoiler: true` in the edit modal stays hidden behind a "Show anyway" button until `ctx.progress.get()` reports this visitor has actually started the episode. Not access control — a courtesy, same spirit as bingo's spoiler protection. |
| `theme` | Unchanged from 2.0: injected as `--mc-*` custom properties by `defineMosaicastElement`, re-applied explicitly inside `HighlightModal`'s document-level portal. |
| `log` | New in 0.4.0 — replaces the old `POST /api/plugins/{id}/log`. Called on a saved/failed highlight edit, a manual spoiler reveal, a key-moment jump, an admin settings save/failure, and every consent request/grant/deny in `ConsentExtras`. |

The **site/sidebar, `visibleTo: "podcaster"`** slot (`sample-highlight-settings`, `components/AdminSettings.tsx`)
is a second Web Component with its own `ctx` — see "Two ways to be configurable" below for why it exists.

### Backend `PluginContext` (ARCHITECTURE §7.4) — `backend/.../SamplePlugin.java`
| Member | What this plugin does with it |
|---|---|
| `store()` | The highlight doc (frontend-written, per scope), the `stats` doc (backend-written aggregate), and the site-wide `settings` doc (frontend-written by the admin panel, frontend-read by every `Highlight` instance). `recomputeHighlightStats` reads highlights back via `store().query(...)`, this plugin's one use of the Jackson-3-shaped `DocEntry.value(): JsonNode` a prefix scan hands back (every other read goes through the typed `store().get(..., Class)`, which never sees Jackson at all). |
| `schema()` | Not used — `plugin.json` declares `"storage": "doc"`, so this is always `null`. Core's own 0.4.0 plan keeps `schema()` returning `null` regardless of what a manifest declares ("deferred — schema() keeps returning null, which 0.4.0 explicitly allows"), so there's nothing to wire up yet even though the SDK's `SchemaStore`/`Criteria` query surface is real as of 0.4.0. |
| `config()` | `refreshIntervalMinutes` — read and passed to `onSchedule`. Genuinely admin/podcaster-editable today via core's generic config-admin form (`PUT /api/admin/plugins/sample/config`) — see "Two ways to be configurable" below. |
| `feeds()` | `episodesIn(Scope.site())` for the stats aggregate and the sitemap; `display(refId)` for the deep link's OG title/artwork. |
| `onSchedule` | Recomputes the highlighted-episode count (and how many have a key moment) every `refreshIntervalMinutes`. |
| `logger()` | New in 0.4.0 — an SLF4J `Logger` named `plugin.sample` by the host. `WARN` on a non-positive `refreshIntervalMinutes` (clamped, not trusted) and on a stored highlight doc with a missing/blank `markdown` field (skipped, not crashed on); `INFO` on registration and on every recompute, with the counts. |

`SamplePlugin` also implements the two **optional** backend extension points a plugin may add alongside
`PluginBackend` (ARCHITECTURE §7.4), the same single-class pattern the wiki plugin is documented to use:
- **`ShareMetadataProvider`** — `metaFor("highlight/<slug>")` returns the episode's real title (from
  `ctx.feeds().display()`), a plain-text excerpt of the highlight markdown, and the episode's artwork.
- **`SitemapProvider`** — `urls()` lists a `SitemapUrl` for every episode that currently has a highlight.

Both are unit-tested directly in `SamplePluginTest`, and now genuinely exercised end-to-end by core (see
"Deep links need a `page` slot" below) — `/p/sample/highlight/<slug>` really answers with `metaFor`'s
OpenGraph tags, and `/sitemap.xml` really carries `urls()`'s entries, both confirmed against a running core.

## Two ways to be configurable — and why this plugin uses both
The manifest declares `refreshIntervalMinutes` (`type: "number", editableBy: "podcaster"`) in its `config`
block, and **core's generic config-admin form is now real** (merged via `feat/plugin-config-activation` +
`feat/plugin-admin-ui`): **Admin → Plugins** renders one input per declared field — a checkbox for
`boolean`, a number input for `number`, a text input for anything else (`string`) — persists an override to
a dedicated table (`plugin_config`), and `ctx.config().get(...)` resolves **admin override → manifest
default → empty** on every call, no restart needed. A `podcaster` can edit fields whose `editableBy` says
so (enforced with a 403 otherwise); only `admin` can toggle activation or purge a plugin's data. Confirmed
live: `PUT /api/admin/plugins/sample/config {"refreshIntervalMinutes": 5}` persists and reads back
immediately. **The manifest's `config` only supports `string`/`number`/`boolean`** (an unrecognized `type`
fails manifest validation at load) — there is no `select`/enum widget.

That last point is exactly why this plugin *also* ships a second, hand-built pattern: its own admin slot
(`site`/`sidebar`, `visibleTo: "podcaster"`) writing a small doc to its own store
(`data/site/main/settings`), which every `Highlight` instance reads back and applies — a heading override
(a `string`, which the generic form could do too) and a **font choice presented as a real `<select>`**
(which the generic form cannot — it would only ever offer a free-text box for that field). Reach for a
declared `config` field first; reach for your own admin slot when you need a richer widget, cross-field
validation, or anything beyond the three primitive types. **Try it:** open the site page as a podcaster,
change the heading or font in the sidebar panel, save, and reload any episode/feed/site page — the change
is immediate and visible to anonymous visitors too.

## Consent (ARCHITECTURE §12.5, SDK 0.4.0 service-level model)
`plugin.json` declares three **services** under `consent.services[]` (not the pre-0.4.0
`{categories, externalSources}` shape, which 0.4.0 rejects at load): `plausible-highlight-analytics`
(category `analytics`), `host-badge-cdn` (category `functional`), and `share-widget` (category `social`,
arbitrary/unknown to the host — it passes an undeclared category through verbatim, proving a plugin isn't
limited to `necessary`/`functional`/`analytics`). Each service's `hosts[]` is also the CSP allow-list for
that origin — an origin left out stays blocked even after consent is granted.

`ConsentExtras.tsx` is the one place a plugin author sees the full 0.4.0 flow in one component:
- **Denied** → a click-to-load button. Clicking calls `ctx.consent.request(category)` (never on mount —
  an unprompted call would turn a banner-free site into one with a banner) and logs the request/outcome via
  `ctx.log`.
- **Granted** → the real content (the analytics ping fires, the badge/widget `<img>` renders).
- `consent.granted()` renders a one-line summary at the top.
- `consent.onChange` is wired (unlike a pre-0.4.0 version of this file, which skipped it on the — now
  incorrect — assumption that the host always remounts on a consent change): a withdrawal from the host's
  settings page, or a grant from another plugin tile requesting the same category, both flip this
  component back without a remount.

## Deep links need a `page` slot (learned the hard way)
`/p/{pluginId}/*` is core-reserved (ARCHITECTURE §6.4), but core only routes there — and only calls
`ShareMetadataProvider`/serves `/sitemap.xml` entries meaningfully — for a plugin that declares **at least
one slot with `"placement": "page"`**. Version 2.1.0 of this plugin implemented `ctx.route.path` handling
and both backend extension points *without* such a slot, on the (wrong) assumption that any site-scope
mount would do. Against a real core that shipped `feat/plugin-deep-links` + the `fix/plugin-page-soft-404`
follow-up, that meant `GET /p/sample/anything` was a hard **404** — the fix commit's own message names
`plugins/sample` by name as an example plugin that fell into exactly this gap. 2.2.0 adds
`{ "scope": "site", "element": "sample-highlight", "placement": "page", "visibleTo": "anonymous" }` — the
*same* Web Component, now also mounted at `/p/sample/...` by `PluginPage.tsx`, which is what actually
populates `ctx.route.path` (every other slot region passes no route, so `ctx.route.path` is always `''`
outside the `page` placement). Confirmed live: `/p/sample` (browse index), `/p/sample/highlight/<slug>`
(single highlight, real OG tags), and `/sitemap.xml` (lists every highlighted episode's deep link) all now
return the right thing.

## A PF4J gotcha: one class, three extension points, but *not* one instance
Fixing the `page`-slot gap above surfaced a second, subtler bug: booting a real core and hitting
`/p/sample/highlight/<slug>` returned the site-level OG fallback instead of ours, and the log showed
`Cannot invoke "PluginContext.store()" because "this.ctx" is null` — a `NullPointerException` inside
`metaFor`, silently swallowed by `PluginExtensions`' per-provider try/catch (ARCHITECTURE §7.8 isolation
doing exactly its job: a broken plugin degrades, it doesn't crash the page).

Cause: `SamplePlugin` implements `PluginBackend`, `ShareMetadataProvider` and `SitemapProvider` on one
class — the pattern this README used to describe as "the same single-class pattern the wiki plugin uses".
Core's PF4J setup uses the default `ExtensionFactory`, which instantiates a **new object per
extension-point type lookup** — `manager.getExtensions(PluginBackend.class, "sample")`,
`getExtensions(ShareMetadataProvider.class, "sample")` and `getExtensions(SitemapProvider.class, "sample")`
each construct their own `new SamplePlugin()`. `register(ctx)` runs on the first instance; `metaFor`/`urls`
run on different ones whose `ctx` field was never set. A plain instance field silently doesn't work for
this pattern under plain PF4J — the sample's own `SamplePluginTest` didn't catch it either, because its
tests called `register()` and `metaFor()`/`urls()` on the *same* instance, which any instance field would
have survived.

**Fix:** `SamplePlugin.ctx` is now `static` (see the class javadoc). PF4J gives every plugin its own
classloader, so a `static` field is scoped to this class *within this plugin*, shared by every instance PF4J
creates of it — exactly the granularity this pattern needs. The tests were rewritten to `register()` on one
`new SamplePlugin()` and call `metaFor()`/`urls()` on a separate one, matching PF4J's real behavior, so this
class of bug can't silently return in a future edit. **If your plugin implements more than one PF4J
extension point on one class, this applies to you too.**

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
# restart mosaicast-core — the plugin loads and its slots render
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
name declared in `plugin.json`'s `frontend.elements` (there are two now: `sample-highlight` and
`sample-highlight-settings`). `plugin.json`, `backend/`, and `build.sh` stay untouched — `build.sh`'s
frontend step is just `npm ci && npm run build`, so any toolchain that honors those two npm scripts and
that output path works unmodified.

## Changelog
- **2.3.0** — SDK **0.4.0** (`platformApi` bumped to match): consent redesigned around
  `consent.services[]`/`request()`/`granted()`/a real `onChange` (see [Consent](#consent-architecture-125-sdk-040-service-level-model));
  backend `ctx.logger()` added (config-clamp and malformed-stored-doc warnings, registration/recompute
  info); `SamplePlugin`'s stats recompute now reads via `store().query()`/`DocEntry.value(): JsonNode`, this
  plugin's one Jackson-3 touchpoint, and also counts episodes with a key moment; frontend `ctx.log()` added
  at every meaningful user action (highlight save/failure, spoiler reveal, moment jump, admin settings
  save/failure, consent request/grant/deny). Fixed a real leak: `ctx.player.on('timeupdate', …)` now returns
  its `Unsubscribe` instead of dropping it (0.4.0 made `on` return one; the previous code's comment
  claiming otherwise was already wrong by the time this shipped). Also fixed an unrelated pre-existing
  leak: `createPluginI18n` is now memoized and disposed on cleanup in `Highlight.tsx`/`AdminSettings.tsx`,
  instead of subscribing a fresh, never-disposed instance on every render. `SchemaStore`/`Criteria` (also
  new in 0.4.0) are deliberately **not** wired into this plugin — core keeps `schema()` returning `null`
  regardless of what a manifest declares this cycle, so there's nothing to exercise yet; see the `schema()`
  row above.
- **2.2.0** — re-verified against a core that merged consent, the config-admin UI, and deep
  links/share-metadata/sitemap, confirmed live end-to-end (browser + curl against a real running core, not
  just unit tests). Fixed two real bugs this surfaced: (1) the missing `site`/`page`-placement slot, so
  `/p/sample/...` actually routes (previously a hard 404 — see "Deep links need a `page` slot"); (2) a PF4J
  extension-instance gotcha that left `ShareMetadataProvider`/`SitemapProvider` reading a `null` context in
  practice (see "A PF4J gotcha" — now a `static` field + a regression test that instantiates separately).
  Rewrote the README's caveats now that the underlying core gaps are closed.
- **2.1.0** — full-contract pass: wired up `ctx.consent`/`filter`/`player`/`route`/`progress`/
  `episode.status` (previously untouched), added the `ShareMetadataProvider`/`SitemapProvider` backend
  extension points, and added a second slot (`site`/`sidebar`, podcaster-only) as the reference pattern for
  a richer-than-generic-form admin-editable, visitor-visible setting. See the tables above for the full mapping.
- **2.0.x** — the original "Episode Highlight": three slots (episode/feed/site), `ctx.store()`/
  `ctx.feeds()`/`onSchedule` on the backend, `ctx.api`/`ctx.theme`/`ctx.locale`/`ctx.user` on the frontend.

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
