# mosaicast-plugin-sample

> Reference plugin + build.sh as a copy template for plugin authors (incl. a test example).

Part of **[Mosaicast](https://github.com/mosaicast)** — an extensible website platform for podcasts. Status: **v1 in development**.

## What is this?
See `docs/ARCHITECTURE.md` for the big picture and `docs/BRIEF.md` for this repo's scope.

This plugin ("Episode Highlight", id `sample`) is a podcaster-editable markdown highlight shown at
**episode**, **feed/podcast** and **site** scope. That feature is intentionally simple — the point of this
repo is not the highlight, it's that **every field of `ctx` and every optional backend extension point
the platform currently offers a plugin is exercised somewhere in this codebase** (with one documented
exception: `ctx.schema`/`schema()`, which is `null` for a doc-store plugin and unreachable without
changing what this one stores), so a new plugin author
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
**2.8.0** moves it onto **SDK 0.7.1** and wires the one field of that release a doc-store plugin can use:
every link into this plugin's own `/p/sample/*` page subtree now hands a plain click to
[`ctx.route.navigate`](#internal-links-go-through-ctxroutenavigate-sdk-070) — SPA navigation — while
keeping the `href` that makes it a link at all. **2.9.0** moves it onto **SDK 0.8.0**, whose headline is
that a plugin can finally accept a **file**: a highlight may now carry a podcaster-uploaded image
([`ctx.blobs`](#file-uploads-live-behind-a-manifest-declaration-sdk-080), declared in the manifest and swept
for orphans by the backend), and [`ctx.links`](#links-vs-navigate-two-different-questions) replaces the
hardcoded episode URL every plugin used to write by hand. **2.12.0** moves it onto **SDK 0.9.1**, the
release that came out of *using* the contract — and much of what it added was found by building **this
repo** against 0.8.0 and noticing what the plugin had to build for itself. So this version is as much a set
of **deletions** as of additions: a hand-rolled icon stylesheet, a `formatTime`/`formatBytes` pair, an
extension→MIME table and ten `.catch(() => undefined)` call sites all left, replaced by SDK surface. What
arrived: the [shared tag vocabulary](#tags-are-one-vocabulary-several-writers-share-sdk-090),
[`ctx.feeds`](#the-page-draws-real-episode-cards-now-sdk-090) (so the page's cards carry the host's own
artwork, title, date and runtime instead of a slug), [`ctx.docs`](#ctxdocs-and-the-escape-hatch-underneath-it),
[typed API failures](#absence-is-an-answer-a-failure-is-not-sdk-090), and three new backend extension
points — [`PageRouteProvider`](#unknown-subpaths-are-real-404s-now-sdk-091) (0.9.1's headline: an unknown
subpath under `/p/sample/` finally answers **404** rather than a soft-404),
[`SearchProvider`](#plugin-content-in-the-sites-own-search-sdk-090) and
[`UserDataHandler`](#what-a-plugin-owes-a-departing-account-sdk-090).

**2.13.0** moves it onto **SDK 0.11.0**, which is two contract releases in one step and both of them are
about the same thing: a site is not necessarily monolingual, and a plugin cannot find that out by guessing.
0.10.0 made languages a **runtime registry** the operator edits and handed plugins two lists to read it
with; 0.11.0 put the host's translation provider behind a manifest declaration. So a highlight can now be
written in every language the site authors content in, with the site's own translation service drafting the
ones nobody has got to yet — and every part of that is arranged so a machine's words are never mistaken for
a person's. See [two lists, and picking the wrong one is
silent](#two-locale-lists-and-picking-the-wrong-one-is-silent-sdk-0100) and [machine translation is a draft,
and says so twice](#machine-translation-is-a-draft-and-says-so-twice-sdk-0110).

**2.14.0** moves it onto **SDK 0.12.0**, which finishes that thought at the *URL*. Core serves any page as
`?lang=de` and emits `hreflang` alternates in `sitemap.xml`; a plugin could not participate, because the host
will not guess which of a plugin's pages exist in which language. Now this one declares it — and declaring it
exposed the half that was missing: the deep-linkable highlight page ignored the reader's language entirely,
so the alternate would have pointed at the English original. See [saying what language a page is
in](#saying-what-language-a-page-is-in-sdk-0120). The same release drops a workaround this repo had been
teaching for a year — see [the PF4J
gotcha](#a-pf4j-gotcha-that-core-fixed--and-the-workaround-this-plugin-carried-for-it).

## What's demonstrated, and where

### Frontend `ctx` (ARCHITECTURE §7.5) — `frontend/src/components/Highlight.tsx` unless noted
| `ctx` field | What this plugin does with it |
|---|---|
| `scope` | Addresses the doc store (`data/{scopeType}/{scopeId}/highlight`) and picks the i18n title. |
| `episodes` / `episodeLabels` | Site scope renders a "browse highlighted episodes" index, linking each episode's public slug to its own deep link. |
| `episode?.status` | An "Upcoming episode — no spoilers yet" badge while `PLANNED`. |
| `user` | Gates the **Edit** button to `podcaster`/`admin` (in addition to the slot's own `visibleTo`, which the settings panel relies on instead — see below). Also decides whether the favourite toggle is offered at all: an anonymous visitor has no `user` partition, so the component shows a sign-in hint instead of making a request the host would answer with 401. |
| **the `user` storage scope** | New in 2.6.0 — a signed-in visitor's own "Favourited" mark at `data/user/me/fav:<episodeSlug>`, written with `ctx.api.put`/withdrawn with `ctx.api.delete`. `user` is a `DataScopeType`, **not** a slot scope: `ctx.scope` stays `episode`, only the storage address changes. The public tally beside it comes from a *different*, backend-written doc — see [below](#per-user-data-lives-in-a-scope-not-in-a-key-sdk-050). |
| `api` | The raw client, kept **deliberately** at exactly one call site since 2.12.0: `AdminSettings.tsx` reads and writes the site settings doc through it (with `getOrNull`), so the reference plugin shows the surface underneath `ctx.docs` rather than only the sugar. It is the documented escape hatch and it did not go away — see [below](#ctxdocs-and-the-escape-hatch-underneath-it). |
| `docs` | New in 0.9.0 — the typed doc client, and where every other read and write in this plugin went. It builds the four-segment path, validates the key against the host's own pattern *before* spending a 400 round-trip, and resolves **`null`** for a document nothing has written. `'self'` (`data/user/me`) is what the favourite mark uses; `'site'` (`data/site/main`) the stats, index and settings docs. |
| `feeds` | New in 0.9.0 — one batched `displayMany` per page render gives every card the host's real title, artwork, publication date and runtime. Before it, the page drew slugs. A missing key is **normal** (the host filtered that episode out for this visitor), never an error — see [below](#the-page-draws-real-episode-cards-now-sdk-090). |
| `tags` | New in 0.9.0 — the site's shared vocabulary, `null` unless the manifest declares a `tags` block. The backend mirrors each episode's tags onto this plugin's own subject; `HighlightTags.tsx` renders them and links each to core's filtered feed view. This plugin declares `readsVocabulary` and **not** `writesEpisodes` — see [below](#tags-are-one-vocabulary-several-writers-share-sdk-090). |
| `consent` | `components/ConsentExtras.tsx` — one widget per service declared in `plugin.json`'s `consent.services[]`: `analytics` (a gated, fire-and-forget view ping — a side effect, not markup), `functional` (a gated `<img>` from a declared service host, with a real click-to-load button calling `consent.request('functional')`), `social` (a category the **host doesn't know** — proving a plugin isn't limited to `necessary`/`functional`/`analytics`), and `necessary` (an **unconditional** badge — no `has()` check, no request button, now visible to visitors under core's "Always active" disclosure). `consent.granted()` drives a one-line summary; `consent.onChange` re-renders on any change (a withdrawal, or a grant from elsewhere), the full 0.4.0 flow in one component. |
| `filter` | A read-only "Filtered to season N" note at feed/site scope when the host's URL filter selects a season. Never defines a filter axis itself (§6.1). |
| `player` | An optional per-highlight "key moment" (seconds): a "Jump to mm:ss" button calls `player.seekTo()` (and logs via `ctx.log`), and `player.on('timeupdate', …)` + `player.currentTime()` flips on a "played" indicator once playback passes it. `player.on` returns an `Unsubscribe` since 0.4.0 — returned from the effect so the listener detaches on unmount/re-render instead of leaking. |
| `route` | The `site`/`page`-placement slot mounts this same element at `/p/sample/...`; `ctx.route.path` of `highlight/<episodeSlug>` switches it into a read-only single-highlight view (title from `episodeLabels`, a back-link to `/p/sample/`), matching `SamplePlugin.metaFor`/`.urls()` server-side (see below and "Deep links need a `page` slot"). Both links *into* that subtree — the browse index's per-episode entries and the back-link out of a deep link — keep their `href` **and** hand a plain left-click to `ctx.route.navigate` (0.7.0), which is SPA navigation rather than a full document load: see [below](#internal-links-go-through-ctxroutenavigate-sdk-070). |
| `locale` | `createPluginI18n` + `locales/{en,de}.json`, reacting to `ctx.locale.onChange`; the translator instance is memoized and its `dispose()` called on cleanup (a leak `createPluginI18n`'s own docs flag as worth fixing once `onChange` returns something to unsubscribe with). **Since 2.13.0 it also decides which language the highlight itself is shown in** — `current()` picks the stored translation, and `content()`/`available()` are the two lists that drive the editor's tabs and the admin panel's read-out. The two jobs are independent: a site can author content in a language this plugin ships no UI catalog for, so the tile can be German prose in English chrome. See [below](#two-locale-lists-and-picking-the-wrong-one-is-silent-sdk-0100). |
| `translation` | New in 0.10.0, gated by the manifest in 0.11.0 — the host's own translation provider, behind `external: { kinds: ["translation"] }`. `TranslationEditor.tsx` offers a podcaster a "translate from &lt;default&gt;" button per language tab; the result is stored as a **labelled draft**, never silently. `null` for two indistinguishable reasons — no declaration, or no provider — and every site has no provider by default, so the absent path is the ordinary one. See [below](#machine-translation-is-a-draft-and-says-so-twice-sdk-0110). |
| `progress` | An **opt-in** spoiler gate: a highlight the podcaster explicitly marks `spoiler: true` in the edit modal stays hidden behind a "Show anyway" button until `ctx.progress.get()` reports this visitor has actually started the episode. Not access control — a courtesy, same spirit as bingo's spoiler protection. |
| `theme` | Unchanged from 2.0: injected as `--mc-*` custom properties by `defineMosaicastElement`, re-applied explicitly inside `HighlightModal`'s document-level portal. Its sibling channel, the host's `--mc-icon-*` artwork, is **not** a `ctx` field at all — see [below](#icons-come-from-the-host-and-not-through-ctx-core-0615). |
| `log` | New in 0.4.0 — replaces the old `POST /api/plugins/{id}/log`. Called on a saved/failed highlight edit, a manual spoiler reveal, a key-moment jump, an admin settings save/failure, and every consent request/grant/deny in `ConsentExtras`. |
| `blobs` | New in 0.8.0 — an optional podcaster-uploaded **image** on a highlight, and the reason this plugin's manifest carries a [`blobs` block](#file-uploads-live-behind-a-manifest-declaration-sdk-080) at all (`ctx.blobs` is `null` without one). The edit modal reads `quota()` *before* a file is picked, `upload()`s the pick, stores only the returned **`ref`**, and `remove()`s whatever it stopped pointing at; the view derives the URL with `urlFor(ref)` at render time. Served same-origin, so unlike `ConsentExtras`' external `<img>` it needs no declared CSP host and makes no consent decision. |
| `links` | New in 0.8.0 — `episode(slug, { t })` on every browse-index row and on the deep-link view (where `t` is the podcaster's own key moment, turning it into core's timestamp deep link), and `feed(slug, { season })` on the feed-scope filter note. Strings for real `href`s, never navigation — see [below](#links-vs-navigate-two-different-questions) for why this is separate from `ctx.route`. |
| `users` | New in 0.13.0 — turns the author UUID stored on a highlight into a name and an avatar, at render. `components/Byline.tsx` does one row, `HighlightPage.tsx`'s credit strip does a whole listing in **one** `resolve`. `null` unless the manifest declares `identity`. An id that comes back **absent** (erased, pseudonymised, unknown) becomes a placeholder and the highlight stays — see [below](#a-byline-that-outlives-its-author-sdk-0130). |
| `notify` | New in 0.14.0, and the **second** `ctx` field this plugin does not exercise — deliberately. `ctx.notify` exists and this manifest declares `notifications`, but nothing a *visitor* does here is news to anybody else; the announcement worth sending finishes on a timer, so it is sent from the backend's `notifier()` instead. See [below](#the-one-surface-that-writes-into-somebody-elses-site-sdk-0140). |
| `schema` | New in 0.7.0, and the **one** `ctx` field this plugin does not exercise — deliberately, because it cannot. `ctx.schema` is `null` unless the manifest declares `storage.schema`, and this one declares `"storage": "doc"`; the doc store is the default and covers nearly everything, so it is what the reference plugin should demonstrate. Reaching the schema client would mean changing what this plugin stores. Its Java half is the same story — see `schema()` below. |

The **site/sidebar, `visibleTo: "podcaster"`** slot (`sample-highlight-settings`, `components/AdminSettings.tsx`)
is a second Web Component with its own `ctx` — see "Two ways to be configurable" below for why it exists.
The **episode/card** slot (`sample-highlight-card`, `components/HighlightCard.tsx`) is a third — see
"The `card` placement" below.

## The `card` placement — a second, deliberately smaller element
`card` is the compact region on an episode's **feed card**, and it is the one placement with a design rule
attached (ARCHITECTURE §7.3): a plugin puts a badge there and keeps full rendering for the detail page's
`main`. This plugin therefore ships `sample-highlight-card` as a *separate* Web Component rather than
reusing `sample-highlight`, and the differences are the whole lesson:

- **It never renders the markdown body** — only a `Highlight` label plus the key moment if there is one.
  A side effect worth noticing: because there is no content on a card, the `ctx.progress` spoiler gate
  `Highlight` implements is moot here, so a spoiler-marked highlight is announced as `Highlight ·
  spoiler` and nothing else leaks.
- **It renders nothing at all when there is no highlight** (`return null`), not an empty-state line. A feed
  card belongs to the host; adding a permanent "no highlight yet" row to every card in a list is a poor guest.
- **It makes exactly one request.** It deliberately skips the site-wide `settings` doc that `Highlight`
  reads for the heading override, because on a feed page this element mounts *once per episode* — a second
  fetch each would be N extra round trips for cosmetics. Asserted in `HighlightCard.test.tsx`.

Declaring `card` is optional: declare it or omit it, but don't put the full rendering in both.

## A page is not a tile — and it can have several front doors (core 0.6.15)
Until 0.6.15 a `page` plugin owned `/p/{id}/*` and **nothing linked to it**: reachable only by typing the
URL. `nav[]` in the manifest fixes that — a plugin declares its entrances and the shell's navigation menu
(the hamburger, left of the brand) offers them.

This plugin declares **four**, and they are the demonstration:

```json
"nav": [
  { "path": "",          "label": "Highlights",          "icon": "star" },
  { "path": "moments",   "label": "Key moments",         "icon": "clock" },
  { "path": "gallery",   "label": "Highlight gallery",   "icon": "image" },
  { "path": "unwritten", "label": "Highlights to write", "icon": "compose", "visibleTo": "podcaster" }
]
```

**They are four views of one dataset, not four features** — everything highlighted, only the moments, only
the pictures, and the episodes with nothing written yet. That is the shape worth copying: entrances are
cheap, and a visitor arriving at "Key moments" has a different question than one arriving at "Gallery".

Five things this exercises that a single-entry page does not:

- **An entrance can be role-gated.** `unwritten` is `visibleTo: "podcaster"`, and the host resolves that
  **server-side** — an anonymous caller is never sent the entry, not even hidden in the page source. Verified
  against a running instance: `GET /api/plugins/navigation` returns three sample entries anonymously and
  four to a podcaster. The component filters again for its own tab bar, because that is drawn client-side.
- **The detail route is deliberately not an entrance.** `highlight/<slug>` is a destination — a menu cannot
  hold one row per episode. An entry point is where someone *starts*.
- **Declared once, rendered twice.** The same four appear in the host's menu and as this page's own tab bar;
  sending someone back to the hamburger to change view would be worse. `frontend/src/page-entries.ts` is the
  single source, and `page-entries.test.ts` pins `plugin.json` to it field by field — a path renamed in one
  and not the other is a menu entry that silently lands on the fallback view.
- **The menu label is not translatable; the tab is.** Core has no access to a plugin's catalogs, so
  `nav[].label` is one fixed string in every language. The in-page tab uses `labelKey` and i18n. Keep the
  manifest label short and neutral.
- **`icon` draws from the same `--mc-icon-*` palette** as everything else (below). An unknown name never
  rejects the plugin — core holds no icon list on purpose — so a typo is silent on both sides. The test
  checks the names against the ones this plugin ships a rule for.

**The page is its own element** (`sample-highlight-page`), not `sample-highlight` with a flag. A tile is a
guest in someone else's layout: narrow, below the show notes, saying one thing. A page is the whole canvas.
One component serving both is either a shouty tile or a lonely card in an ocean of white — which is what
this page was before 2.11.0.

**One request, four views.** Every view reads one backend-written document, `data/site/main/index`. A
browser cannot assemble that listing: the doc surface is addressed by scope and key, so "every episode's
highlight" is one request per episode. `SamplePlugin`'s scheduled pass already walks exactly that set, so it
publishes the answer — an excerpt, the key moment, the image ref, the favourite tally — and the page costs
one GET however long the feed is. It is declared `backendOwned` beside `stats` for the same reason: a
derived listing that any podcaster could overwrite is a listing of whatever they felt like publishing.

## A valid image, refused in one browser only
An image upload that worked in Chromium failed in Firefox. The cause is worth knowing before you write your
own upload, because nothing in the plugin code looks wrong:

**`File.type` is not filled in the same way by every browser.** Chromium carries its own extension→MIME
table. Firefox asks the *operating system*'s MIME database — and where that lookup fails (a sparse
`shared-mime-info` on Linux, a missing or hijacked registry association on Windows, an extension the
platform simply doesn't know) it hands over `File.type === ''`. `FormData` then sends the part as
`application/octet-stream`.

The host checks in this order (ARCHITECTURE §11.1): **size, declared type, actual type, quota**. The
declared type is checked *before the bytes are read*, so a perfectly valid PNG is refused as a type the
plugin may not store — and the sniffer that would have vindicated it never runs. Measured against a running
core with one byte-identical PNG:

| `file.type` | result |
|---|---|
| `image/png` | **201** stored |
| `""` | **415** `content type 'application/octet-stream' is not one this plugin may store` |

`blobs.upload(file)` restores the claim from the file's extension before uploading. **Guessing is safe here
and would not be safe elsewhere:** it does not decide what the file *is* — the host still sniffs the leading
bytes and refuses anything whose content disagrees. A wrong guess becomes the same 415 it would have been,
never a stored file of the wrong kind. An extension nothing maps is passed through untouched, so the refusal
keeps the host's own wording.

**This plugin used to carry that fix itself**, as a `declaredType(file)` helper plus a private
extension→MIME table, and it was deleted in 2.12.0: the SDK normalises the declared type by default since
0.9.0, and ARCHITECTURE §11.1 now states the reasoning in the spec rather than leaving each plugin to
rediscover it. Pass `{ declaredType: 'preserve' }` if you specifically want the browser's raw value. The
episode above is left in this README because it is the *why* — the code is gone, the trap is not.

The `accept` attribute has the same weakness — a browser filters its own picker with that same MIME
database — so it lists extensions alongside types: `accept="image/png,…,.png,.jpg,.jpeg,.jfif,.webp"`.

## Icons come from the host, and not through `ctx` (core 0.6.15)
`frontend/src/icons.tsx` draws the **shell's own icon set** — `--mc-icon-edit`, `--mc-icon-play`,
`--mc-icon-star`, … (ARCHITECTURE §12.3). The delivery mechanism is the interesting part: they are plain
CSS custom properties declared on the host document's `:root`, and custom properties **inherit through the
shadow boundary**. So a Web Component reads them with **no SDK import, no `platformApi` bump and no version
skew** — this plugin builds against SDK 0.9.1 and will pick up an icon a *later* core release publishes,
the day it lands. That is precisely why they aren't on `ctx`: putting them there would make every new icon
an SDK release plus a manifest bump for every installed plugin.

Three rules, all of them load-bearing — and **all three are the SDK's since 0.9.0**:

```ts
export const ICON_CSS = `${iconCss(ICON_NAMES, { className: 'mc-icon' })}\n${ICON_LAYOUT_CSS}`;
```

1. **Mask, never `background-image`.** `currentColor` behind a mask means the icon takes the colour of the
   label beside it and re-themes with everything else. A `background-image` bakes in the artwork's own
   colour (black), which vanishes on a dark `--mc-surface`.
2. **Every reference needs a fallback, and `none` is the wrong one.** An unresolved `var()` makes the
   declaration invalid at computed-value time, so `mask-image` reverts to its initial `none` — an
   *unmasked* element painting `currentColor` across its whole box. The failure mode of a missing icon is
   a **solid square**, not a blank space. `iconCss` emits a blank SVG instead, so a host predating the icon
   set renders nothing and the label carries on alone. `icons.test.tsx` pins this per name.
3. **Never declare into `--mc-*` yourself.** That prefix is the host's namespace; defining into it would
   shadow the real token for your subtree the moment core publishes one. A test asserts this stylesheet
   declares no `--mc-` property at all.

**What 2.12.0 deleted, and what it kept.** `icons.tsx` was about a hundred and thirteen lines of
hand-written CSS — the version every plugin copied, and the one where rule 2 was routinely written as
`mask-image: none`. `iconCss(names)` owns it now. Two things stayed here because they are genuinely local:
a **narrowed** `ICON_NAMES` array, so `<Icon name="edt" />` is a compile error (the SDK's `KnownIconName`
stays deliberately *open*, because closing it would pin the icon set to an SDK version and undo the
no-skew property above — narrowing it is the plugin's call, not the contract's); and one layout rule, since
whether an icon may shrink in a flex row is this plugin's taste rather than the contract's business.

**The follow-on change is the one worth copying.** Before this, the marks lived *inside* the translated
strings — `"moment.jump": "▶ Jump to {{time}}"`, `"fav.on": "★ Favourited"`, `"browse.back": "← Back to all
highlights"`. That made presentation into something a translator could alter, drop, or mirror wrongly for
an RTL locale, and rendered as whatever emoji font the visitor's platform happened to ship. Both catalogs
are now sentences only; the mark comes from CSS at the call site, and a test walks `en.json`/`de.json` to
keep them that way. **An icon is not a word.**

Every icon here is decorative and `aria-hidden`, sitting beside a real label — announcing it too would read
the meaning twice. The only stateful one is the favourite star (`star`/`star-on`), which still never carries
the state alone: `aria-pressed` and the label both change with it. And because the icon element has empty
`textContent`, the tests elsewhere in this repo go on finding buttons by their exact label.

One packaging note: `ICON_CSS` is a **string**, concatenated into each component's `<style>` rather than
shipped as a CSS file. Each of this plugin's elements renders into its own shadow root, and a bundled
stylesheet would land in the host document where it could reach none of them. `HighlightModal` portals into
a *second* shadow root, so it repeats the rules — the `--mc-icon-*` values themselves still arrive from
`:root` either way, which is the whole point of shipping artwork as tokens.

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
| `blobs()` | New in 0.8.0 — the scheduled recompute also **sweeps orphaned images**: it collects every `image.ref` the highlight docs still name, pages `blobs().list(…)`, and deletes the rest. Nothing on this platform collects orphans, and a blob outlives the document that named it, so without this every swapped picture leaks a file. The frontend deletes the ref it just stopped pointing at; this is the net under it, for the tab closed mid-edit and the `remove` that failed. See [below](#the-sweep-can-only-collect-what-the-backend-can-enumerate) for the constraint that shapes it. |
| `locales()` | New in 0.10.0 — the recompute pass reads `contentLocales()`/`defaultLocale()` once per pass (a registry an admin edits, so re-reading it mid-walk would let a setting change halfway through), and runs **`isContentLocale(code)` on every `translations` key it reads**. Those keys are client input: they sit inside a JSON value, so the host's doc-key pattern never sees them. A key that fails is **counted and left alone** — see [below](#two-locale-lists-and-picking-the-wrong-one-is-silent-sdk-0100) for why deleting would be the wrong call. |
| `translation()` | New in 0.10.0 — the same pass **drafts** the languages nobody has written yet into a separate `backendOwned` `drafts` document the edit modal offers and a reader never sees. `null` on the manifest alone here: `usedBy` is browser-only, because a backend runs on a timer with no visitor and no role. `TranslationException` is **checked**, and `retryable()` decides whether the pass stops or moves to the next language. Capped at five calls a pass — this runs unattended, on somebody else's metered API. See [below](#machine-translation-is-a-draft-and-says-so-twice-sdk-0110). |
| `users()` | New in 0.13.0 — `metaFor` resolves the highlight's stored `authorId` to a display name for the OpenGraph description, per request and **never stored**. `null` unless the manifest declares `identity`. `resolve` omits an id it cannot answer for rather than returning a tombstone, so the byline simply disappears when its author does. |
| `notifier()` | New in 0.14.0 — the scheduled pass tells everyone who favourited a highlight when it gains a language they can now read it in. `null` unless the manifest declares `notifications`. `NotificationException` is **checked**, and `retryable()` decides whether the announcement is held for a later tick or written off. It is `notifier()` and not `notify()` because `Object.notify()` is `final` in Java. See [below](#the-one-surface-that-writes-into-somebody-elses-site-sdk-0140). |
| `schema()` | Not used — the manifest is the one place a plugin says which store it uses, and this one declares `"storage": "doc"`, so `schema()` is `null` by contract. It is `null` for every plugin that does not declare `storage.schema`; the doc store is the default and covers nearly everything, which is why the reference plugin uses it. Exercising `SchemaStore`/`Criteria` would mean changing what this plugin stores, not adding a call. Same story on the frontend — see `ctx.schema` above. |
| `config()` | `refreshIntervalMinutes` — read and passed to `onSchedule`. Genuinely admin/podcaster-editable today via core's generic config-admin form (`PUT /api/admin/plugins/sample/config`) — see "Two ways to be configurable" below. |
| `feeds()` | `episodesIn(Scope.site())` for the stats aggregate and the sitemap; `display(refId)` for the deep link's OG title/artwork. |
| `onSchedule` | Recomputes the highlighted-episode count (and how many have a key moment), prunes contentless docs, and rolls up per-visitor favourites, every `refreshIntervalMinutes`. |
| `tags()` | New in 0.9.0 — the recompute pass **reconciles** each episode's tags onto this plugin's own subject (`highlight:<slug>`), adding what the feed carries and removing what it has dropped. `null` when the manifest declares no `tags` block, so the pass is guarded exactly as the blob sweep is. It never calls `tagEpisode`, which would need a second declaration this plugin does not ask for. |
| `logger()` | New in 0.4.0 — an SLF4J `Logger` named `plugin.sample` by the host. `WARN` on a non-positive `refreshIntervalMinutes` (clamped, not trusted) and on a stored highlight doc with a missing/blank `markdown` field (skipped, not crashed on); `INFO` on registration and on every recompute, with the counts. |

`SamplePlugin` also implements **all five optional** backend extension points a plugin may add alongside
`PluginBackend` (ARCHITECTURE §7.4), the same single-class pattern the wiki plugin is documented to use.
That is a packaging choice and not a requirement — each is an independent `ExtensionPoint` and most plugins
implement none of them; they live together here because they share one context and one predicate.

- **`ShareMetadataProvider`** — `metaFor("highlight/<slug>")` returns the episode's real title (from
  `ctx.feeds().display()`), a plain-text excerpt of the highlight markdown, the episode's artwork,
  (0.12.0) the language that excerpt is written in, and (0.13.0) the author's **current** display name,
  resolved through `ctx.users()` at request time and never stored. See
  [below](#saying-what-language-a-page-is-in-sdk-0120) and
  [below](#a-byline-that-outlives-its-author-sdk-0130).
- **`SitemapProvider`** — `urls()` lists a `SitemapUrl` for every episode that currently has a highlight,
  each carrying (0.12.0) the `hreflang` group of languages that highlight can actually be read in. See
  [below](#saying-what-language-a-page-is-in-sdk-0120).
- **`PageRouteProvider`** (0.9.1) — `hasRoute(subpath)` tells the host which subpaths under `/p/sample/`
  are real, so a typo or a deleted highlight gets a genuine 404. See
  [below](#unknown-subpaths-are-real-404s-now-sdk-091).
- **`SearchProvider`** (0.9.0) — puts highlights into the site's own `/api/search`, and gates a
  podcaster-only hint to a podcaster. See [below](#plugin-content-in-the-sites-own-search-sdk-090).
- **`UserDataHandler`** (0.9.0) — repairs the three published documents that counted a departing account's
  favourites, and exports what that account marked. See
  [below](#what-a-plugin-owes-a-departing-account-sdk-090).

All five are unit-tested directly in `SamplePluginTest` — the last three through the 0.9.x harnesses
(`PageRouteProviderHarness`, `SearchProviderHarness`, `UserDataHandlerHarness`), which exist because each
interface has one failure an author reliably writes by hand incorrectly. The first two are genuinely
exercised end-to-end by core (see "Deep links need a `page` slot" below) — `/p/sample/highlight/<slug>`
really answers with `metaFor`'s OpenGraph tags, and `/sitemap.xml` really carries `urls()`'s entries.

## A byline that outlives its author (SDK 0.13.0)

A plugin that aggregates across people reads `OwnedDocEntry(userId, …)` on the backend and gets **UUIDs and
nothing else**. Before 0.13.0 there were two ways to render a person from that, and both were wrong: copy
display names into the plugin's own store, or show raw UUIDs. §8.8 fills the gap with a **lookup rather than
a wider `ctx.user`** — the host still resolves access, and what a plugin learns about somebody else stays
exactly a name, an avatar path and a role. Never an email, never a provider, never an `external_id`.

This plugin stores an `authorId` on each highlight and resolves it at render:
`components/Byline.tsx` for one, `HighlightPage.tsx`'s credit strip for a whole listing.

### Store the UUID, resolve at render

A display name copied into a plugin's own documents **outlives the rename meant to shed it and the erasure
meant to end it**, and core cannot repair either — it provisioned this plugin's storage without ever learning
which field holds a person. So the rule is unenforceable by the host, which is exactly why the lookup exists.
The visible payoff is small and immediate: a rename shows up on the next paint rather than the next time
somebody edits the highlight.

### Absent, not redacted — and this is the part to get right

`resolve` **omits** an id that is unknown, erased or pseudonymised (§12.8). No `null` element, no tombstone.
So the result is **not index-aligned with what you asked for and may be shorter**:

```ts
const people = await ctx.users.resolve(ids);
const byId = new Map(people.map((p) => [p.id, p]));   // match on id, never on position
```

Reading it positionally is not a style preference — it silently attributes one person's highlight to another
the first time a single author deletes their account. `useAuthors` returns the `Map` and never the array, so
there is no index at any call site to get wrong. The rows keep their tallies either way: the aggregate stays
true while the person becomes a placeholder, which is the property §8.8 was written to give a leaderboard.

`avatarUrl` needs no fallback. Every user has one — the host generates it from the UUID when there is no
provider picture (§8.7) — and it is always the host's own `/api/users/{id}/avatar`, never a provider URL,
because core **proxies the bytes rather than redirecting**. A Discord snowflake therefore never reaches the
page source, which is the only reason a picture can be handed to a plugin at all. Same-origin, so no CSP host
and no consent category.

### A byline is not an authorization fact

`authorId` lives in a **shared-scope document**, and a shared-scope document has no owner: anything above
`data.writableBy` could `PUT` any UUID there, exactly as it could rewrite the prose next to it. Nothing in
this plugin decides anything on it. The user ids it genuinely knows to be true are the ones the *host*
resolves from a partition — the `fav:` marks `queryAcrossUsers` reads, where the owner comes from the
partition the document sits in and never from a client.

It is also **preserve-or-set**, not overwrite: a second podcaster fixing a typo is not the author.

## The one surface that writes into somebody else's site (SDK 0.14.0)

Everything else a plugin touches is its own scope or the current visitor's. `ctx.notifier()` puts a message
in **another user's inbox**, and that asymmetry is the whole design of §17.

The trigger here: **a highlight you favourited gains a language you can now read it in.** That is the only
natural one in this plugin — the star button does not render without a highlight, so "a highlight appeared
for an episode you saved" is not a reachable state. It is also the best pairing, for the reason below.

### One finished sentence per language, sent up front

`NotifyMessage.text` is a `Map<locale, String>`, not a translation key and not one rendered string:

```java
new NotifyMessage(Map.of(
        "en", "The highlight you saved for \"The Kraken\" is now available in Deutsch.",
        "de", "Das Highlight, das du dir für „The Kraken“ gemerkt hast, gibt es jetzt auf Deutsch."),
        "highlight/the-kraken");
```

**A key cannot work.** A plugin's catalogs ship inside its *frontend bundle* (§12.7) and load when its Web
Component mounts; the bell is shell chrome and renders on pages where that never happens. There is no
plugin-scoped catalog endpoint and no manifest field naming one, so a key would reach a reader as the literal
string. **One rendered sentence is worse**: a notification written on a timer is read days later by somebody
whose shell may have changed language since, so it would freeze the language at send time on the one surface
where that is most obviously wrong.

Which is why this plugin's backend keeps its announcement wording in a `NOTIFY_TEMPLATES` constant beside the
code that sends it rather than in `locales/*.json`. A backend on a timer has no reader, no mount and no
access to those files. `en` is mandatory — §12.7 makes English the one language a site cannot switch off, so
it is the only terminal fallback, and `NotifyMessage`'s constructor refuses a map without it.

The honest cost: the set of languages is fixed at **send** time. A language the operator adds next month
cannot appear in a message already written, and those readers see the English.

### Two bounds you cannot move, and one you have to write

- **Eligibility is the host's**, and here it is satisfied by construction: a favouriter has a `USER`-scope
  row, which is the same partition the host checks. No plugin can reach a user who never touched it.
- **Rate limits are the host's** — per recipient per window, plus a ceiling. `notifications.perUserPerDay` in
  the manifest is what the plugin *asks* for; the operator's cap is what it gets. There is no counter to
  read, because a limit a plugin enforces is a limit a plugin can drop.
- **Partial sends are yours to notice.** `send` answers *who was actually notified* rather than resolving
  `void`, because an account erased since the mark was written is the ordinary case and one stale participant
  must not cost the other forty-nine theirs. A write whose partial failure is invisible degrades in silence:
  a plugin working from a stale list notifies nobody and looks exactly like one working perfectly. This one
  compares what came back against what it asked for and logs the difference.

`link` is host-validated and **internal only** — a `ctx.links`-shaped path or a subpath of this plugin's own
`/p/sample/` subtree. A notification is chrome the site is speaking through, and a plugin that could aim it
anywhere could phish the site's own users in the site's own voice.

### Seeded on first sight, never backfilled

The `announced` document (per episode, `backendOwned`) records which locales have already gone out. The first
pass that sees an episode **records what it has and tells nobody**. Treating an absent record as "nothing
announced yet" would fire one notification per existing translation at every existing favouriter the moment
this version is installed — a spam cannon dressed as a migration. It is `backendOwned` for the mirror-image
reason: a client that could write it could silence an announcement, or clear it and make the backend announce
everything twice.

A `RATE_LIMITED` refusal is `retryable()`, so the record is **not** advanced and the next tick tries the same
episode again. `INVALID_LINK` / `INVALID_MESSAGE` are bugs in this plugin that will fail identically next
tick, so the record *is* advanced — a plugin retrying a malformed link forever is one nobody can drain.

### Two capabilities this plugin declines, and why

- **No favouriter avatars.** The trustworthy user ids here are the favouriters', not the author's — they come
  from `queryAcrossUsers`, host-resolved from the partition. Publishing them as an "also favourited by" row
  would have been the textbook §8.8 leaderboard. It is not here because the whole `data/user/me/fav:<slug>`
  design rests on a mark being unreachable from any browser but its owner's, and publishing the list would
  undo that with the plugin's own hands. Notifying somebody is not the same as naming them to a stranger: the
  host delivers to the addressee, and §17 gives a plugin **no read side at all**.
- **No `ctx.notify` from the browser.** It exists and this manifest declares `notifications`, so the field is
  non-null here — but nothing a visitor does in this plugin is news to anybody else. §17's own guidance is
  that nearly all real use is on the backend, because the thing worth announcing finishes on a timer.

The same restraint as `tags.writesEpisodes: false`: what a reference plugin does *not* ask for is part of what
it demonstrates.

## Two locale lists, and picking the wrong one is silent (SDK 0.10.0)

`ctx.locale` carries two of them, and the whole reason there are two is that they routinely disagree:

| | What it is | Who reads it here |
|---|---|---|
| `available()` | the languages the **shell can render in** | `AdminSettings.tsx`, to show the contrast |
| `content()` | the languages **text may be authored in** | `TranslationEditor.tsx` — everything editorial |

Neither is a subset of the other. A site can require a Dutch imprint without offering a Dutch UI, and it can
ship a UI catalog for a language it never wants prose written in. Both are the host's live answer: languages
became a **runtime registry** in core 0.6.23 — an operator drops a catalog into `MOSAICAST_LOCALES_DIR` and
enables it — so a plugin that hardcoded a language list is simply wrong, and one that cached either list is
wrong the moment an admin edits it.

**The failure mode is that there isn't one.** An editor built from `available()` renders a perfectly
plausible tab bar. It just offers a language nothing reads back and hides the one the operator actually
asked for, and nothing anywhere reports it. That is why `TranslationEditor.test.tsx` runs against a site
whose two lists deliberately differ (`available: en, nl` / `content: en, de`) rather than against the
easy fixture where they match — the easy fixture passes either way.

On the backend the same pair is `ctx.locales()`, and `Locales.isContentLocale(code)` is the check to run
before storing anything per language. `SamplePlugin` runs it on every `translations` key it reads, because
**those keys are client input**: they live inside a JSON value, so the host's doc-key pattern never sees
them and nothing validated them on the way in.

What it does about a key that fails is the more interesting half — it **counts it and leaves it alone**. A
stranded locale means one of two things this code cannot tell apart: somebody forged a key, or an admin
disabled a language a podcaster had legitimately written prose in. Deleting handles the first and destroys
somebody's work in the second — and the first is already harmless, because the frontend only ever *looks up*
a locale the host handed it, so a forged key has no path to a reader at all. The count surfaces to a
podcaster on the site tile; the decision stays with a person.

## Machine translation is a draft, and says so twice (SDK 0.11.0)

The site's admin picks a translation provider, or none; the host owns it, its credentials and its cache, so
two plugins translating the same paragraph cost one call and no plugin ever ships an API key. Reaching it
takes a manifest block:

```json5
"external": { "kinds": ["translation"], "usedBy": "podcaster" }
```

**Three gates, and only the first is yours.** Without that block `ctx.translation` is `null` no matter what
the operator configured — and `null` for the operator's own reason too, which is every site by default. The
two are **deliberately indistinguishable at runtime**, so the rule of thumb is: *unexpected `null`? check the
manifest before the admin panel.* `available()` is the second gate and is advisory only, which is why it
disables the button and the `catch` still exists. `usedBy` is the third: the host enforces it **at the call**
as a 403, so a low-privilege visitor can hold a non-`null` handle whose `translate()` refuses. A non-null
handle is not permission.

`usedBy: "anonymous"` is legal here — unlike `data.writableBy`, because a self-hosted LibreTranslate costs
nothing per call — and core loads it with a warning. It would still be wrong for this plugin: only a
podcaster writes a highlight, so only a podcaster has anything to translate.

**Never cache the handle.** Half the gate is an admin setting that can change under a running plugin, so
`TranslationEditor` reads `ctx.translation` inside the click handler rather than at render.

### Labelled twice, for two different people

The contract says machine output is a draft and must not be passed off as an original. This plugin reads
that as two separate obligations, and they are stored differently:

- **The podcaster** gets an unconfirmed badge the moment a translation lands, and it lasts until they press
  Save. It is component state and is **never stored** — "a human has looked at this" is a fact about a
  session, and persisting it would hand tomorrow's editor a confirmation nobody gave.
- **The reader** gets `machineTranslated`, which **is** stored and does show up in the tile. Clearing it on
  save would be exactly the misattribution the rule exists to prevent: someone reading a paragraph is
  entitled to know an engine wrote it. Typing into the field clears it — at that point the words are the
  podcaster's, and the flag would be misattribution in the other direction.

A failure is **shown, never swallowed into the untranslated string**. This is the one call in the plugin
where falling back to the input would be actively harmful: the podcaster would save English into the German
tab and every German reader would be told it had been translated for them.

### The backend drafts; it never publishes

`SamplePlugin`'s scheduled pass calls `ctx.translation()` too, and writes what comes back to a **separate,
`backendOwned` `drafts` document** that only the edit modal reads. Not into `highlight.translations`, ever:
a scheduled job writing there would publish machine prose to every reader of that language with no human
anywhere in the loop, and would do it again after each edit.

The payoff is that the common case costs nothing at the moment somebody is waiting — the schedule ran
overnight, the host cached it, and the podcaster opens the editor to find the suggestion already there. Each
draft carries the **hash of the source it was made from**, so a suggestion is withheld once the original has
been rewritten: a faithful translation of a paragraph that no longer exists is worse than no suggestion,
because it reads as current. (`javaStringHash` in `highlight-doc.ts` reproduces `java.lang.String.hashCode`
so the two runtimes agree — `| 0` per step, or JavaScript's doubles diverge past 2^53 and every draft looks
stale.)

Two restraints in that pass are worth copying:

- **A budget** (`DRAFTS_PER_PASS = 5`), because this runs on a timer with nobody watching and an unbounded
  walk over a long feed is how a plugin spends a site's whole translation allowance overnight.
- **`TranslationException.retryable()`, not the message.** A `RATE_LIMITED` does not become untrue for the
  next episode, so the pass stops; a `MISCONFIGURED` is a fact about one provider setting, so it tries the
  next language. Matching on English wording instead is how a plugin breaks the day the host rewords a log
  line — which is why `reason()` is an enum. And the exception is **checked**, deliberately: somebody else's
  service refusing is a routine outcome, and the compiler is the cheapest place to discover a plugin has not
  decided what to do about it.

## Saying what language a page is in (SDK 0.12.0)
Core can serve any page as `?lang=de`, and `sitemap.xml` emits reciprocal `hreflang` alternates with
`x-default` on the bare URL (§6.6, §12.7). Until 0.12.0 a plugin could not join in — and core's refusal was
deliberate rather than an oversight. It **cannot read a plugin's documents**, so it does not know which of
them exist in which language; assuming the site's UI languages apply to content it cannot see would be a
guess published to crawlers as a fact. So it emitted *no* alternates for plugin entries at all.

0.12.0 adds the two components that let a plugin answer for itself, and this plugin uses both.

### `SitemapUrl.alternates` — a map of paths, not a list of codes
`SamplePlugin.urls()` now returns, for a highlight that has been translated:

```java
new SitemapUrl("/p/sample/highlight/the-kraken", null,
        Map.of("en", "/p/sample/highlight/the-kraken", "de", "/p/sample/highlight/the-kraken"));
```

Both values are the same path, because this plugin renders **one path per language** — the German reader and
the English reader are at the same URL and the host adds `?lang=de` itself. A wiki whose German article lives
at `/p/wiki/artikel` and whose English one lives at `/p/wiki/article` maps each code to its own path, which is
why the component is a map and not a list of codes. Note the entry for the page's *own* language: it is not
redundancy, it is the plugin naming the language `loc` is written in — the one thing the host has no way to
know — and `SitemapUrl` throws without it.

**The filter is threefold, and dropping any one of the three publishes a lie:**

1. the translation exists and is not blank — a language tab the podcaster opened and left empty is stored
   either way, and is not a translation;
2. `ctx.locales().isContentLocale(code)` — these keys sit *inside* a JSON value, so the host's doc-key
   validation never saw them. They are client input. A forged key is unreachable in the UI, which the
   frontend can afford to shrug at; a forged key in `sitemap.xml` is this plugin telling Google a language
   exists;
3. the code is in `ctx.locales().available()` — **the reason the two locale lists exist**. An operator can
   permit text to be *authored* in Dutch without offering a Dutch *UI*, and there is no `?lang=nl` on such a
   site: the URL resolves to the default and the alternate contradicts its own `hreflang`. Core applies
   exactly this filter to its own legal pages, and explicitly does not apply it to a plugin's entries.

A highlight nobody translated gets the two-argument constructor and **no** alternates — the pre-0.12.0
behaviour, and the honest answer. "This page exists, in one language" is not a translation group.

`SitemapProviderHarness` (new in the test kit) collects the entries and reports what the host would drop or
contradict: a `loc` or alternate outside `/p/sample/`, a hand-written `?lang=`, a duplicate location, and the
one no single entry can see — two entries in one group declaring *different* groups, which is what a
half-updated slug map looks like. `assertTrue(sitemap.problems().isEmpty())` is the assertion worth writing.

### `OgMeta.locale` — and why this plugin leaves it unset
This one the sample got **wrong first**, and only a running core said so. The reasoning that looked right
was: `metaFor(String subpath)` receives a subpath and nothing else, so it always excerpts the default-locale
`markdown`; naming a locale is a claim about the text in the record; therefore name the default.

Then `curl "…/p/sample/highlight/<slug>?lang=de"` came back with `og:locale=en_US` and `<html lang="en">` —
on exactly the URL the sitemap had just told a crawler was the German one. **One plugin, two contradictory
claims about one URL.** Every unit test passed either way; nothing but the live instance shows it.

`OgMeta.locale` is for a page written in **one fixed language** — core's own comment in
`PluginPageController` is "a German article stays German for an English visitor". This page is the opposite:
it renders whichever translation the shell's locale picks. So it says nothing, the host's resolved locale
stands, and `?lang=de` gets `og:locale=de_DE` and `lang="de"` to match the alternate:

```java
new OgMeta(snapshot.title(), excerpt(highlight.markdown()), snapshot.artwork());   // 3-arg: "the host decides"
```

**What stays imperfect** is the description: `metaFor` cannot see the requested locale, so the excerpt is the
default language's even on the German URL. The title comes from the feed and does not vary, and the
description is 160 characters of preview text — a smaller residue than the contradiction the alternative
buys. Fixing it properly needs the requested locale in the signature; that is the contract's to change, not
this plugin's to work around.

### The half that is easy to forget
Declaring alternates is a promise about what the URL serves, so the page had to keep it. `HighlightPage.tsx`'s
detail view rendered `doc.markdown` regardless of locale until 2.14.0 — the episode slot resolved
translations, the deep-linkable page did not. It now runs the same `resolveHighlightText`, carries `lang` on
the content element, and shows the same two provenance notes. **The sitemap entry and the page it points at
have to be the same fact**; getting one right and not the other is worse than declaring nothing — which is
the same lesson `OgMeta.locale` taught above, from the other end.

### Verified against a running core
`dev/instance.sh up --plugins` in the core checkout, one highlight translated into German and one not:

| Checked | Result |
|---|---|
| `sitemap.xml`, translated highlight | `hreflang="en"` (bare), `hreflang="de"` (`?lang=de`), `x-default` (bare) |
| `sitemap.xml`, untranslated highlight | bare `<loc>`, **no** alternates |
| `?lang=de` page | `<html lang="de">`, `og:locale=de_DE`, German prose with `lang="de"` on the content |
| `?lang=de` on the untranslated one | English prose, `lang="en"`, and the "not available in your language" note |
| German demoted to **content-only** (`uiLocales: ["en"]`) | alternates disappear — no `?lang=de` to point at |
| German re-enabled | alternates return **without a restart**; languages are a runtime registry (§12.7) |

## Unknown subpaths are real 404s now (SDK 0.9.1)
Declaring a `page` slot reserves `/p/sample/*` — and until 0.9.1 **every** subpath under it answered
`200`. A mistyped slug, a highlight deleted last year and `/p/sample/nonsense` all rendered this plugin's
not-found view inside a success. That is a soft-404: a crawler indexes your typos and your deleted pages,
and there is nothing in the response to say otherwise. ARCHITECTURE §6.6 rules it out for core's own routes
("real HTTP 404s for unknown episodes/routes, no soft-404") and the plugin subtree was the exception.

The host cannot fix this alone: core knows a `page` slot was declared and cannot know what the plugin
renders. `PageRouteProvider` is the plugin answering:

```java
@Override public boolean hasRoute(String subpath) {
    if (!subpath.startsWith(HIGHLIGHT_SUBPATH_PREFIX)) return PAGE_SUBPATHS.contains(subpath);
    String slug = subpath.substring(HIGHLIGHT_SUBPATH_PREFIX.length());
    return !slug.isBlank() && publishableHighlight(ctx, slug).isPresent();
}
```

Four things this plugin had to get right, and each is a comment in the source:

1. **The root is a route.** `subpath` is `""` at `/p/sample/`, so `PAGE_SUBPATHS` contains the empty
   string. A provider written as a lookup over its own content answers `false` there and 404s its own
   landing page. `PageRouteProviderHarness` probes the root whether the test lists it or not, for exactly
   this reason.
2. **Do not reuse `ShareMetadataProvider`.** It is the tempting shortcut and this repo is the counterexample:
   `metaFor` returns empty for `moments`, `gallery` and `unwritten` **on purpose** — they are views with
   nothing to tell a link scraper — so reading "no share metadata" as "no page" would 404 three working
   entrances straight out of `nav[]`. `metaFor` says how to describe a page; `hasRoute` says whether it
   exists.
3. **It runs on a request.** A lookup, not a scan. A provider that throws is logged and skipped and the
   route answers `200` — a broken plugin must not turn a working page into a 404 — so the failure is
   invisible from a visitor's side and only the tests will tell you.
4. **The body has to agree with the status line.** The page's `matchRoute` miss branch used to render the
   index, which was the least-bad answer when the host was going to say `200` regardless. Now it renders a
   real not-found view. Answering `404` while showing someone a working index would be the same lie in the
   other direction.

**Anything you forget to claim here disappears from search results.** That is worth saying out loud before
shipping it, and it is why `PAGE_SUBPATHS`, `PAGE_PATTERNS` and the manifest's `nav[]` are pinned to each
other by tests on both sides.

## Plugin content in the site's own search (SDK 0.9.0)
Core searched episodes and nothing else, so a plugin with searchable content grew a second search box on
the same site — right for its own data, wrong for a visitor, who then had two places to type the same query
and no way to learn the answer was in the other one. `SearchProvider` contributes to `/api/search` instead
(ARCHITECTURE §6.7).

**Results are grouped by source, never merged.** A plugin's `score` and Postgres `ts_rank` are not on one
scale, and interleaving them produces a ranking nobody can explain and one that changes meaning whenever a
plugin changes how it scores. So do not tune the score hoping to outrank an episode; it orders your section
and nothing else.

**Access is the plugin's job here — the one place in this contract where it is.** Everywhere else the host
resolves access and the plugin consumes the result, but core has no model of a plugin's objects and cannot
know that `unwritten` is a podcaster's view. So the caller's role arrives as a parameter, and a provider
returning something the caller may not see has leaked it with nothing else to catch that. Two traps:

- **`role` is `null` for anonymous**, not a fourth enum constant. `SearchProviderHarness` calls the provider
  once per role *including* that one, because it is the test an author writes by hand incorrectly.
- **It runs on a request, with a budget.** A section that misses its budget comes back *marked* rather than
  dropped — "found nothing" and "did not answer" are different answers, and a visitor given the first
  concludes the content is not on this site. This plugin reads the one `index` document its backend already
  publishes rather than walking every episode, which is what keeps it a lookup.

Titles are resolved live through `ctx.feeds()` and deliberately **not** cached into that index: a snapshot
is overwritten on every feed refetch (§4.2), so a copy stored beside the excerpt would be a second, staler
answer to a question the host already answers.

## What a plugin owes a departing account (SDK 0.9.0)
ARCHITECTURE §12 has always promised that plugin contributions are pseudonymised on account deletion —
"cut the identity link, aggregates/leaderboard stay correct". Core cannot keep that promise on its own: it
cannot find a plugin's contributions, and it cannot know that pseudonymising is right where deleting is
not, because that judgement belongs to whoever designed the data. §12.8 is the mechanism, and
`UserDataHandler` is the hook.

**What core already does.** The `USER` scope is host-owned, so core drops this visitor's
`fav:<episodeSlug>` marks itself — those need no asking. That is the easy half, and it hides the hard one.

**What only this plugin can do.** Three *published* documents counted those marks: every episode's
`favourites`, the site `stats` total, and each `index` entry's own count. Left alone they would keep
serving a deleted account's contribution until the next scheduled tick — up to `refreshIntervalMinutes` of
telling visitors a number that includes someone who asked to be gone.

```java
@Override public void eraseUser(String userId) {
    recomputeHighlightStats(ctx, UUID.fromString(userId));   // republish, excluding them
}
```

Three properties worth copying:

- **A whole recompute, not three patches.** Three documents embed the count, and patching each is three
  chances to disagree with the others. Republishing from the store is one code path that was already
  written and already tested. More work than an account deletion strictly needs, and a good trade for a
  rare operation that must not be subtly wrong.
- **Idempotent by construction.** A failed erasure is *retried*, so this may be called again on data it
  already handled. It does not decrement anything; it recomputes while skipping one user, which yields the
  same answer however many times it runs. `UserDataHandlerHarness.eraseTwice` is that test — and note it
  would not catch a handler that decrements, which succeeds twice and is wrong the second time, so
  `SamplePluginTest` asserts the resulting count too.
- **Throw when you could not finish.** The host writes a row per plugin *before* it asks and leaves an
  **open record** on a failure rather than a log line, then retries and surfaces it in admin. Swallowing an
  error to report success is the one thing this method must not do.

`exportUser` is defaulted to empty on the interface so erasure could ship alone. Overriding it is worth it
when the plugin can say something core cannot — here that is the **titles**: core can dump
`fav:the-kraken → true` on its own, but it does not know that `fav:` is this plugin's key convention or
that the rest of the key is an episode slug.

## Tags are one vocabulary several writers share (SDK 0.9.0)
Tags existed in core only as a feed-derived filter axis with no vocabulary and no plugin surface, so every
plugin that wanted them grew a private free-text column — and a wiki's `lore` and an episode's `lore` were
unrelated strings that could not be linked, suggested or counted together. ARCHITECTURE §6.1.1 makes it one
vocabulary with **provenance**: every assignment carries its source (`feed`, `manual`, `plugin:<id>`).

This plugin's backend mirrors an episode's tags onto its own subject (`highlight:<slug>`) on every
recompute, and `HighlightTags.tsx` renders them, each linking to core's *own* filtered feed view via
`ctx.links.feed(slug, { tag })`. A plugin consumes filter axes and never defines them, so the destination
has to be the host's rendering of the same word rather than a listing this plugin invented.

Four rules from §6.1.1 that are visible in the code:

- **The host owns the canonical key; `label` is presentation.** Send any spelling — the host trims,
  collapses whitespace and casefolds, and keeps the label from first use. So `Maritime`, `maritime` and
  `maritime ` are one tag whose readable form is still `Maritime`. **Display `label`, compare on `tag`.**
- **Reconcile your own subject, do not merely add.** A tag the feed has since dropped is removed with
  `untagSubject`, which is legitimate precisely because the subject is this plugin's own — §6.1.1 forbids
  removing *another writer's* assignment, and nobody else writes here.
- **The two counts are scoped differently.** `TagInfo.episodes` is site-wide; `TagInfo.subjects` counts only
  *your* subjects, because you cannot see the size of a store you cannot read. Showing them side by side
  without saying which is which reads as an inconsistency, so this shows one.
- **Tagging an episode is a capability, not a convenience.** It changes the shell's filter options *and*
  what core recommends beside that episode, so it needs a second manifest flag. **This plugin declares
  `"writesEpisodes": false` explicitly** rather than omitting it: the sample does not classify episodes, so
  it does not ask for the right to, and writing the `false` down keeps that restraint visible in the file
  people copy. `FakeTags` throws on an episode write without the flag, so a plain test run is itself the
  assertion that this plugin never reaches for one.

## The page draws real episode cards now (SDK 0.9.0)
`DisplaySnapshot` and `resolveArtwork` shipped in the SDK at 0.1.0 with **nothing in the contract that hands
a frontend one**. So this plugin's page drew slugs, and the workaround every plugin reached for was to
project the host's own episode data into its doc store on a schedule — a backend, a scheduled ingest, a
`backendOwned` key and a copy that is stale between runs, for fields the host already has. `ctx.feeds` is
what those two exports were for.

```ts
const displays = await ctx.feeds.displayMany([...slugs]);   // one request, not one per card
```

Three properties the code depends on:

- **The host filters, the plugin consumes.** The answer contains only what *this* visitor may see, so a
  `WITHDRAWN` or tier-gated episode is **absent rather than redacted** — telling those apart would confirm
  the existence of an episode the visitor was never shown. A missing key is therefore normal, and every
  view here falls back to the slug rather than treating it as a failure.
- **No `readableBy` gate of its own**, unusually: it returns host data the same visitor can already read
  from `/api/episodes/*`. It exists so a plugin need not know that URL shape — the argument `ctx.links`
  makes.
- **Read it live, cache per render and never per install.** The snapshot is overwritten on every feed
  refetch. That is the feature: a podcaster's title edit propagates.

`displayMany` clamps at `DISPLAY_BATCH_LIMIT` (200) rather than failing, so the extras are simply absent —
which is again indistinguishable from "filtered out", and again handled by skipping.

## `ctx.docs`, and the escape hatch underneath it
Every doc access before 0.9.0 was string concatenation against a four-segment path, with the plugin
responsible for `encodeURIComponent`, for the key pattern, for knowing that `site` is always `main` and
`user` always `me`, and for remembering that a key cannot contain `/`. This repo had three such builders and
a test asserting the encoding.

```ts
await ctx.docs.put('self', `fav:${ctx.scope.id}`, true);   // the caller's own partition
```

**`'self'` being the shortest thing to write is the design, not a convenience.** Per-user data belongs in
the `USER` scope and never in a key — a key is client-supplied, so `mark:<userId>:cell` is an
access-control decision the host cannot enforce. That is the most security-relevant convention in the whole
contract, and making the safe call the *easiest* one is the only reliable way to make a convention stick.

The client also validates keys **at the call site**, with the pattern in the message, instead of costing a
400 round-trip you then have to read the body of. Everything else is unchanged and still the host's: the
`readableBy`/`writableBy` floors, `backendOwned`, the 400 on an unknown scope, the 401 on an anonymous
`user` request.

**`ctx.api` did not go away**, and this plugin keeps exactly one call site on it — `AdminSettings.tsx` reads
and writes `data/site/main/settings` through the raw client while `Highlight.tsx` reads *the same document*
through `ctx.docs.get('site', 'settings')`. A reference plugin that used only the sugar would leave an
author guessing whether the surface underneath it was still supported. It is.

## Absence is an answer; a failure is not (SDK 0.9.0)
This repo used to end ten separate calls with `.catch(() => undefined)`. That was not laziness — it was the
only thing available. `ctx.api.get` rejects on **any** non-2xx, and 404 is the *ordinary* state of a
doc-store key nothing has written yet, so a plugin either swallowed the rejection or rendered an error on
every empty tile. Swallowing it also swallowed the 500, the 403 from the read floor and the network
failure, and reported all four to the visitor as a blank widget.

0.9.0 fixed both ends:

- **`ctx.docs.get` and `api.getOrNull` resolve `null`** for a document nothing has written. Absence stops
  being an exception, so the `catch` that remains is a real error path again.
- **Rejections carry the HTTP `status` and the host's RFC 7807 `problem` body**, so that path can say
  something true. The contract already words two different 403s apart on purpose — *the read floor refused
  you* versus *this key is `backendOwned`* — and an untyped rejection threw that distinction away.

`frontend/src/api-error.ts` turns a caught value into an i18n key plus the host's untranslatable detail.
Note it uses **`isPluginApiError`, not `instanceof`**: the error is constructed by the host and reaches a
plugin across a bundle boundary, so `instanceof` against your own copy of a class answers `false` for a
genuine one. The guard is structural, which also means a plain `{ ...new Error(), status }` in a test is not
an approximation of a host error — by the contract's own definition it *is* one.

What this changes for a person, concretely: the edit modal no longer closes over a write that never landed.
It stays open and says which refusal it was.

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

## File uploads live behind a manifest declaration (SDK 0.8.0)
Until 0.8.0 a plugin could display an image from *any* host on the web — core's CSP allows it once the
host is declared for consent — and had no way to accept one from the site's own podcaster. The honest
answer to "I drew a diagram" was "find an image host first". `ctx.blobs` closes that, and it is **opt-in**:

```json
"blobs": { "maxFileBytes": 5242880, "quotaBytes": 268435456,
           "mimeTypes": ["image/png", "image/jpeg", "image/webp"] }
```

`ctx.blobs` (and the Java `ctx.blobs()`) is `null` without that block — same shape, and same reasoning, as
`ctx.schema`. What you declare is what an operator sees you asking for, and **their numbers win**: they cap
both ceilings and intersect the type list with the install's own. So a declared plugin can still be handed
less than it asked for, or nothing at all, and this one is written to survive that — no upload UI appears,
and a highlight that already names an image renders its alt text instead of a broken `<img>`.

Four rules this plugin follows, all of them the kind you only learn by getting them wrong:

- **Store the `ref`, never the URL.** `HighlightImage` keeps `{ ref, alt }`, and the view calls
  `blobs.urlFor(ref)` at render time. The ref is the identity; the URL is derived, and the host is entitled
  to change how it shapes one. A persisted URL trades a stable identifier for one that silently rots — and
  a test asserts the saved document contains no derived URL anywhere.
- **A refusal has to reach the person, not just the log.** Everywhere else in `Highlight.tsx` a failure is
  logged and swallowed, because nothing the visitor does changes the outcome. An upload is the opposite:
  the host refuses on size, then on the declared type, then on the *actual* type read from the leading
  bytes (and SVG never, being a script container wearing an image's extension). The only person who can
  supply a different file is the one standing at the file picker, so the message renders in the modal.
- **Warn before the pick, not after.** The modal reads `quota()` on open and shows the remaining room and
  the per-file ceiling, because the effective numbers are not the manifest's.
- **Nothing collects orphans.** See the next section.

The compact `card` element deliberately renders **no** image. That placement's rule (ARCHITECTURE §7.3) is
a badge and nothing more, with full rendering reserved for `main` — a thumbnail per feed card would be the
easy thing to add and the wrong one.

### The sweep can only collect what the backend can enumerate
A blob outlives the document that named it, so `SamplePlugin`'s scheduled pass deletes images no highlight
points at any more. The interesting part is the precondition: **a sweep may only delete what it can prove
is unreferenced**, so it may only run over scopes the backend can enumerate.

It can enumerate two. `Scope.site()` is a singleton, and `FeedAccess.episodesIn(Scope.site())` yields every
episode. There is no third — `FeedAccess` exposes no way to list *feeds*, so a feed-scope highlight is
invisible from the backend. That single missing method is why this plugin **does not offer image upload at
feed scope**: accepting one there would mean either leaking it forever or having the next sweep delete a
live image out from under a podcaster.

> **If you copy this:** widening where images may be attached means widening the sweep *first*. The failure
> mode is silent, delayed, and destroys someone's upload. It is also why `rememberImageRef` reads the ref
> defensively off the raw `JsonNode` — a shape it fails to understand must read as "no reference", which
> costs a leaked file, rather than as "unreferenced", which costs a live one.

## `links` vs `navigate` — two different questions
0.8.0's `ctx.links` and 0.7.0's `ctx.route.navigate` look adjacent and are not interchangeable:

| | `ctx.route.navigate(subpath)` | `ctx.links.episode(slug)` |
|---|---|---|
| **What it does** | Navigates, right now | Returns a string |
| **Where it can point** | This plugin's `/p/sample/*` only — another plugin's route or a core one is *unnameable*, not merely refused | Core's own pages |
| **In this plugin** | Browse-index rows and the deep-link back-link | The episode link beside each browse row, the "listen" link, the feed-scope season note |

A browse-index row carries **both**, which is the clearest way to see the split: the label links into this
plugin's own subtree and so goes through `navigate`; the "episode page" link beside it leaves for core and
so can only ever be an `href`. Producing a link is not navigating — the visitor still clicks, and a real
`href` is what middle-click, "open in new tab" and crawlers need.

`links` grants no new capability; a plugin could always write any `href`. What it removes is the hardcoded
`` `/episodes/${slug}` `` that quietly breaks when the host changes a route. The deep-link view passes the
podcaster's own key moment as `{ t }`, which is core's timestamp deep link: it seeks the player on arrival
and beats the listener's stored position for that navigation without overwriting it.

## Internal links go through `ctx.route.navigate` (SDK 0.7.0)
Owning `/p/sample/*` means this plugin renders its own links into it: the browse index lists one per
highlighted episode, and the deep-link view has a back-link to the page root. Until 0.7.0 those could only
be a plain `<a href>`, and a plain `<a href>` inside your own page subtree is a **full document load** — the
shell, core's bundle and this plugin's bundle all fetched and re-parsed to render a page the already-mounted
component could have rendered from memory. `ctx.route.navigate(subpath, { replace })` is the host handle
that avoids it: real SPA navigation, a history entry, a working back button.

The lesson worth copying is that this plugin wires **both**, in one helper (`internalLink` in
`Highlight.tsx`), rather than swapping one for the other:

```tsx
function internalLink(route: PluginRoute, subpath: string) {
  return {
    href: `/p/sample/${subpath}`,
    onClick: (e: MouseEvent<HTMLAnchorElement>) => {
      if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
      e.preventDefault();
      route.navigate(subpath);
    },
  };
}
```

- **The `href` stays** because it is what makes a link a link. Middle-click, "open in new tab", copy-link,
  the status bar on hover and a crawler following it all read the attribute; none of them run the handler.
  Dropping it for an `onClick`-only `<span>` is the classic SPA regression.
- **The modifier guard is the reason both can coexist.** A ctrl/cmd/shift/alt-click or a non-primary button
  must fall through untouched, or "open in new tab" silently navigates the current tab instead.
- `subpath` is relative to `/p/sample/` — the same coordinate `ctx.route.path` hands back, already
  percent-encoded here because the episode slug is visitor-controlled. A plugin **cannot** name another
  plugin's route or a core one; the host prefixes its namespace and drops any attempt to climb out.
- Do **not** reach past the handle. `history.pushState` plus a synthetic `popstate` happens to work against
  core's current router, and the SDK explicitly says it is not part of the contract.

`Highlight.test.tsx` covers all three halves of that: the plain click records a `navigate` (the test kit's
`ctx.navigations`) and cancels the default, every modifier and the middle-click record nothing and stay
uncancelled, and the `href` survives either way. Note what the deep-link test does **not** do — it pins
`route: { path: 'highlight/ep-1' }` and nothing else. Since 0.7.1 `route` is the one `makeMockCtx` override
that *merges* over the default, so the `navigate` you leave out is still the recording one; hand-building
the whole handle would replace the recorder with a stub that quietly stops matching the contract.

## A PF4J gotcha that core fixed — and the workaround this plugin carried for it
Kept because the failure is instructive and because the *removal* is the more useful lesson: a workaround
outlives the bug it was for, and nothing tells you.

Fixing the `page`-slot gap above once surfaced a subtler bug. Booting a real core and hitting
`/p/sample/highlight/<slug>` returned the site-level OG fallback instead of ours, and the log showed
`Cannot invoke "PluginContext.store()" because "this.ctx" is null` — a `NullPointerException` inside
`metaFor`, silently swallowed by `PluginExtensions`' per-provider try/catch (ARCHITECTURE §7.8 isolation
doing exactly its job: a broken plugin degrades, it doesn't crash the page).

The cause was PF4J's **default** `ExtensionFactory`, which instantiates a new object per extension-point
type lookup: `getExtensions(PluginBackend.class, "sample")`,
`getExtensions(ShareMetadataProvider.class, "sample")` and `getExtensions(SitemapProvider.class, "sample")`
each constructed their own `new SamplePlugin()`. `register(ctx)` ran on the first; `metaFor`/`urls` ran on
others whose `ctx` field was never set. The sample's own tests didn't catch it, because they called
`register()` and `metaFor()` on the *same* instance — which any instance field survives.

The workaround was a `static` field: PF4J gives every plugin its own classloader, so `static` is scoped to
this class within this plugin and is shared across every instance PF4J builds of it.

**Since core 0.6.7 the host installs PF4J's `SingletonExtensionFactory`**, which caches by class, so all six
of this plugin's extension points now run on the object `register()` ran on. As of **2.14.0** `SamplePlugin.ctx`
is an ordinary `private volatile` instance field again and the tests register and call providers on **one**
instance, which is what the host does. Keeping the `static` would no longer be belt-and-braces: it is state
shared across reloads of the same plugin, which is a leak rather than a fix.

What did *not* change is the reason `metaFor`/`urls` still check `ctx` for null. Core resolves
`ShareMetadataProvider`/`SitemapProvider` independently of `PluginBackend`, so a lookup can still land before
`register()` has run — and the honest answer there is "nothing to contribute", not a throw into a `catch`
that turns into a silently wrong page. **If you copied the `static` from an older sample, you can drop it;
keep the null check.**

## Your first plugin in 5 minutes
**Prerequisites:** **Java 21** and **Node 22 or newer** (jsdom 30, which the tests run in, refuses
anything older; Node 20 went end-of-life in April 2026). Beyond that, the SDK's Java artifacts
(`dev.mosaicast:plugin-api`/`plugin-testkit`) are published to
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

## Installing a *released* plugin, and how this repo publishes one (core 0.6.15)
The copy above is the developer loop: you built it, so you have a `dist/`. An **operator** installing
someone else's plugin has no checkout, and for them core resolves a spec instead — `owner/repo[@tag]
[#sha256:…]`, a tarball URL, or a local file (ARCHITECTURE §7.1):

```bash
# one instance, from a checkout of core
scripts/install-plugin.sh Mosaicast/mosaicast-plugin-sample@v2.10.0#sha256:<from the release notes>

# or in a container, resolved before the JVM starts
MOSAICAST_PLUGINS="Mosaicast/mosaicast-plugin-sample@v2.10.0#sha256:<…>"
```

There is **no registry**: GitHub Releases are the index, reached as a plain `releases/download/<tag>/`
redirect — no API call, no token, no JSON parsing. Two consequences for a plugin author:

- **Pin the tag *and* the checksum.** Plugins are trusted, in-process and unsandboxed (§7.1); making
  installation one env var away does not change that, and the checksum is the only integrity control the
  model has. Which is why publishing the digest is the *plugin's* job, not the operator's.
- **The folder name comes from the manifest's `id`**, never the repo name — a folder disagreeing with its
  id is rejected at load anyway.

`.github/workflows/release.yml` is what makes this repo installable that way, copied unmodified from core's
`dev/templates/release-plugin.yml`. On a published release it runs `./build.sh`, packages `dist/` as
`plugin.tgz`, attaches it, and appends the tarball's SHA-256 to the release notes. **Two lines in it that
look arbitrary and are not:**

- **The asset name `plugin.tgz` is load-bearing.** The installer resolves `owner/repo@tag` straight to
  `releases/download/<tag>/plugin.tgz`. Rename the asset and installs by `owner/repo` stop working.
- **It fails a tag that disagrees with `plugin.json`'s `version`.** `v2.10.0` must mean
  `"version": "2.10.0"`, or an operator pinning a tag installs something calling itself another version.

`install.sh` is not going anywhere — a local copy is still valid and always will be. The two paths answer
different questions: `install.sh` installs *what you just built*, `install-plugin.sh` installs *what someone
published*, with a checksum you can audit.

## Credit fields: who wrote this, and under what terms (core 0.6.15)
Four optional manifest fields, all of which surface on the host's public `/about` page (§7.2, §12.6):

```json
  "name": "Sample",
  "license": "Apache-2.0",
  "author": "The Mosaicast Authors",
  "homepage": "https://github.com/Mosaicast/mosaicast-plugin-sample",
```

- **`license`** is this repo's actual `LICENSE` and matches the SPDX header on every source file — worth
  checking rather than copying, since the sample is Apache-2.0 while the other official plugins are AGPL.
- **`attribution`** is the fourth field, deliberately **absent here**: it credits something a plugin
  *borrows* — a data source, artwork, an upstream library — and this one borrows nothing. It is separate
  from `homepage` because "where this lives" and "who deserves credit for it" are different links.
- They are **optional and never validated.** A manifest without them loads exactly as before, and a
  misspelled licence string is still a working plugin. Credit is not a correctness concern.
- **This is not a `platformApi` bump**, and that matters: the host ignores unknown manifest fields and the
  SDK has no manifest type, so the change is additive in both directions. Bumping would be actively
  harmful — the check is an exact `major.minor` match, so it would reject every installed plugin until
  each one re-released.

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
- **2.15.0** — SDK **0.14.0**, hosted by core **0.7.0**. Two contract minors in one step (0.12.0 → 0.13.0 →
  0.14.0), both about people rather than pages.
  - **[`ctx.users` / `Users`](#a-byline-that-outlives-its-author-sdk-0130)** (0.13.0) — a highlight now
    carries its author's **UUID** and nothing else, resolved to a name and a host-served avatar at render:
    `components/Byline.tsx` for one, the page's credit strip for a whole listing in one call. An id that
    comes back *absent* — erased, pseudonymised, unknown — leaves the highlight standing under a placeholder,
    which is the property the shape exists for. New manifest block: `identity`.
  - **[`ctx.notifier()` / `Notifier`](#the-one-surface-that-writes-into-somebody-elses-site-sdk-0140)**
    (0.14.0) — the scheduled pass tells everyone who favourited a highlight when it gains a language they can
    read it in, carrying **one finished sentence per locale** because the reader's language is not knowable
    at send time. Seeded on first sight so installing this version announces nothing retroactively; a
    rate-limited send is held for a later tick rather than dropped. New manifest block: `notifications`, and
    a new `backendOwned` key, `announced`.
  - **Declined on purpose**, and documented: no favouriter avatar row (it would publish a mark the whole
    `USER`-scope design keeps private) and no browser-side `ctx.notify` (nothing a visitor does here is news
    to anybody else).
  - **`ctx.user` gained `displayName` and `avatarUrl`** (0.13.0) — the migration's one compile break, in
    hand-written test contexts. `test-utils.ts` grew `mockUser(id, role)`, which derives `avatarUrl` the way
    the host does so an assertion pins the string production produces.
  - `docs/ARCHITECTURE.md` re-synced from core `v0.7.0`: §8.6 display names, §8.6.1 revert-not-rename,
    §8.7 avatars, §8.8 what a plugin sees of a user, §16 external services, §17 notifications.
- **2.14.0** — SDK **0.12.0**, which carries the multilingual work of 2.13.0 out to the URL.
  - **[`SitemapUrl.alternates`](#saying-what-language-a-page-is-in-sdk-0120)** — `SamplePlugin.urls()`
    declares an `hreflang` group per translated highlight, filtered three ways: the translation must have
    text, its locale must be one the site *authors content in* (these keys are client input — nothing
    validated them on the way in), and the shell must be able to *render* that locale, or there is no
    `?lang=` to point at. An untranslated highlight declares nothing, which is what the host assumed before
    the component existed.
  - **`OgMeta.locale` left unset**, deliberately — the component is for a page fixed in one language, and
    this one follows the shell. Naming the default put `og:locale=en_US` on the very `?lang=de` URL the
    sitemap advertised as German; caught by running it, not by a test.
  - **The detail page finally answers in the reader's language.** `HighlightPage.tsx` rendered
    `doc.markdown` regardless of locale — the episode slot resolved translations, the deep-linkable page in
    the sitemap did not. It now runs the same `resolveHighlightText`, sets `lang` on the content element and
    shows the same machine-translated and fallback notes. Declaring an alternate for a page that ignores
    `?lang=` would have been worse than declaring nothing.
  - **`SitemapProviderHarness`** (test kit) — reports what the host would silently drop or contradict.
  - **The `static ctx` workaround is gone** — core has installed PF4J's `SingletonExtensionFactory` since
    0.6.7, so every extension point runs on the instance `register()` ran on. Plain instance field, tests on
    one instance, null check kept (a lookup can still precede `register()`). See [the PF4J
    gotcha](#a-pf4j-gotcha-that-core-fixed--and-the-workaround-this-plugin-carried-for-it).
  - `nativeNameOf` moved from `Highlight.tsx` to `i18n.ts`, now that two components need it.
- **2.13.0** — SDK **0.11.0**, two contract minors in one step (0.9.1 → 0.10.0 → 0.11.0), both about a site
  having more than one language.
  - **[Two locale lists](#two-locale-lists-and-picking-the-wrong-one-is-silent-sdk-0100)** (0.10.0) —
    `ctx.locale.available()` vs `content()`, and `ctx.locales()`/`Locales.isContentLocale` on the backend. A
    highlight can now be written in every language the site authors content in; the editor's tabs come from
    `content()`, and picking `available()` instead is the mistake nothing reports.
  - **[Host-mediated translation](#machine-translation-is-a-draft-and-says-so-twice-sdk-0110)** (0.10.0/0.11.0)
    — a translate button in the editor, and a scheduled backend pass that drafts the languages nobody has got
    to yet. Both label the result as machine output; neither publishes it without a human pressing Save.
  - **`external: { kinds: ["translation"], usedBy: "podcaster" }`** (0.11.0) — the new manifest block, and
    the migration trap it comes with: `ctx.translation` was already nullable, so omitting the block breaks
    nothing the type system can see and the button simply stops working.
  - **`drafts` joins `data.backendOwned`** — the editor offers those machine translations to a podcaster as
    suggestions, so an undeclared key would let anyone above `writableBy` plant text the editor then presents
    in good faith as the site's own provider's work.
  - `stats` gains `fullyTranslated` and `strandedTranslations`; `icons.tsx` adds `translate` and `info`.
- **2.12.0** — SDK **0.9.1** (`platformApi` bumped to match; core rejects a `major.minor` mismatch at load,
  so a `0.8.x` manifest stops loading the moment the host is on 0.9.x — the patch itself floats, so `0.9.0`
  would also load here). The release that came out of *using* the contract, and much of it was found by
  building **this repo** against 0.8.0 — so it is as much a set of deletions as of additions.
  - **Deleted, because the SDK owns them now:** the hand-rolled icon stylesheet (≈113 lines →
    `iconCss(ICON_NAMES)`), `formatTime`/`formatBytes` (→ `i18n.duration`/`i18n.bytes`, which unlike the
    originals are locale-correct — the byte formatter hardcoded `.` as the decimal separator and was simply
    wrong in `de`), `declaredType(file)` and its extension→MIME table (→ `blobs.upload` normalises by
    default), the hand-rolled route matcher (→ `matchRoute`), the three doc-path builders (→ `ctx.docs`),
    and ten `.catch(() => undefined)` call sites (→ `getOrNull` + `isPluginApiError`).
  - **[`PageRouteProvider`](#unknown-subpaths-are-real-404s-now-sdk-091)** (0.9.1's headline) — an unknown
    subpath under `/p/sample/` now answers a real **404** instead of this plugin's not-found view inside a
    `200 OK`. The page's `matchRoute` miss branch became a real not-found view to match.
  - **[`SearchProvider`](#plugin-content-in-the-sites-own-search-sdk-090)** — highlights appear in the
    site's own `/api/search`, grouped as their own section; the podcaster-only "to write" hint is gated to a
    podcaster, which is the one place in this contract where access is the plugin's job.
  - **[`UserDataHandler`](#what-a-plugin-owes-a-departing-account-sdk-090)** — repairs the three published
    documents that counted a departing account's favourites, idempotently, and exports what they marked.
  - **[Tags](#tags-are-one-vocabulary-several-writers-share-sdk-090)** — the manifest declares
    `readsVocabulary` and explicitly **not** `writesEpisodes`; the backend reconciles each episode's tags
    onto its own subject and the page renders them, linking out to core's filtered feed view.
  - **[`ctx.feeds`](#the-page-draws-real-episode-cards-now-sdk-090)** — the page's cards carry the host's
    real title, artwork, publication date and runtime, in one batched request rather than N.
  - **[`ctx.route.query`](#a-page-is-not-a-tile--and-it-can-have-several-front-doors-core-0615)** — a
    shareable `?sort=newest|favourites` on the index and gallery views, written with `replace: true` so a
    sort change is not a back-button step.
  - **[`ctx.docs`](#ctxdocs-and-the-escape-hatch-underneath-it)** everywhere except one deliberate
    `ctx.api` call site, kept to show the surface underneath it.
  - **[Typed failures](#absence-is-an-answer-a-failure-is-not-sdk-090)** — the edit modal now stays open and
    says which refusal it was, instead of closing over a write that never landed.
  - **`defineManifest`** over `plugin.json` in `page-entries.test.ts`, so `tsc --noEmit` catches a
    `slots[].element` missing from `frontend.elements` — today a load-time failure found by hand.
  - **Test kit:** `makeMockDocs`/`makeMockFeeds`/`makeMockTags`/`apiError`/`flushMockApi`, plus the three
    Java harnesses. `flushMockApi` replaced this repo's hand-counted `await Promise.resolve()` pair, which
    covered one microtask hop and not two — the "fails only sometimes" class of flake.
  - **One contract drift found and reported:** core's `NavEntry` reads `visibleTo`; the SDK's
    `PluginNavDeclaration` declares `role`. Core wins (the SDK's own type says so), so `plugin.json` keeps
    `visibleTo` and `page-entries.test.ts` documents the divergence.
- **2.11.0** — the plugin's **page**, and the cross-browser upload bug that had been hiding in it. Still
  `platformApi` `0.8.0`: `nav[]` is additive manifest, and the rest is this plugin's own code.
  - **[Four entrances, declared once](#a-page-is-not-a-tile--and-it-can-have-several-front-doors-core-0615)** —
    `nav[]` (core 0.6.15) puts a plugin's pages in the shell's navigation menu. This one declares four views
    over one dataset, one of them `visibleTo: "podcaster"`, and the page is now its own element rather than
    the tile wearing a hat. A backend-written `index` doc makes all four cost a single request.
  - **[`declaredType`](#a-valid-image-refused-in-one-browser-only)** — an image upload that worked in
    Chromium and failed in Firefox, because `File.type` comes from the OS MIME database in one and a
    built-in table in the other, and the host checks the *declared* type before it reads a byte.
    Reproduced against a running core (415 → 201), fixed, and covered by `highlight-doc.test.ts`.
  - The upload refusal's warning icon now aligns to the first line of a wrapping message.
- **2.10.0** — the **core 0.6.15** additions, and **no `platformApi` bump**: all three are host-side or
  additive-manifest, so this still declares `0.8.0` and keeps loading everywhere. That restraint is the
  first lesson of the release — the version check is an exact `major.minor` match, so a reflexive bump
  would reject every installed plugin until each one re-released.
  - **[Host icons via `--mc-icon-*`](#icons-come-from-the-host-and-not-through-ctx-core-0615)** — the shell
    publishes a subset of its icon set as CSS custom properties, which inherit through the shadow boundary,
    so `frontend/src/icons.tsx` draws the shell's own artwork with **no SDK import and no version skew**.
    The knock-on is the part worth copying: the marks used to be literal `▶`/`★`/`←` characters *inside*
    the translated strings, and both catalogs are now sentences only. An icon is not a word. Note the
    fallback rule — a missing token renders a **solid square**, not nothing, unless you say so.
  - **[Credit in the manifest](#credit-fields-who-wrote-this-and-under-what-terms-core-0615)** —
    `license`/`author`/`homepage`, shown on the host's public `/about` page. Optional, never validated.
    `attribution` is deliberately left out: this plugin borrows nothing, and its absence is the example.
  - **[`release.yml`, so an operator can install by spec](#installing-a-released-plugin-and-how-this-repo-publishes-one-core-0615)** —
    copied unmodified from core's `dev/templates/release-plugin.yml`. On a published release it attaches
    `plugin.tgz` (the name is load-bearing) and publishes the SHA-256 an operator needs to pin what they
    audited. `install.sh` stays; the two paths install different things.
- **2.9.0** — SDK **0.8.0** (`platformApi` bumped to match; core rejects a `major.minor` mismatch at load,
  so a `0.7.x` manifest stops loading the moment the host is on 0.8.0). Both additions are exercised, which
  for one of them meant declaring something:
  - **[`ctx.blobs`](#file-uploads-live-behind-a-manifest-declaration-sdk-080)** — highlights can now carry a
    **podcaster-uploaded image**. This is the release's substantive half: before it, a plugin could render an
    image from any host on the web and could not accept one from the site's own podcaster. The manifest
    declares a `blobs` block (without it `ctx.blobs` is `null`, exactly like `ctx.schema`), the edit modal
    uploads and shows `quota()` *before* a file is picked, the document stores only the **ref**, and refusals
    render in the modal rather than only in the log — the person at the file picker is the only one who can
    fix them.
  - **The backend sweeps orphaned images** on its existing schedule (`ctx.blobs()`, the Java half). Nothing
    on this platform collects orphans. The constraint that shapes it is worth reading before copying:
    [a sweep can only collect what the backend can enumerate](#the-sweep-can-only-collect-what-the-backend-can-enumerate),
    and because `FeedAccess` cannot list feeds, this plugin deliberately does **not** accept images at feed
    scope.
  - **[`ctx.links`](#links-vs-navigate-two-different-questions)** — `episode(slug, { t })` and
    `feed(slug, { season })`, replacing the hardcoded `/episodes/${slug}` every plugin used to write. Not a
    new capability, a relocation of knowledge: the host owns the shape of its own URLs. Non-nullable, so
    leaving it unused would have been an outright hole in this repo's every-field claim.

  `ctx.schema` remains the one field this plugin does not exercise, and now the only one — it is `null` for a
  doc-store plugin and unreachable without changing what this one stores.
- **2.8.0** — SDK **0.7.1** (`platformApi` bumped to match; core rejects a `major.minor` mismatch at load,
  so a `0.6.x` manifest stops loading the moment the host is on 0.7.x). The two additions in the 0.7 line:
  - **[`ctx.route.navigate(subpath, { replace })`](#internal-links-go-through-ctxroutenavigate-sdk-070)**
    is now what both of this plugin's internal links use — the browse index's per-episode entries and the
    deep-link back-link. They keep their `href` (middle-click, "open in new tab" and crawlers read the
    attribute, not the handler) and hand only a plain, unmodified left-click to `navigate`, which is SPA
    navigation instead of a full reload of the shell and both bundles. This repo claims to exercise *every*
    field of `ctx`, so a new field with two obvious call sites already in the tree is a gap, not a footnote.
  - **`ctx.schema`** is `null` here and stays that way — it exists for a plugin that declares
    `storage.schema`, and this one uses the doc store, which is the default and covers nearly everything.
    Nothing to exercise short of changing what the plugin stores.

  **Why 0.7.1 and not 0.7.0.** `PluginRoute` gained a *required* `navigate` in 0.7.0, which broke every
  test that hand-builds a whole `route` override for `makeMockCtx` — this repo had four. **`npm test`
  passed either way; only `npm run typecheck` caught it**, which is the argument for that script existing.
  0.7.1 is the patch that fixes the cause rather than the symptom: `route` is now the one override
  `makeMockCtx` **merges** over its default instead of replacing, so `route: { path: 'highlight/ep-1' }` is
  the whole override again and what you leave out keeps working — `navigate` still records into
  `ctx.navigations`, `onChange` still returns a live unsubscribe. All four stubs are gone here, which
  matters for a copy template: a pasted `onChange: () => () => {}` is a fake that silently stops matching
  the contract at the next bump.

  `platformApi` reads **`0.7.1`** because `sample-element.test.tsx` asserts it equals the SDK's own
  `PLATFORM_API_VERSION` **exactly** — the check that would have caught a stale manifest in the first
  place. Core only ever compares `major.minor`, so this still loads on a host running 0.7.0.
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
