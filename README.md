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
`DocEntry.value()` are all now exercised — see [Changelog](#changelog). **2.6.0** moves it onto **SDK
0.5.0**: the manifest declares its own [`data` access floor](#the-manifest-data-access-floor-sdk-050),
and a per-visitor "favourite" feature demonstrates the release's headline contract — the host-owned
[`user` storage scope](#per-user-data-lives-in-a-scope-not-in-a-key-sdk-050) plus the backend-only
`queryAcrossUsers` rollup that is the only honest way to count it. **2.7.0** moves it onto **SDK 0.6.0**,
which closes the other half of that ownership story: the two keys this plugin's backend computes are now
declared [`data.backendOwned`](#backend-owned-keys-sdk-060), so a client can no longer forge them.

## What's demonstrated, and where

### Frontend `ctx` (ARCHITECTURE §7.5) — `frontend/src/components/Highlight.tsx` unless noted
| `ctx` field | What this plugin does with it |
|---|---|
| `scope` | Addresses the doc store (`data/{scopeType}/{scopeId}/highlight`) and picks the i18n title. |
| `episodes` / `episodeLabels` | Site scope renders a "browse highlighted episodes" index, linking each episode's public slug to its own deep link. |
| `episode?.status` | An "Upcoming episode — no spoilers yet" badge while `PLANNED`. |
| `user` | Gates the **Edit** button to `podcaster`/`admin` (in addition to the slot's own `visibleTo`, which the settings panel relies on instead — see below). Also decides whether the favourite toggle is offered at all: an anonymous visitor has no `user` partition, so the component shows a sign-in hint instead of making a request the host would answer with 401. |
| **the `user` storage scope** | New in 2.6.0 — a signed-in visitor's own "★ Favourited" mark at `data/user/me/fav:<episodeSlug>`, written with `ctx.api.put`/withdrawn with `ctx.api.delete`. `user` is a `DataScopeType`, **not** a slot scope: `ctx.scope` stays `episode`, only the storage address changes. The public tally beside it comes from a *different*, backend-written doc — see [below](#per-user-data-lives-in-a-scope-not-in-a-key-sdk-050). |
| `api` | All four verbs of the host's generic doc-store surface: `get` (the highlight doc, the backend-computed stats doc, the site-wide settings doc, and read-only another episode's highlight in the deep-link view), `put` (save), and `delete` (the edit modal's **Remove**, behind a two-step confirm). |
| `consent` | `components/ConsentExtras.tsx` — one widget per service declared in `plugin.json`'s `consent.services[]`: `analytics` (a gated, fire-and-forget view ping — a side effect, not markup), `functional` (a gated `<img>` from a declared service host, with a real click-to-load button calling `consent.request('functional')`), `social` (a category the **host doesn't know** — proving a plugin isn't limited to `necessary`/`functional`/`analytics`), and `necessary` (an **unconditional** badge — no `has()` check, no request button, now visible to visitors under core's "Always active" disclosure). `consent.granted()` drives a one-line summary; `consent.onChange` re-renders on any change (a withdrawal, or a grant from elsewhere), the full 0.4.0 flow in one component. |
| `filter` | A read-only "Filtered to season N" note at feed/site scope when the host's URL filter selects a season. Never defines a filter axis itself (§6.1). |
| `player` | An optional per-highlight "key moment" (seconds): a "▶ Jump to mm:ss" button calls `player.seekTo()` (and logs via `ctx.log`), and `player.on('timeupdate', …)` + `player.currentTime()` flips on a "✓ played" indicator once playback passes it. `player.on` returns an `Unsubscribe` since 0.4.0 — returned from the effect so the listener detaches on unmount/re-render instead of leaking. |
| `route` | The `site`/`page`-placement slot mounts this same element at `/p/sample/...`; `ctx.route.path` of `highlight/<episodeSlug>` switches it into a read-only single-highlight view (title from `episodeLabels`, a back-link to `/p/sample/`), matching `SamplePlugin.metaFor`/`.urls()` server-side (see below and "Deep links need a `page` slot"). |
| `locale` | `createPluginI18n` + `locales/{en,de}.json`, reacting to `ctx.locale.onChange`; the translator instance is memoized and its `dispose()` called on cleanup (a leak `createPluginI18n`'s own docs flag as worth fixing once `onChange` returns something to unsubscribe with). |
| `progress` | An **opt-in** spoiler gate: a highlight the podcaster explicitly marks `spoiler: true` in the edit modal stays hidden behind a "Show anyway" button until `ctx.progress.get()` reports this visitor has actually started the episode. Not access control — a courtesy, same spirit as bingo's spoiler protection. |
| `theme` | Unchanged from 2.0: injected as `--mc-*` custom properties by `defineMosaicastElement`, re-applied explicitly inside `HighlightModal`'s document-level portal. |
| `log` | New in 0.4.0 — replaces the old `POST /api/plugins/{id}/log`. Called on a saved/failed highlight edit, a manual spoiler reveal, a key-moment jump, an admin settings save/failure, and every consent request/grant/deny in `ConsentExtras`. |

The **site/sidebar, `visibleTo: "podcaster"`** slot (`sample-highlight-settings`, `components/AdminSettings.tsx`)
is a second Web Component with its own `ctx` — see "Two ways to be configurable" below for why it exists.
The **episode/card** slot (`sample-highlight-card`, `components/HighlightCard.tsx`) is a third — see
"The `card` placement" below.

## The `card` placement — a second, deliberately smaller element
`card` is the compact region on an episode's **feed card**, and it is the one placement with a design rule
attached (ARCHITECTURE §7.3): a plugin puts a badge there and keeps full rendering for the detail page's
`main`. This plugin therefore ships `sample-highlight-card` as a *separate* Web Component rather than
reusing `sample-highlight`, and the differences are the whole lesson:

- **It never renders the markdown body** — only a `✨ Highlight` label plus the key moment if there is one.
  A side effect worth noticing: because there is no content on a card, the `ctx.progress` spoiler gate
  `Highlight` implements is moot here, so a spoiler-marked highlight is announced as `✨ Highlight ·
  spoiler` and nothing else leaks.
- **It renders nothing at all when there is no highlight** (`return null`), not an empty-state line. A feed
  card belongs to the host; adding a permanent "no highlight yet" row to every card in a list is a poor guest.
- **It makes exactly one request.** It deliberately skips the site-wide `settings` doc that `Highlight`
  reads for the heading override, because on a feed page this element mounts *once per episode* — a second
  fetch each would be N extra round trips for cosmetics. Asserted in `HighlightCard.test.tsx`.

Declaring `card` is optional: declare it or omit it, but don't put the full rendering in both.

## Removing a highlight — the fourth doc-store verb
The edit modal's **Remove** button is this repo's example of `ctx.api.delete` and its backend counterpart
`DocStore.delete(scope, key) → boolean`. It exists because *deleting the doc is not the same as saving an
empty one*: a doc with blank markdown is still **present**, and "present" is what `SitemapProvider`/
`ShareMetadataProvider` used to test for — so blanking a highlight left the episode in `sitemap.xml` with an
empty OpenGraph description, and made `recomputeHighlightStats` log a warning about it on every run forever.

Both ends are now correct, and the split between them is the point:
- **Per request**, `metaFor`/`urls` go through `SamplePlugin.publishableHighlight`, which treats a
  blank-markdown doc as absent. They cannot wait for a scheduled job to have run.
- **On the schedule**, `recomputeHighlightStats` *prunes* those docs with `store().delete(...)`, cleaning up
  what older versions of this plugin left behind. `delete` is idempotent and returns whether anything was
  actually removed, so a second pass finds nothing and stays quiet — asserted in `SamplePluginTest`.

The UI uses a **two-step inline confirm** rather than a nested dialog: removal is irreversible, but a second
modal inside an already-portalled modal is more machinery than one destructive click warrants.

### Backend `PluginContext` (ARCHITECTURE §7.4) — `backend/.../SamplePlugin.java`
| Member | What this plugin does with it |
|---|---|
| `store()` | The highlight doc (frontend-written, per scope), the `stats` doc (backend-written aggregate), and the site-wide `settings` doc (frontend-written by the admin panel, frontend-read by every `Highlight` instance). `recomputeHighlightStats` reads highlights back via `store().query(...)`, this plugin's one use of the Jackson-3-shaped `DocEntry.value(): JsonNode` a prefix scan hands back (every other read goes through the typed `store().get(..., Class)`, which never sees Jackson at all). The same pass calls `store().delete(scope, key)` to **prune** contentless highlight docs — see "Removing a highlight" below for why that housekeeping exists. `store().queryAcrossUsers("fav:")` (0.5.0, backend-only, no HTTP surface) tallies every visitor's favourite mark and publishes the per-episode count — the one read that reaches into `USER` partitions, and the only one that can. The two keys it *writes* (`stats`, `favourites`) are declared [`data.backendOwned`](#backend-owned-keys-sdk-060) (0.6.0), so no client can forge them; the three the frontend writes are not. |
| `schema()` | Not used — `plugin.json` declares `"storage": "doc"`, so this is always `null`. Core's own 0.4.0 plan keeps `schema()` returning `null` regardless of what a manifest declares ("deferred — schema() keeps returning null, which 0.4.0 explicitly allows"), so there's nothing to wire up yet even though the SDK's `SchemaStore`/`Criteria` query surface is real as of 0.4.0. |
| `config()` | `refreshIntervalMinutes` — read and passed to `onSchedule`. Genuinely admin/podcaster-editable today via core's generic config-admin form (`PUT /api/admin/plugins/sample/config`) — see "Two ways to be configurable" below. |
| `feeds()` | `episodesIn(Scope.site())` for the stats aggregate and the sitemap; `display(refId)` for the deep link's OG title/artwork. |
| `onSchedule` | Recomputes the highlighted-episode count (and how many have a key moment), prunes contentless docs, and rolls up per-visitor favourites, every `refreshIntervalMinutes`. |
| `logger()` | New in 0.4.0 — an SLF4J `Logger` named `plugin.sample` by the host. `WARN` on a non-positive `refreshIntervalMinutes` (clamped, not trusted) and on a stored highlight doc with a missing/blank `markdown` field (skipped, not crashed on); `INFO` on registration and on every recompute, with the counts. |

`SamplePlugin` also implements the two **optional** backend extension points a plugin may add alongside
`PluginBackend` (ARCHITECTURE §7.4), the same single-class pattern the wiki plugin is documented to use:
- **`ShareMetadataProvider`** — `metaFor("highlight/<slug>")` returns the episode's real title (from
  `ctx.feeds().display()`), a plain-text excerpt of the highlight markdown, and the episode's artwork.
- **`SitemapProvider`** — `urls()` lists a `SitemapUrl` for every episode that currently has a highlight.

Both are unit-tested directly in `SamplePluginTest`, and now genuinely exercised end-to-end by core (see
"Deep links need a `page` slot" below) — `/p/sample/highlight/<slug>` really answers with `metaFor`'s
OpenGraph tags, and `/sitemap.xml` really carries `urls()`'s entries, both confirmed against a running core.

## Per-user data lives in a scope, not in a key (SDK 0.5.0)
The favourite toggle under an episode highlight is small on purpose — it exists to show the shape of the
contract that replaced the SDK's own earlier advice.

**What it used to say.** Model per-user data as a per-user *key*: `mark:<userId>:cell` under an episode
scope. A key is client input, so that put an access-control decision exactly where the host could not check
it — and scope ids are public slugs, so any caller past the plugin's read floor could address anybody's key
without guessing anything. A white-box audit of core found it; 0.5.0 is the fix.

**What it says now.** The host owns the scope:

```ts
// frontend — the visitor's own mark. `me` is a sentinel the host resolves from the session;
// any other user id is a 400, and an anonymous request a 401.
await ctx.api.put(`data/user/${SELF_SCOPE_ID}/fav:${ctx.scope.id}`, true);
await ctx.api.delete(`data/user/${SELF_SCOPE_ID}/fav:${ctx.scope.id}`);   // withdraw
```

The partition is **flat** — one per user, not one per user *and* episode — so the episode moves into the
key. That is the exact inverse of the old convention, and it is the whole point: the part a client controls
(the key) now names a thing, and the part the host controls (the scope) names a person.

**Counting it is the backend's job.** Per-user docs are not addressable from another browser, by design, so
a tally cannot be assembled client-side any more. It never should have been: a summary each browser reports
about itself is a summary of whatever its user typed. `SamplePlugin.tallyFavourites` uses the 0.5.0
backend-only read instead, and publishes the result where the frontend can read it:

```java
for (OwnedDocEntry entry : ctx.store().queryAcrossUsers("fav:")) { … }   // userId is host-resolved
ctx.store().put(Scope.episode(slug), "favourites", new FavouriteCount(n));
```

Two consequences worth copying:
- **A backend has no calling user**, so *every* `DocStore` method — reads included — throws
  `UnsupportedOperationException` for a `USER` scope. `queryAcrossUsers` is the only door, and it has no
  HTTP surface, so no visitor's request can reach another visitor's data through it.
- **Zero is a deletion, not a `{"count": 0}`**: an episode nobody favourited and one whose last favourite
  was withdrawn are the same state. `SamplePluginTest` asserts both directions, seeding what a frontend
  would have written via the test kit's `InMemoryDocStore.asUser(uuid)` — which has no production
  counterpart, precisely because no real store can write into someone else's partition.

**Migrating an existing plugin?** This one had no per-user data to move, so it is a clean example, not a
migration example. If yours does, note that nothing moves it for you and the backend cannot write into a
partition: the move is necessarily client-side and lazy (each user's data moves on their next visit). The
SDK's `MIGRATION.md` step 4 has the pattern.

## The manifest `data` access floor (SDK 0.5.0)
```json
"storage": "doc",
"data": {
  "readableBy": "anonymous",
  "writableBy": "podcaster",
  "backendOwned": ["stats", "favourites"]
},
```
Before 0.5.0 core *derived* the read floor from the **minimum `visibleTo` across all slots** — so this
plugin, which has anonymous display slots and a podcaster-only settings slot, served its entire doc store
to anonymous callers. That inference is gone and nothing replaces it silently: **an absent `data` block
defaults `readableBy` to the write floor, not to anonymous.** A plugin with a public slot and no block
therefore starts answering **403** to reads that returned 200 the day before. That is the fix working, but
it is the change most likely to be met in production, so declare the block.

This plugin's own floors say something worth reading twice:
- `readableBy: "anonymous"` — highlights are public content on public pages. Say so explicitly; the slot's
  `visibleTo` governs **rendering only** and never governed data.
- `writableBy: "podcaster"` — only a podcaster writes a highlight. **And fans can still favourite**, because
  neither floor applies to the `USER` scope: a write floor protects the *shared* surface, and a user
  partition is unshared. Without that exemption every plugin with a per-user feature would have to declare
  `writableBy: "fan"` and open its shared scopes along with it.

## Backend-owned keys (SDK 0.6.0)
The floors above are per **plugin**, not per **document** — and a document in a shared scope
(`site`/`feed`/`season`/`episode`) has no owner at all. So until 0.6.0, everything above `writableBy` could
overwrite or delete *any* key in this plugin's store, including one the backend computed. The host cannot
tell a scheduled write from a `curl`: same table, same key, no author recorded. That is not a
misconfiguration of this plugin — its floors did exactly what they say. There was simply no way to express
"this key is the backend's". The SDK's own migration guide demonstrates it against this plugin:

```bash
curl -b cookie.podcaster -X PUT .../api/plugins/sample/data/site/main/stats \
     -H "X-XSRF-TOKEN: $XT" -d '{"totalEpisodes":9999,"totalFavourites":1337}'   # 204 — and served to everyone
```

`data.backendOwned` is the answer. Two keys here are written by `SamplePlugin` and by nothing else:

| Key | Written at | Why a client must not write it |
|---|---|---|
| `stats` | `Scope.site()` | The site-wide rollup the site slot displays — a forged one is shown to every visitor. |
| `favourites` | `Scope.episode(<slug>)` | A tally of data no browser can even read; a client-supplied number is not a count of anything. |

A client `PUT`/`DELETE` to either is now **403** (worded differently from a role-floor 403, so you can tell
which rule refused you). Reads are untouched and still governed by `readableBy`. `ctx.store()` — the
backend — is unaffected, which is the entire point. An entry is an exact key, a prefix ending in `*`, or the
bare `*`; core validates the grammar (`DocStore.BACKEND_OWNED_PATTERN`) at load.

Three things this plugin had to get right, and one it deliberately didn't do:
- **The declaration does not clean up.** It refuses *new* client writes; a document forged before the
  declaration existed is served until the backend overwrites it. So `register()` now calls
  `recomputeHighlightStats(ctx)` **eagerly** as well as scheduling it — otherwise the forgery survives up to
  `refreshIntervalMinutes`. `SamplePluginTest` asserts on the INFO lines to prove the eager pass exists,
  since the test kit runs `onSchedule` synchronously and would otherwise hide its absence.
- **Client-written keys stay undeclared.** `highlight` is the podcaster's, `settings` is the admin panel's,
  and `fav:<slug>` is the visitor's own. Declaring one would lock this plugin out of its own store;
  `sample-element.test.tsx` asserts none of the three is covered by a pattern.
- **It is ignored for `user` scopes.** The backend cannot write a partition at all, so even a bare `*` would
  leave `data/user/me/…` to its owner. Per-person data belongs in the `USER` scope, not in a shared scope
  with a declaration bolted on.
- **Not declared: `*`.** A bare `*` ("everything I store is computed") would be wrong here and would also
  make `writableBy` vestigial for shared scopes — this plugin's whole point is that a podcaster writes
  highlights over HTTP.

`InMemoryDocStore.withBackendOwned("stats", "favourites")` enforces the same rule in tests, using
`asUser(...)` as the stand-in for a client request, so the forged `PUT` above is proven to fail without a
running host.

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
`plugin.json` declares four **services** under `consent.services[]` (not the pre-0.4.0
`{categories, externalSources}` shape, which 0.4.0 rejects at load): `plausible-highlight-analytics`
(category `analytics`), `host-badge-cdn` (category `functional`), `share-widget` (category `social`,
arbitrary/unknown to the host — it passes an undeclared category through verbatim, proving a plugin isn't
limited to `necessary`/`functional`/`analytics`), and `highlight-plugin-badge` (category `necessary` — see
below). Each service's `hosts[]` is also the CSP allow-list for that origin — an origin left out stays
blocked even after consent is granted, and, since core's storage/CSP-enforcement update, **narrowed per
visitor**: the server mirrors the decision into an `mc_consent` cookie and only widens the CSP by what that
cookie actually grants, so a declined category is a blocked request at the network layer, not just a
skipped `ctx.consent.has()` check.

`ConsentExtras.tsx` is the one place a plugin author sees the full 0.4.0 flow in one component:
- **Denied** → a click-to-load button. Clicking calls `ctx.consent.request(category)` (never on mount —
  an unprompted call would turn a banner-free site into one with a banner) and logs the request/outcome via
  `ctx.log`.
- **Granted** → the real content (the analytics ping fires, the badge/widget `<img>` renders).
- **Necessary** → the fourth badge (`highlight-plugin-badge`, the plugin's own wordmark) is unconditional:
  no `has()` check, no request button, because a `necessary` service is never offered as a choice in the
  first place. Before core's storage/CSP-enforcement update, that meant zero visitor-facing disclosure for
  it either; it now lists under "Always active" in the host's privacy settings (the `necessaryServices`
  field on the consent payload), so this service is the one a visitor can actually see acknowledged
  without ever being asked to decide on it.
- `consent.granted()` renders a one-line summary at the top.
- `consent.onChange` is wired (unlike a pre-0.4.0 version of this file, which skipped it on the — now
  incorrect — assumption that the host always remounts on a consent change): a withdrawal from the host's
  settings page, or a grant from another plugin tile requesting the same category, both flip this
  component back without a remount.

**Declared storage and the sweep.** Only `share-widget` declares a storage item
(`share_session`, a session cookie — the real widget would set this; this plugin never writes it itself,
since the widget host is fake). The other three declare `storage: []`, honestly: none of them write any
`localStorage`/cookie entry from this plugin's own code. That matters because core now **sweeps** undeclared
storage — on load, and after every consent decision — down to what the visitor granted plus what core and
`necessary` services declared; everything else is deleted, including keys no manifest ever mentioned (a
dev-profile audit also warns about undeclared writes as they happen). A plugin's `storage[]` list is
therefore load-bearing, not just documentation: declare less than you write and the sweep deletes it out
from under you.

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
cd backend  && ./gradlew test
cd frontend && npm test && npm run typecheck
```
`npm run typecheck` (`tsc --noEmit`) is a separate step on purpose: **Vite transpiles without
type-checking**, so `npm run build` alone will happily emit a bundle containing a type error. CI runs all
four, plus a `package` job that runs `./build.sh` itself and asserts the resulting `dist/` is complete and
that `plugin.json`'s `platformApi` still matches the `plugin-api` version the backend compiles against —
the unit-test jobs would all stay green if the packaging step broke.

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
name declared in `plugin.json`'s `frontend.elements` (there are three now: `sample-highlight`,
`sample-highlight-card` and `sample-highlight-settings`). `sample-element.test.tsx` asserts that every
declared tag really is defined and that every slot targets a declared element — manifest/bundle drift is
otherwise caught by nothing, since core validates the manifest and Vite validates the bundle, and a
declared-but-undefined element just renders an empty slot. `plugin.json`, `backend/`, and `build.sh` stay
untouched — `build.sh`'s
frontend step is just `npm ci && npm run build`, so any toolchain that honors those two npm scripts and
that output path works unmodified.

## Changelog
- **2.8.0** — SDK **0.7.0** (`platformApi` bumped to match; core rejects a `major.minor` mismatch at load,
  so a `0.6.x` manifest stops loading the moment the host is on 0.7.0). **Nothing else changed** — both
  additions in 0.7.0 are new surface this plugin does not yet use:
  - **`ctx.schema`** is `null` here and stays that way. It exists for a plugin that declares
    `storage.schema`; this one uses the doc store, which is the default and covers nearly everything.
  - **`ctx.route.navigate(subpath, { replace })`** is the one worth a look for anyone copying this repo:
    this plugin *does* declare a `page` slot, so it owns `/p/sample/*`, and an internal link there should
    call `navigate` (while keeping its `href`) rather than costing a full document load. Not wired up here
    yet — the sample's page renders a single view with nothing to navigate to.
- **2.7.0** — SDK **0.6.0** (`platformApi` bumped to match; core rejects a `major.minor` mismatch at load,
  so a `0.5.x` manifest stops loading the moment the host is on 0.6.0). The manifest declares
  **`data.backendOwned: ["stats", "favourites"]`** — the two keys `SamplePlugin` computes and no client may
  write. Before this there was no per-document ownership in a shared scope at all, and a podcaster could
  `PUT` a forged `stats` that every visitor then read; the SDK's migration guide uses this plugin as the
  worked example. `register()` now recomputes **eagerly** as well as on its schedule, because the
  declaration refuses new client writes but does not remove a document forged before it existed. Tests use
  `InMemoryDocStore.withBackendOwned(...)` to prove the forged write is refused while the backend's own goes
  through, and `sample-element.test.tsx` asserts the manifest matches `PLATFORM_API_VERSION` and that no
  client-written key (`highlight`, `settings`, `fav:<slug>`) is covered by a pattern. Nothing else changed:
  the 0.6.0 contract is source-compatible with 0.5.0. See
  [Backend-owned keys](#backend-owned-keys-sdk-060).
- **2.6.0** — SDK **0.5.0** (`platformApi` bumped to match; core rejects a `major.minor` mismatch at load,
  so this is not optional once the host is on 0.5.0). Two things changed, one of them a behaviour change:
  the manifest now declares its **`data` access floor** (`readableBy: "anonymous"`, `writableBy:
  "podcaster"`) instead of core deriving the read floor from the minimum `visibleTo` across slots — under
  which this plugin's anonymous display slot exposed its whole doc store; and a per-visitor **favourite**
  feature demonstrates the host-owned **`user` scope**: `data/user/me/fav:<episodeSlug>` from the frontend,
  `DocStore.queryAcrossUsers("fav:")` on the backend for the tally, published per episode and rolled into
  the site `stats` doc. The plugin had no per-user data before, so there was nothing to migrate — the SDK's
  `MIGRATION.md` step 4 covers plugins that do. See
  [Per-user data lives in a scope, not in a key](#per-user-data-lives-in-a-scope-not-in-a-key-sdk-050) and
  [The manifest `data` access floor](#the-manifest-data-access-floor-sdk-050). `docs/ARCHITECTURE.md` was
  re-synced from core's canonical copy in the same pass.
- **2.5.0** — two additions that closed the last gaps in the "one real example of each" claim.
  **Removing a highlight**: a **Remove** button in the edit modal behind a two-step confirm, wiring up
  `ctx.api.delete` and `DocStore.delete(scope, key) → boolean` — until now the only untouched verb on either
  end of the doc store. This also fixed a real defect: blanking a highlight (the only way to "remove" one
  before) left a contentless doc that kept the episode in `sitemap.xml` with an empty OpenGraph description
  and warned on every scheduled recompute forever. `metaFor`/`urls` now test for *publishable* rather than
  *present*, and the recompute prunes such leftovers. **The `card` placement**: a third element,
  `sample-highlight-card`, in the `episode`/`card` slot — the compact feed-card badge, kept deliberately
  separate from the full element (never renders markdown, renders nothing when there's no highlight, makes
  exactly one request). See [The `card` placement](#the-card-placement--a-second-deliberately-smaller-element)
  and [Removing a highlight](#removing-a-highlight--the-fourth-doc-store-verb). Also added a manifest↔bundle
  drift guard asserting every declared element is actually defined.
- **2.4.1** — maintenance pass, no feature or contract change. Fixes: `metaFor`/`urls` now return
  empty instead of throwing when core resolves those extension points before any instance has
  `register()`ed (the same null-`ctx` shape as the PF4J bug below, but reached by lookup order rather than
  by instance identity — see "A PF4J gotcha"); the visitor-controlled deep-link slug and every scope id are
  `encodeURIComponent`-ed before becoming an API path segment, so a `..` in `/p/sample/highlight/...` can't
  be normalized into a request for a different doc; a negative key moment is clamped to `0` rather than
  stored as a negative `player.seekTo()` target; the edit dialog gets an accessible name
  (`aria-labelledby`), focuses its textarea on open and hands focus back to the **Edit** button on close.
  Tooling: `.pre-commit-config.yaml` was **not valid YAML** since the initial bootstrap — the SPDX hook's
  unquoted `entry:` contains a bare `: `, which terminates a plain YAML scalar, so `pre-commit` failed to
  load the file at all and the hook had never run for anyone; it is a block scalar now. `dependabot.yml`'s
  gradle/npm ecosystems pointed at `/` (which matches nothing here) and now point at `/backend`/`/frontend`.
  CI gained a TypeScript typecheck step, a `push`-to-`master` trigger, Gradle caching, and a `package` job
  that runs `build.sh` end to end.
- **2.4.0** — follows core's storage/CSP-enforcement update (the `mc_consent` cookie narrowing the CSP per
  visitor, and the on-load/post-decision storage sweep that deletes anything no manifest declared). No code
  change was *required* — `ctx.consent`'s contract didn't move, and this plugin already declared every
  storage item it writes — but adds a fourth `necessary`-category service (`highlight-plugin-badge`) to
  showcase the disclosure core's update newly gives that category: an unconditional badge, never gated by
  `has()`, now listed under "Always active" in the host's privacy settings instead of being invisible to
  visitors. See [Consent](#consent-architecture-125-sdk-040-service-level-model).
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
