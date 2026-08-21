# Mosaicast – Architecture Reference (Source of Truth)

> This document is the **single source of truth**. Every repo gets a copy at `docs/ARCHITECTURE.md`.
> Subproject briefs reference this file and only add repo-specific detail.
> On conflict between a brief and this file → **this file wins**, then flag it.

---

## 1. Vision & Scope

Mosaicast is an **extensible website platform for podcasts**. A podcast has several feeds (regular, news, paid) that are shown unified or filtered. Fans interact (bingos), hosts add extra info (speaking shares / stats). Everything is extensible via **plugins** at site, feed, season and episode level.

- **Now (v1):** ONE podcast, multiple RSS feeds per site. Public open-source project.
- **Scale:** v1 targets dozens of users, but built so it grows to thousands + multiple load-balanced instances (v3).
- **Far future:** multi-tenant (many podcasts centrally), possibly a native audio host with its own RSS feeds. **Only keep interfaces open, do NOT build now.**

**Guiding principle:** abstract interfaces cleanly for the future, keep the implementation simple for *today*. YAGNI on implementation, foresight on interfaces.

---

## 2. Tech Stack (binding)

| Layer | Choice |
|---|---|
| Backend | **Java 21**, **Spring Boot 3** (Web/REST, Security, Data JPA, Session) |
| Plugins | **PF4J** (`pf4j-spring`), loaded from folders at **startup** (no hot reload) |
| RSS | **Rome** |
| DB | **PostgreSQL** (JSONB for the plugin store; `pgvector` only in v2) |
| Migrations | **Flyway** |
| Scheduler locks | **ShedLock** (mandatory, for the multi-instance future) |
| Cache/Sessions | in-memory in v1 → **Redis** from v3 (config switch, no rewrite) |
| Frontend | **TypeScript + React + Vite** (host shell). Plugins ship UI as **Web Components**. **No Vaadin.** |
| Deployment | **Docker Compose** on a VPS (app, postgres, caddy/traefik; redis later) |

Naming conventions: see §15.

---

## 3. Repository Map & Dependencies

```
mosaicast-plugin-sdk     ← contract (Java plugin-api JAR + @mosaicast/plugin-sdk TS types). NO app dependency.
        ▲
        │ (compile-only)
mosaicast-core           ← host: Spring Boot backend + React/Vite shell. Depends on the SDK.
        ▲
        │ (compile-only, against the SDK – NOT against core)
mosaicast-plugin-sample  ← reference plugin + build.sh (React-specific, replaceable)
mosaicast-plugin-bingo   ┐
mosaicast-plugin-stats   ├ own repos, depend ONLY on the SDK
mosaicast-plugin-wiki    ┘
```

**Build order:** SDK → core → sample → individual plugins.
Plugins compile **exclusively** against the SDK, **never** against core code. That hard boundary is what makes external plugin repos viable.

---

## 4. Domain Model – the two layers

The project's most important decision: **identity is separate from presentation.**

### 4.1 `EpisodeRef` – identity layer (authoritative, owned by us)
Stable internal ID that **all plugins reference**. Survives feed changes.

```
EpisodeRef
  id            UUID         -- THIS is what plugins reference
  source_id     FK           -- from which FeedSource config
  external_guid String?      -- the source's GUID (null when PLANNED)
  season        Int?         -- from itunes:season, persisted as a relation
  episode_no    Int?
  status        Enum         -- PLANNED | PUBLISHED | WITHDRAWN
  access        Access       -- PUBLIC | TIER(ref)
  first_seen_at, last_seen_at
  provisional_display Json?   -- only set when PLANNED (see 4.3)
```

**Status lifecycle:** `PLANNED` → `PUBLISHED` → possibly `WITHDRAWN`.

### 4.2 Display snapshot (NOT authoritative, from the feed)
Title, description, audio URL, pubDate, runtime/duration (`<itunes:duration>`/enclosure), **episode artwork** (`itunes:image`) with the **feed/show cover** (channel `itunes:image`) as a fallback (`artwork()` = episode → feed), **author** (`itunes:author`, falling back to the channel author) and **subtitle** (`itunes:subtitle`). **Overwritten** on every fetch from the raw feed, only read-through cached. So a description change in the RSS propagates automatically and never lives in the DB as truth. (Episode **tags** — `itunes:keywords`/`<category>` — are feed-derived too but stored as a relation `episode_tag`, since they are a filter/scoping axis, §6.1.)
Table: `episode_display(episode_ref_id, snapshot JSONB, fetched_at)`. Swappable for Redis later.

> **Core display vs. plugin metrics:** Runtime/date in the main UI (feed cards, detail header, player) always come from the **feed snapshot**. Metrics provided by plugins (e.g. MAT runtime, speaking shares) are **non-authoritative, possibly absent** (not every episode has stats) and are shown **only inside that plugin's UI** — never in the core display.

### 4.3 Planned episodes (PLANNED) – creating episodes before the RSS
Hosts make bingos for the **upcoming** episode. So episodes must be creatable before they appear in the feed.
- A podcaster creates a planned episode → `EpisodeRef` with `status=PLANNED`, `source=manual`, `provisional_display` (title + planned season/episode no.). **Only here** does display data live authoritatively in the DB — until the feed takes over.
- Plugin data (bingos) attaches to the internal ID immediately.
- When the real episode appears in the RSS → **binding instead of duplicating** (see 5.3). Status flips `PLANNED → PUBLISHED`, from then on the feed snapshot rules. Plugin data is untouched because it hung on the ID, not the feed.

`PLANNED` = bingo prediction phase, `PUBLISHED` = resolution.

### 4.4 Season as a first-class concept
Season is **not** a plugin concern. The fetcher extracts `itunes:season` and persists it as a relation on the `EpisodeRef`. A season = "all EpisodeRefs of a feed with season=N". Season is a **scope** (§6).

---

## 5. Feed Pipeline

### 5.1 FeedSource SPI (the open interface for other hosts)
```java
interface FeedSource {
    String type();                        // "rss", "patreon", ...
    SourceCapabilities capabilities();
    List<RawEpisode> fetch(SourceConfig cfg) throws FetchException;
}
record SourceCapabilities(boolean providesAudio, boolean supportsTierGating,
                          boolean supportsSeasons, boolean pushBased) {}
record RawEpisode(String externalGuid, String title, String description, String audioUrl,
                  Instant publishedAt, Integer season, Integer episodeNumber,
                  Duration declaredDuration, Access access) {}
```
- `RssFeedSource`: providesAudio=true (`<enclosure>`), supportsSeasons=true, supportsTierGating=false, pushBased=false.
- `PatreonFeedSource` (v2): like RSS + supportsTierGating=true.
- Future native host: pushBased=true (no polling).

**Rule:** the rest of the platform queries **capabilities**, never the source type. New host = new implementation, otherwise zero change.

### 5.2 Reconciler – raw items become EpisodeRefs
Match by `(source_id, external_guid)`:
1. **New GUID** → create `EpisodeRef` (identity + relations only).
2. **Known GUID** → refresh season relation + display snapshot, plugin data untouched.
3. **Ref exists, GUID now missing** → **never hard delete** (plugin data would orphan, feeds glitch). Set `status=WITHDRAWN`.

### 5.3 PLANNED binding & dedup (same machinery)
Before creating a new ref for an unknown GUID, the reconciler checks whether a `PLANNED` ref matches: first by declared season/episode no., otherwise fuzzy title → **suggestion, podcaster confirms**. On binding: set `external_guid` + `source`, `PLANNED → PUBLISHED`.
This is the **same merge machinery** as v2 dedup (multiple refs → one canonical episode, fuzzy-title merge UI), just triggered at a different time. v1: only PLANNED binding active; the model allows later merging without a rewrite.

### 5.4 Scheduler
One periodic job per FeedSource config, **ShedLock-wrapped** (runs only once across N instances). Default 15–30 min, configurable per feed. `pushBased` sources skip polling. "Refresh now" button for podcasters. Dead feeds: backoff, last successful state stays visible. Polling uses **HTTP conditional GET** (ETag / If-Modified-Since) — polite to feed hosts; an unchanged feed costs a 304.

---

## 6. Scopes, sequential navigation & related

### 6.1 Scopes
Four: **site / feed / season / episode**. Resolving "which episodes belong to this scope" is the **host's job**:
```java
interface FeedAccess { List<String> episodesIn(Scope scope); DisplaySnapshot display(String refId); }
```
The host fills the frontend `ctx.episodes[]` from this. A plugin never figures out itself how a season is defined.

**Filter state lives in the URL** (query params, e.g. `?season=2&tag=christmas`): filtered views are shareable/bookmarkable, the back button works, and the server can read the params when rendering share metadata (§6.4). Plugins still consume filters read-only via `ctx.filter`. Filter axes: **season** (§4.4), **tag** (feed-derived keywords/categories, `episode_tag`) and ordering; **feed** is selected by the shell's **per-feed tabs** (All + one per feed; a single-feed site shows no tabs and lives at that feed's own URL). The feed view is **two-column**: a left **scope panel** (a **feed panel** — cover/title/author/description + the `feed` plugin region — on a feed tab, or a **site panel** — logo/name + the `site` region — on the All tab) beside the episode list (which infinite-scrolls). Host-defined **subfeeds** (a saved tag/search/filter as a named view) are a planned extension.

### 6.2 Sequential navigation (always shown)
Previous/next episode are **core navigation, not related and not a plugin** — always shown (detail page + player). **Order: release order (`publishedAt`) within the feed** — the same sequence the browsable feed shows (§6.1), so `prev` is the previously released episode and `next` the next released one, and navigation always matches what the listener sees in the list. Episode numbers deliberately do **not** drive navigation: real feeds routinely omit `itunes:episode` (e.g. Acast) or number inconsistently, so a numberless trailer/bonus would otherwise be coerced to "episode 0" and jump to the front. An episode without a `pubDate` counts as the earliest point in the series; ties fall back to season + episode no. **Only released episodes are part of the sequence** — a `PLANNED` episode leads the *listing* (§6.1, upcoming first) but has no audio, so it is never anyone's `next` (auto-advance would land on an unplayable episode); its own page links back to the latest release. (The per-feed *listing* order used by `FeedAccess.episodesIn` stays season + episode no., nulls last — that is a catalogue view, not the navigation sequence.) **The player auto-advances to the next episode when one ends** (same sequence logic). Must work with zero plugins.

### 6.3 RelatedProvider (core, swappable strategy – not a plugin)
Interface: `related(EpisodeRef ctx, int limit) → List<EpisodeRef>` with capabilities.
**v1 strategy (deterministic, no ML):** pinned episodes (podcaster-curated in admin) win, otherwise a weighted blend of **same season** (recency), **shared tags/keywords** (`<itunes:keywords>`/`<category>` or manual), fuzzy title. Exclude: current episode, PLANNED, WITHDRAWN; locked ones at most as a lock stub. **Computed on-request + cached**, invalidated on new episodes.
**Future (v2):** an embedding strategy (`pgvector`, cosine) or a recommender plugin overrides the provider — the sidebar widget doesn't change. Runs over `EpisodeRef` → automatically respects dedup + tier gating.

### 6.4 Deep links & share metadata (SEO/OG)
The shell is an SPA, but link scrapers (WhatsApp/Discord/Facebook) **do not run JS**. So core injects **OpenGraph/Twitter meta tags server-side** into `index.html` per URL before serving it.
- **OgResolver per scope:** episode → episode title + episode image (fallback: podcast cover); feed/site → cover + site name + description; season → "site name – Season N". The resolver reads the **query params** (§6.1), so a shared filtered view gets matching meta.
- **Plugin deep links:** the host reserves **`/p/{pluginId}/*`** and passes the subpath to the plugin as `ctx.route` (read-only + `onChange`). That makes plugin content (e.g. a wiki page) linkable and shareable at all.
- **`ShareMetadataProvider`** (optional backend extension point, §7.4): when serving a `/p/{pluginId}/…` URL, core asks the plugin for title/description/image; no provider (or no match) → site-level OG fallback. The wiki implements it in v1 as the reference.
- **Timestamped episode links:** `/episodes/{slug}?t=754` addresses a **moment**, and the shell hands the position to the player as its pending seek. The grammar accepts what people paste — bare seconds, `12:34`, `1:02:03`, `1h02m03s`, `90m` — and an unparsable value is **dropped rather than an error**, since the meaning of the URL is its path and `t` only enriches it. One grammar, implemented on both sides (shell + server) and held to a shared table of cases: the shell decides where playback lands, the server decides what a card says, and a link that previews as one moment and plays another is worse than one carrying no timestamp.
- **`rel=canonical` and `og:url` may differ, and here they do.** They answer different questions: canonical is *which URL to index*, and a timestamp is a position within one page rather than a page of its own — so canonical stays the bare episode and the filter-normalizing rules above are untouched. `og:url` is *what was shared*; emitting the canonical form there would let a scraper normalize a shared moment back to the top of the episode, which is precisely the link the sharer did not send. Only a parsed-and-re-serialized value is echoed, so the parameter never reaches the page as text.
- **Preview tags are written for messengers, not only for search.** Beyond title/description/image: an episode declares `og:type: article` with `article:published_time`, plus `og:audio`(`:type`) when the enclosure's format is unambiguous from its URL; every view carries `og:site_name`, `og:locale` and `og:image:alt`. Image *dimensions* are deliberately absent — artwork comes from the feed as a third-party URL whose size the host does not know.

### 6.5 Listening progress (core service)
Per-user playback progress is a **core service, not a plugin concern**: the player stores position per episode (anonymous → localStorage only; logged-in → server-side), **resumes playback** where the user left off, and exposes read access to plugins via `ctx.progress` (e.g. bingo's spoiler protection). One source of truth for "has this user heard this episode".

**An explicit `t` (§6.4) wins over stored progress for that navigation, and does not overwrite it.** Someone following a timestamped link asked for that spot; someone who was partway through the episode did not ask to lose their place, and a link they were sent should not be able to move it. The stored position is only rewritten once playback has actually advanced past the shared one — the difference between having looked and having listened — and a manual scrub ends the hold at once, being a deliberate statement about where the listener is.

### 6.6 SEO & crawlers
Same machinery as §6.4 (the server knows episodes and can ask plugins), extended four ways:
- **`sitemap.xml`** — generated dynamically: all episode URLs, feed/season views, legal pages, plus plugin URLs via the optional **`SitemapProvider`** extension point (§7.4; wiki implements it). Referenced from robots.txt.
- **`robots.txt`** — served by core: admin/API paths disallowed, sitemap referenced. **AI-crawler policy (GPTBot, ClaudeBot, PerplexityBot, …) is an admin setting**, not hardcoded — operators decide. Optional `llms.txt` alongside.
- **Structured data (JSON-LD):** `PodcastSeries` on the site/feed pages, `PodcastEpisode` on episode pages — fed by the same data the OgResolver already has.
- **Content for non-JS crawlers:** Googlebot renders JS, but many crawlers (and most AI crawlers) don't. Core renders a **simple server-side HTML content block** into the served `index.html` (episode list on feed pages; title/description/show notes on episode pages); the React shell replaces it on mount. No SSR framework — a plain template is enough.
- **Hygiene:** `rel=canonical` (normalize filter query params — they're in the URL per §6.1, so prevent duplicate content), `hreflang` once >1 UI locale is active, `<link rel="alternate" type="application/rss+xml">` for feed discovery, and **real HTTP 404s** for unknown episodes/routes (no soft-404).

---

## 7. Plugin System (the heart)

### 7.1 Structure
A plugin = **one folder**: backend JAR (PF4J extension) + `frontend/` (built Web Component bundle) + `plugin.json`. Loaded from a plugins folder at startup. **Trusted, in-process, no sandboxing** — the admin carries responsibility, also for 3rd-party.

**Configurable plugins path (no forced folder layout):** core reads the plugins folder from `MOSAICAST_PLUGINS_DIR` (env/property, default `./plugins`). Plugins know **nothing** about it — their `build.sh` only writes to their own local `dist/` and never touches core. Distribution (`dist/` → plugins folder) stays a **separate step**; location is free to choose (sibling folder, central folder, Docker volume). An optional `install.sh` in a plugin may shortcut the copy if `MOSAICAST_PLUGINS_DIR` is set — never as a requirement.

**Installing by spec (no registry).** Copying by hand remains valid and always will, but it is not the only path: `scripts/install-plugin.sh` resolves `owner/repo[@tag][#sha256:…]`, a tarball URL or a local file, and in a container `MOSAICAST_PLUGINS` does the same **before the JVM starts** — plugins are read once at startup, so anything arriving later would stay invisible until the next restart. **GitHub Releases are the index**: a fixed `plugin.tgz` asset reached through the plain `releases/…/download/` redirect, which is what keeps this an API call, a token and a JSON parser lighter than a registry would be. A central registry is not ruled out, but nothing here needs one yet.
- The installed folder name comes from the manifest's own `id`, never from the repo name — a folder that disagrees with its id is rejected at load anyway, so guessing would only move the error somewhere less obvious.
- An unresolvable spec **fails the container** rather than booting without it: an instance that looks healthy while silently missing a plugin the operator asked for surfaces later as a broken page instead of the deploy error it is. Restarts are idempotent — an already-installed spec is recognised without re-downloading.
- **Pin a tag *and* a checksum.** Plugins are trusted, in-process and unsandboxed (above); making installation one env var away does not change that, so the documented default is the form an operator can audit. The checksum is the only integrity control this model has.

> **Known rough edge:** PF4J classloading inside a Spring Boot fat JAR is fiddly. Keeping plugins Spring-free (plain PF4J extensions against the SDK) is the deliberate mitigation; still budget real time for the classloader setup in core (E5) instead of fighting it late.

### 7.2 Manifest (`plugin.json`)
```json
{
  "id": "bingo",
  "version": "1.0.0",
  "platformApi": "1.x",
  "name": "Bingo",
  "license": "AGPL-3.0-or-later",
  "author": "The Mosaicast Authors",
  "homepage": "https://github.com/Mosaicast/mosaicast-plugin-bingo",
  "backend":  { "basePath": "/api/plugins/bingo", "extensions": ["dev.mosaicast.plugin.bingo.BingoPlugin"] },
  "frontend": { "entry": "bingo.es.js", "elements": ["bingo-episode-card", "bingo-host-board"] },
  "slots": [
    { "scope": "episode", "element": "bingo-episode-card", "placement": "main",    "visibleTo": "anonymous", "order": 100 },
    { "scope": "episode", "element": "bingo-host-board",   "placement": "admin",   "visibleTo": "podcaster" }
  ],
  "storage": "doc",
  "data":    { "readableBy": "fan", "writableBy": "podcaster", "backendOwned": ["stats", "agg:*"] },
  "config":  { "fuzzyThreshold": { "type": "number", "default": 0.85, "editableBy": "podcaster" } },
  "consent": { "services": [] }
}
```
- **`platformApi`**: which SDK contract version it was built against. The host **rejects incompatible plugins at startup** (stability anchor).
- **`slots`**: scope + Web Component + `placement` (named region) + `visibleTo` (minimum role) + optional `order`.
- **`storage`**: `"doc"` = generic JSONB store. For the wiki, a schema declaration instead (§7.6).
- **`data`**: the access floor of the generic data surface (§7.6) — `readableBy` / `writableBy`, each `anonymous | fan | podcaster | admin`; `writableBy` may not be `anonymous`. **Declared, never derived:** the host does not infer it from slots. An absent block defaults `readableBy` to the *write* floor, not to anonymous — a **behaviour change**: a plugin that relied on an anonymous slot making its data anonymously readable must now declare `readableBy: "anonymous"` to keep it. A slot's `visibleTo` governs **rendering only**. Neither floor applies to the `USER` scope (§7.6). `backendOwned` names the keys only the plugin's **backend** may write — an exact key, a `*`-terminated prefix, or the bare `*`; clients may still read them (subject to `readableBy`) and a client `PUT`/`DELETE` is a **403** the host words apart from the role-floor one, so an author can tell which rule refused them. It is the only **per-key** rule on this surface; see §7.6 for why it is needed and what it does not do.
- **`blobs`**: opt-in file storage (§11.1) — `maxFileBytes`, `quotaBytes`, `mimeTypes`. Declared, never derived, like `data`: what a plugin may write to disk should be readable off its manifest. Absent = no file storage at all. The operator caps every number and intersects the type list with the install's own, so a plugin is granted the smaller of the two rather than rejected for asking. `image/svg+xml` is refused at load — SVG is never storable (§12.2).
- **`consent`**: third-party services the plugin loads — one declaration each (`id`, `name`, `provider`, `category`, `privacyUrl`, `hosts`, `thirdCountryTransfer`, `storage[]`); the visitor decides per *category*, and `hosts` doubles as the CSP allow-list (§12.5). Omit the key entirely when the plugin loads nothing third-party.
- **`config`**: declared fields are rendered by core as a **generic admin form** (respecting `editableBy`) — plugins never build their own config UI.
- **`license` / `author` / `homepage` / `attribution`**: credit, shown on the public About page (§12.6). All optional and **never validated** — a plugin written before these existed must keep loading, and an oddly-spelled licence is still a working plugin; credit is not a correctness concern. `attribution` is separate from `homepage` because "where this lives" and "who deserves credit for it" are not the same link: a plugin that borrows data, artwork or an upstream library should be able to say so without giving up its own page. Purely additive in both directions — the host ignores unknown manifest fields and there is no manifest type in the SDK — so **no `platformApi` bump**, which matters because that check is an exact `major.minor` match and a bump would reject every installed plugin until each one re-released.

### 7.3 Slots & placements
- Regions (`top`, `card`, `main`, `sidebar`, `player`, `feed`, `site`, `admin`, …) are defined by the **host shell** per view. Plugins only target existing names; an unknown region → startup rejection. The **`feed`** and **`site`** regions are the scope panels' plugin spaces (§6.1): `feed` on a feed tab, `site` on the All tab.
- **Multiple plugins in one region → stacked** vertically, sorted by `order` (ties: plugin ID alphabetical). No "battle royale". Admin can steer `order` via config.
- `card` placement (episode, compact): plugins show a one-liner on the feed card (stats summary, bingo badge), full rendering only in the detail page `main`. A plugin declares `card` or omits it.

### 7.4 Backend contract (in the SDK)
```java
public interface PluginBackend extends ExtensionPoint { void register(PluginContext ctx); }
public interface PluginContext {
    DocStore     store();    // (scope, key) → JSON, hard-scoped
    SchemaStore  schema();   // only present if the manifest declares schema
    PluginBlobs  blobs();    // only present if the manifest declares `blobs` (§11.1); null otherwise
    PluginConfig config();
    FeedAccess   feeds();
    void onSchedule(Duration every, Runnable task); // ShedLock-wrapped
}
interface DocStore {
    <T> Optional<T> get(Scope scope, String key, Class<T> type);
    void            put(Scope scope, String key, Object value);
    boolean         delete(Scope scope, String key);          // idempotent
    List<DocEntry>  query(Scope scope, String keyPrefix);     // keyed: (key, value)
    List<OwnedDocEntry> queryAcrossUsers(String keyPrefix);   // backend-only, read-only, no HTTP surface
}   // Scope = (SITE|FEED|SEASON|EPISODE|USER, id)
    // USER is host-owned: its id is always the sentinel "me" and the host substitutes the authenticated
    // caller. A plugin cannot name another user's partition, and an anonymous caller has none.
    // A backend thread has no caller, so every DocStore method above throws UnsupportedOperationException
    // for a USER scope — reads included. Aggregates go through queryAcrossUsers, which names each owner:
record DocEntry(String key, JsonNode value) {}
record OwnedDocEntry(UUID userId, String key, JsonNode value) {}   // userId is host-resolved, never client-supplied

// Optional extension point (a plugin MAY implement it; wiki does in v1):
interface ShareMetadataProvider {
    Optional<OgMeta> metaFor(String subpath);   // subpath under /p/<pluginId>/
}
record OgMeta(String title, String description, String imageUrl) {}  // imageUrl nullable

interface SitemapProvider {          // optional extension point (§6.6); wiki implements it
    List<SitemapUrl> urls();         // absolute-path locs under /p/<pluginId>/…
}
record SitemapUrl(String loc, Instant lastModified) {}   // lastModified nullable
```

### 7.5 Frontend contract (in the SDK, TS) – the `ctx`
The host mounts the custom element and sets `ctx`. This is the **entire** interface a plugin author has to learn:
```ts
interface PluginContext {
  scope:    { type: 'site'|'feed'|'season'|'episode'; id: string };
  episodes: string[];                 // EpisodeRef IDs in scope (resolved by the host)
  episode?: { status: 'PLANNED'|'PUBLISHED'|'WITHDRAWN' }; // on episode scope
  user:     { id: string; role: Role } | null;
  api:      PluginApiClient;          // calls /api/plugins/<id>/* with auth token
  schema:   SchemaClient | null;      // read-only; null unless the manifest declares a schema (§7.6)
  blobs:    BlobClient | null;        // upload/list/delete; null unless the manifest declares `blobs` (§11.1)
  consent:  { has(cat: string): boolean; onChange(cb: () => void): void };
  filter:   { current(): FilterState; onChange(cb: (f: FilterState) => void): void }; // read-only
  player:   { currentTime(): number; seekTo(s: number): void; on(ev, cb): void };     // for sync plugins
  route:    { path: string; onChange(cb: (p: string) => void): void;     // subpath under /p/<pluginId>/ (§6.4)
              navigate(subpath: string, opts?: { replace?: boolean }): void };  // within that subtree only
  links:    { episode(slug, opts?): string; feed(slug, opts?): string }; // host URL shapes, strings only
  locale:   { current(): string; onChange(cb: (l: string) => void): void }; // active UI locale (§12.7)
  progress: { get(episodeId: string): Promise<number | null> };          // core listening progress, seconds (§6.5)
  theme:    ThemeTokens;              // host colors/spacing as CSS variables
}
```
**Important:** plugins *consume* filters, they don't *define* them. Filter axes (season, tags, sorting) belong to the host.

**`ctx.scope` stays four-valued.** `USER` (§7.6) addresses storage, not a page — a slot is mounted into a named region of a view and there is no user view — so it appears in a `data/{scopeType}/{scopeId}/…` path and never in `ctx.scope`. A component reading per-user data addresses `data/user/me/…` explicitly while its `ctx.scope` remains whatever page it is on.

**`route.navigate` is the only outbound handle on this context**, and it is namespace-confined by the *host*, not by the plugin's good behaviour: the subpath is resolved under `/p/<pluginId>/`, a leading `/` is stripped and `..` segments are dropped, so another plugin's route or a core one is unnameable rather than merely refused — the same property `ctx.schema` has for tables. It exists because a `page` plugin owns a URL subtree and had no supported way to move inside it: an `<a href>` is a full document load that re-fetches the shell, the plugin registry and every plugin bundle, and the workaround that *worked* (`history.pushState` plus a synthetic `popstate`) silently coupled plugins to the host's router choice. Keep the real `href` on links — middle-click, "open in new tab" and crawlers need it; `navigate` only takes over the plain-click path.

### 7.6 Generic store + schema provider
- **Access floor:** declared in the manifest (`"data"`, §7.2), never derived from slots. The `USER` scope is exempt from **both** floors — see below.
- **Authorization is per plugin, not per document.** A floor says *who*, never *which key*: clearing `writableBy` grants every key in every **shared** scope (`SITE`/`FEED`/`SEASON`/`EPISODE`), including one another caller wrote, because nothing binds a shared document to its author. Two rules narrow that, and neither closes it in general.
  - **`data.backendOwned`** (§7.2) reserves the keys the plugin's *backend* authors. Without it a plugin cannot express "this key is mine": the host cannot tell a scheduled write from a `curl`, so any caller above the write floor could forge a value the backend computed — a site-wide aggregate, a per-episode count — and have it served to every visitor as though the plugin had produced it. Reads are untouched, since the point is to publish a value rather than hide it, and `ctx.store()` is unaffected — enforcement is on the HTTP surface only, so the `DocStore` contract does not change. It is **ignored for `USER` scopes**, even under a bare `*`: a backend cannot write a partition there at all, so reserving one would reserve it for nobody. A declaration does **not** remove a value a client wrote before it existed, so a plugin writes its computed keys in `register(ctx)` as well as on a schedule. A malformed entry **rejects the plugin at load** (§7.8) rather than being dropped — a dropped entry loads a plugin whose manifest claims a key is the backend's while the host enforces nothing, which is the worst way for a security declaration to fail.
  - The **`USER` scope** gives per-user data a partition no request can name (below).
  - **What remains open:** an unreserved key in a shared scope still has no owner, so on a multi-podcaster install one tenant can overwrite or delete another's plugin data. Closing it needs per-record ownership, which needs an owner in the domain model — feeds do not have one yet (§5, roadmap §14). Until then a plugin that needs the guarantee reserves the key or keeps the data in `USER` scope, and a plugin author should know the host does not otherwise make it.
- **Default store:** `plugin_data(plugin_id, scope_type, scope_id, key, value JSONB)` + GIN index. Scales comfortably to thousands in Postgres. Optional: a plugin declares **indexable fields** (expression index) as an escape hatch. Writes are **last-write-wins** — plugins needing stronger concurrency control model it in their data design. **Per-user data belongs in the `USER` scope, never in the key.** A key is client-supplied, so a convention like `mark:<userId>:cell` is an access-control decision the host cannot enforce: any caller above the plugin's read floor can address another user's key directly, and scope ids are public slugs, so nothing has to be guessed. The `USER` scope is addressed as `user/me` and resolved server-side from the session, so the partition a caller reaches is the only one they can name. **Neither floor applies to it.** `readableBy` does not, in either direction: no floor makes another user's partition readable, and none stands between a caller and their own. `writableBy` does not either — a write floor protects the *shared* surface, where one caller's write is visible to others and can overwrite theirs, and a `USER` partition is unshared by construction, so there is nobody to protect from it. Gating it would also re-create the coupling this rule exists to remove: a plugin needing a per-user feature would have to declare `writableBy: "fan"`, opening its *shared* scopes to fan writes — the same "one setting forced by an unrelated need" failure as the old minimum-across-slots read floor, moved to the write side. So any authenticated caller reads and writes their own `user/me` whatever the plugin declares; any other `user` id is a **400** (never a silent substitution) and an anonymous request a **401**, since there is no session to resolve. The partition is flat — one per user, not one per user *and* entity — so the entity goes in the key (`mark:<episodeSlug>:cell`). Aggregating across users is the backend's job via `queryAcrossUsers` (§7.4), not the client's: a summary each browser reports about itself is a summary of whatever users typed.
- **Schema provider (for relational plugins like the wiki):** the manifest declares entities + indexed/FTS fields; the **platform** provisions dedicated, namespaced tables (`plugin_wiki_*`) via a **platform-managed migration runner** and cleans up on uninstall. (Implementation note: Flyway itself is static — dynamic per-plugin DDL is applied programmatically with the platform's own bookkeeping table; "never trust plugin DDL" still holds.) **The plugin never writes DDL.** Every plugin may use the mechanism; most declare nothing.
  ```json
  "storage": { "schema": { "page": {
      "slug": "string:indexed:unique", "title": "string",
      "markdown": "text:fulltext", "updatedAt": "timestamp:indexed" } } }
  ```
- **Reading a schema from the frontend:** provisioning without access is half a feature — the full-text index the platform builds exists for a search box, and the search box is in the browser. So the host serves a **read-only** surface per plugin, mapping one-to-one onto `SchemaStore` and reached through `ctx.schema` (`null` for a doc-store plugin, mirroring `ctx.schema()`):
  ```text
  GET /api/plugins/{id}/schema/{entity}?where=&orderBy=&page=&size=
  GET /api/plugins/{id}/schema/{entity}/search?field=&q=&where=&orderBy=&page=&size=
  GET /api/plugins/{id}/schema/{entity}/count?where=
  GET /api/plugins/{id}/schema/{entity}/{rowId}
  ```
  A query is *described*, never written: `where=field:op:value` and `orderBy=field:asc|desc` name **declared** fields, the host resolves them against that plugin's own manifest and builds the statement, and every value is bound as a parameter — so this adds no injection surface over what `SchemaStore` already had. Values are read against the field's declared type, so a malformed one is a **400** rather than a driver error. Access is the same `data.readableBy` floor as the doc surface, and there is no `USER` exemption to make here because schema tables are per plugin and these paths carry no scope. An undeclared **entity** is a **404** (over HTTP it is a path segment, i.e. an address); an undeclared **field**, an unreadable value, or `search` on a field that is not `:fulltext` is a **400**. Paging follows the doc surface (`page` from 0, `size` 50, capped at 200).
- **No schema writes over HTTP, and this shapes plugin design.** A v1 plugin authors no routes (§7.4), so no plugin code runs at request time — there is nowhere to enforce slug uniqueness, append a revision atomically, or reject malformed input. Exposing writes would hand clients direct row access with *no plugin code in the path*, which is worse than the doc store's position rather than better. The plugin's **backend stays the only writer of relational truth**: a frontend that must write puts a document in the doc store and the backend ingests it on its schedule. The consequence is that such a write is **eventually consistent** — an editor does not see its own save through `ctx.schema` until the next tick, and a plugin with an editing UI (the wiki) must design for that with an optimistic render or an explicit saving state. Changing this needs a request-time plugin hook, which is a v1-contract decision and not a gap to be filled quietly.
- **Not rate-limited.** `GET /api/plugins/**` is outside the rate limiter, which covers auth and upload paths, so an anonymous full-text search is capped only by `size`. Same posture as the doc-store list endpoint — but full-text is more expensive per call, so an operator exposing a large corpus should expect to front it.

### 7.7 On-request aggregation
Feed/season-level aggregates (e.g. stats sums) are computed **lazily**, the Web Component shows a loading bar meanwhile, the result is cached in the store and invalidated on new episodes.

### 7.8 Plugin lifecycle & failure isolation
Plugins are trusted, but **a broken plugin must not take the site down**:
- **Startup:** if a plugin fails to load (exception, bad manifest, `platformApi` mismatch), core **disables that plugin and keeps booting**, with a prominent admin warning — never a crashed host.
- **Frontend:** the shell wraps **every slot mount in an error boundary** — a throwing Web Component blanks only its own tile (with a small "plugin error" note), never the page.
- **Removal semantics:** deleting a plugin folder = plugin **dormant**; its data (doc store / schema tables) is **retained**. Actual data removal is an explicit admin action ("purge plugin data") — for both storage kinds. The schema provider's cleanup runs on purge, not on mere absence.

---

## 8. Auth & Identity

### 8.1 Login
Spring Security `oauth2Login`, **social-only to start**: Discord (clean OAuth2), Patreon (custom OAuth2 client via its own `OAuth2UserService`), Google optional. **No passwords** (GDPR). Password login stays cheap to add later (an extra `DaoAuthenticationProvider`).

### 8.2 Model
```
User           (id UUID, display_name, avatar_url, role, created_at)
  └─ LinkedIdentity (provider, external_id, email, email_verified, PK(provider, external_id))
```
The stable key is `(provider, external_id)`, **not** the email. Keep the Discord `external_id` (future: bot/role sync).

### 8.3 Account merging (security rule)
On login `(provider P, external_id E, email Q, verified V)`:
1. `(P,E)` exists → log in.
2. `(P,E)` new **and a user is logged in** (linking from settings) → attach identity. **Always safe.**
3. `(P,E)` new, nobody logged in → only merge if **both emails are verified**; the conservative variant is better: **do not merge silently**, instead "please log in with the existing method and link in settings". With `V==false` **never** merge → new user.
In short: **auto-link only with two verified emails or a logged-in user, otherwise explicit.**

### 8.4 Settings: provider list
`GET /api/me/identities` → per configured provider `{provider, linked, email?, since?}`. UI shows a green check when linked, otherwise a "Connect" button (flow = merging case 2). **The last remaining identity cannot be removed** (lockout protection).

### 8.5 Sessions & roles
- **httpOnly cookie + server-side session** (Spring Session). **No JWT** (revoke/ban/role change must take effect immediately). In-memory in v1 → **Redis from v3** (app instances stay stateless). Cookie sessions require **CSRF protection** (Spring's `XSRF-TOKEN` cookie pattern for the SPA) and `SameSite=Lax`.
- RBAC, `role` on the `User`: **ADMIN** (site config, users, plugin activation) · **PODCASTER** (bingos, wiki, episodes, feeds/Patreon sources, planned episodes) · **FAN** (fill in/view). Anonymous: read only.
- Bootstrap admin via env on first start; afterwards the admin promotes fans → podcasters.
- **Personal access tokens** (podcaster-scoped) for automation (e.g. MAT upload).

---

## 9. Patreon (v2) – three independent roles

Patreon appears in **three mutually independent places**; they die independently:
1. **Login provider** — pure identity, the most stable API surface. **Stays permanently** (for future supporter goodies).
2. **FeedSource** — pulls the **free** episodes of the campaign into the unified feed. Needs creator credentials.
3. **Tier resolver** — maps a logged-in user to their tier; enables "view on Patreon" gating. The most fragile.

**API quirk:** the user token only yields the entitled amount in cents via identity, **not** the concrete tiers — those come from the members endpoint with the creator token. So **creator-token sync**: the podcaster stores creator OAuth (encrypted at rest), picks the campaign(s) → that is both the FeedSource config (#2) and activates the resolver (#3). A periodic sync `members` → mapping `patreon_user_id → tier, status`. Login join instead of a per-request API call; updates via webhook/sync.

**Graceful degradation:** if the API dies → resolver `unavailable`, locked episodes still render as "view on Patreon" without personalized unlock; login (#1) is untouched.

---

## 10. Access / Gating

Each `EpisodeRef.access = PUBLIC | TIER(ref)`. **The host makes the access decision, not the plugin.** At render time `unlocked = userEntitlement.satisfies(access)`.
- v1 (RSS only): everything PUBLIC.
- v2: free Patreon episodes PUBLIC (always visible); paid ones as a **locked stub** with a "view on Patreon" CTA, real link on matching tier.
- PLANNED episodes: "upcoming episode" stub, no audio, bingo open.
Plugins only get the episode list the user may see; `ctx.user` stays slim.

---

## 11. Storage / BlobStore

One **`BlobStore` interface** in core. Branding is the first customer (Postgres behind it), audio the heavy future customer — through the **same door**.
```java
interface BlobStore {
    BlobRef put(String namespace, String key, InputStream data, String mime);
    BlobContent get(BlobRef ref);              // STREAMING, not "all bytes"
    void delete(BlobRef ref);
    List<BlobMetadata> list(String namespace, int page, int size);  // a backend answers for its own
    long count(String namespace);
    long usedBytes(String namespace);          // called on every upload — quota (§11.1)
    int  deleteNamespace(String namespace);    // purge (§7.8)
    Optional<String> directUrl(BlobRef ref, AccessContext ctx); // empty = serve it yourself
    BlobCapabilities capabilities();           // supportsRange, supportsPresignedUrls
}
```
- **Streaming-first + range requests** from day one (a 5 KB favicon like a 100 MB audio file).
- **Namespace routing:** `branding/*` may stay in Postgres forever, `audio/*` later S3/CDN. One interface, one backend per namespace, chosen in configuration (`mosaicast.blobs.namespaces`) — exact namespace first, then longest `/` prefix, so `plugin` covers every plugin without naming plugins that are not installed yet. A rule naming a backend that is not registered **fails startup**: falling through to the default would put files in a store nobody chose, with the symptom appearing long after the cause.
- **A backend is self-contained.** It answers for its own namespaces — listing, count, total size, delete-all — rather than sharing an index in Postgres. Two stores of the same truth can disagree and nothing can then say which is right, and the alternative was worse in practice: the plugin surface reached past the interface into `BlobRepository`, so a non-Postgres backend would have accepted uploads and reported an empty library with zero usage, leaving the quota unenforced and nothing failing loudly.
  - The cost is that each backend owes those answers *well*, and that is the backend's problem rather than the interface's: Postgres sums an indexed column, a filesystem walks a directory, an object store keeps a counter instead of paginating its own prefix on every upload. `usedBytes` is called on every write, which is the constraint that shapes the choice.
  - Listing is **offset-paged**, matching the plugin HTTP surface. That is a real constraint on an object store, which pages by continuation token; a media library is browsed from its first page, so walking to a deep one is a cost such a backend may cap. Moving to cursor paging is an SDK contract change and belongs with the backend that needs it, not before.
- **`directUrl` is the seam that makes an object store worth having.** A backend that can serve bytes without the app in the path says so; Postgres returns empty and callers serve the bytes themselves. Proxying every byte gives up most of the reason to move them out of the database. It is also where tier-gated audio (§10) signs a URL *after* the entitlement check, which is why it takes an `AccessContext` and cannot be cached per blob.
- v1: `PostgresBlobStore` (BYTEA). Later: `S3BlobStore`, `FilesystemBlobStore` (config switch).
- Tier-gated audio (future): expiring presigned URLs only after the entitlement check (`AccessContext`).

### 11.1 Plugin file storage

Branding was the only customer for a long time, and the asymmetry that left was hard to defend: a plugin's CSP allows an image from **any** host on the web (§12.5), and there was no way to accept one from the site's own podcaster. A wiki wants diagrams; "find an image host first" is not an answer. So plugins get a scoped surface over the same store — the namespace `plugin/{id}`, computed by the host from the plugin id and never passed in, which is the property `SchemaStore` has for tables and `ctx.route.navigate` has for URLs.

```text
POST   /api/plugins/{id}/blob         multipart; → { ref, url, mime, size, filename, updatedAt }
GET    /api/plugins/{id}/blob         paged, newest first
GET    /api/plugins/{id}/blob/quota   used / allowed, as this install sees it
GET    /api/plugins/{id}/blob/{ref}   streaming; Range + ETag
DELETE /api/plugins/{id}/blob/{ref}   idempotent
```

- **Declared, never derived.** A manifest `blobs` block (`maxFileBytes`, `quotaBytes`, `mimeTypes`) is the opt-in, so a plugin's appetite for disk is readable by whoever installs it. Absent → `ctx.blobs` is `null` and every path is a **404**, indistinguishable from an unknown plugin, exactly as the schema surface answers a doc-store plugin. Reachable through `ctx.blobs` (TS) and `ctx.blobs()` (Java) — the latter mostly so a backend can collect the orphans nothing else collects.
- **Who decides how much room a plugin gets, in order:** an **admin's grant** in the plugin settings UI, else the **manifest's** ask, else the install's **default** — then clamped by an optional operator **hard ceiling**, which is unset by default. The quota endpoint is the only honest source for what came out of that.
  - An admin's grant **replaces** the manifest's ask rather than being minimised with it. A manifest says what a plugin's author guessed it would need on an install they have never seen; an admin raising it is looking at this install's real usage. Minimised, a grant of 2 GB against a manifest asking 256 MB would yield 256 MB and no explanation — a control that appears to work and does nothing. The manifest still decides when nobody has said otherwise, and remains what an installing operator reads to see what a plugin is asking for.
  - The **hard ceiling** exists because ADMIN is a role inside the application (§8.5) while the properties are infrastructure. Where those are not the same person, an operator needs a bound the UI cannot cross; where they are, leaving it unset is right. A grant past it is **clamped, not refused**, and the clamped value is what is stored — an admin is never shown a number that means something else.
  - **The MIME allow-list is not grantable.** No admin decision widens it, because what a file may *be* is a security question (§12.2) rather than a capacity one.
  - Storage is **per plugin**: a wiki accumulating diagrams and a bingo plugin storing nothing have no reason to share a ceiling, and "the wiki has outgrown its space" is an ordinary operational event rather than a redeploy.
- **Writes are the point here, and that is why this differs from §7.6.** The case against schema writes over HTTP is that no plugin code runs at request time to enforce a relational invariant. A file has none, so `data.writableBy` plus a quota is the whole authorization story. Reads take `data.readableBy` — one floor pair, three surfaces. `backendOwned` does not apply: it reserves *keys*, and a caller never names one — a ref is a UUID the host mints per upload, so an upload can never overwrite an existing file, including another tenant's.
- **What the bytes say is what gets stored**, in this order: size, the declared type, the *actual* type read from the leading bytes, then the quota. One shared sniffer serves branding and plugins, and **SVG has no case in it** — that is what makes it unstorable rather than merely undeclared (§12.2). Refusals are **415** (type) and **413** (size or quota), worded apart because the fixes differ.
- **Purge removes files** alongside documents and schema tables (§7.8), matched on the namespace exactly rather than on a name prefix.
- Blobs are served **same-origin** under `/api/`, so a plugin rendering its own upload needs no CSP host and makes no consent decision — which an external image URL cannot say. This is the answer to the asymmetry above, not merely a workaround for it.

---

## 12. Branding & Theming

### 12.1 SiteConfig (DB, editable by admin – no config files needed)
Single-row now, tenant-keyed later: `site_name`, `logo_asset_id`, `favicon_asset_id`, optional dark logo, **theme_seed** (accent + mode policy: light/dark/system). Editable by ADMIN only. `GET /api/site` returns name + branding + seed at boot.

### 12.2 Assets
Via `BlobStore` (namespace `branding/`). Served at `/branding/logo`, `/branding/favicon` with an **ETag** from `updated_at` (a change propagates immediately, otherwise cached). `index.html` points `<link rel="icon">` at the dynamic endpoint.
**Security:** uploaded **SVGs are an XSS vector** → either sanitize server-side or restrict to raster (PNG/ICO) and serve with `Content-Disposition`/CSP.

### 12.3 Light/dark + seed generator
- **Semantic tokens** as CSS custom properties: `--mc-bg, --mc-surface, --mc-text, --mc-text-muted, --mc-accent, --mc-accent-contrast, --mc-border` (+ accent-2). Light/dark = two value sets, `data-theme` on the root. **Shell AND plugins read the same properties** → they re-theme automatically.
- **Icons ride the same channel: `--mc-icon-*`.** The shell's icon set is generated from a whitelist and a deliberate subset is published as custom properties, so a plugin's Web Component draws the shell's icons with **no SDK import, no `platformApi` bump and no version skew** — a plugin built against an older SDK picks up an icon added here the day it lands. Consumed as a **mask**, never as `background-image`, so the icon takes the caller's own colour and re-themes with everything else:
  ```css
  mask-image: var(--mc-icon-close); mask-size: contain; background: currentColor;
  ```
  The published names are a **contract**, exactly like the colour tokens: add freely, rename never. The set is deliberately provisioned ahead of demand — a plugin builds against a *released* core, so an icon that is not already published is one its author cannot add without waiting for a core release.
- **Seed:** the admin sets **one accent**, the system generates the rest. **OKLCH** (perceptually uniform) + **WCAG contrast clamp** (text/bg ≥ 4.5:1), so no unreadable theme can result.
- **No theme flash:** a tiny inline script in `index.html` sets `data-theme` + accent synchronously from the site payload before first paint.
- **Previews:** the branding panel shows the logo on a light AND a dark swatch; the theme seed renders live as the accent is dragged. Both client-side.

### 12.4 Logo→theme (stage 2, moderate)
On logo upload, **suggest** an accent: for SVG parse the `fill` values (cleaner than rasterizing), for PNG quantize (k-means/median-cut, Vibrant) → **not** the most frequent, but the **most saturated** color. Feeds the same seed generator. **Extract → suggest → admin confirms/adjusts.** Never auto-lock fully.

### 12.5 Consent (platform service)
Strictly necessary cookies (session/CSRF/LB) need **no** consent → the core runs banner-free. Plugins that load third-party content with cookies declare categories + external sources in the manifest → the host generates the cookie/privacy notice + admin audit from that. A plugin loads consent-requiring resources only after `ctx.consent.has(cat)`, before that a click-to-load placeholder. Self-host fonts, cookieless analytics (Plausible/Umami).

**What consent actually enforces.** `ctx.consent.has()` is advisory — a plugin shares the page's JavaScript realm and can simply not call it — so the declaration is also narrowed into the **CSP**: a declined category takes its `hosts` out of `script-src`/`frame-src`/`connect-src`, and the request then fails at the network layer rather than on plugin manners. **Images and media are the exception**: `img-src`/`media-src` allow any `https:` origin, because episode artwork and audio come from whatever host a podcaster's feed points at. That leaves an `<img>` to an arbitrary origin working as a one-way beacon, past `connect-src` and past consent — a residual the host makes closable rather than closed, by narrowing both directives to the origins the site's own content references plus the consented plugin hosts (opt-in, since a derivation cannot see a host nothing references yet, and most media CDNs redirect to one it never saw).

### 12.6 Legal pages (mini-CMS, jurisdiction-agnostic)
Publicly operated sites need jurisdiction-specific legal documents (e.g. Germany: Impressum + Datenschutzerklärung; other countries: other sets). Core therefore ships a **generic legal-pages mechanism instead of hardcoded documents**:
- Admin creates any number of **static pages** (markdown; slug, title), shown automatically as **footer links**, order sortable.
- Pages are **translatable per locale** (§12.7): one logical page, one markdown body per language, served in the active UI locale with fallback to the default locale.
- A page can carry a **role marker** (`privacy`, `imprint`, `terms`, …); the consent service (§12.5) links to the page marked `privacy`.
- Markdown is rendered sanitized (same care as wiki content).
- Docs note for operators: German operators typically need Impressum + Datenschutzerklärung. **Mosaicast ships the mechanism, not legal texts** — bundling texts would be false safety. *(Not legal advice.)*

**`/about` — what this is, what it runs, what it is built on.** A shipped route, not an admin-authored page, because a visitor to a *bare* install is the one most likely to ask "what is this site?" and least likely to find an answer. Four sections, each taking up the question the one before it raises:
1. **This instance** — the operator's own words. It leads because someone arrived at *this podcast's site*, not at a piece of software; opening with a paragraph about the platform answers a question nobody asked.
2. **What Mosaicast is** — fixed, translated text with the running version and a link to the source. This is also where the AGPL's obligation to offer source becomes something a network user can actually act on, rather than a clause with nowhere to click.
3. **Plugins** — what this install runs, with whatever credit each declared (§7.2). Anonymous: what an install runs and under what terms is not privileged information.
4. **Built with** — the third-party work the project stands on, generated from one source shared with the repository's notices file so the two cannot drift. Curated and deliberately generous rather than a transitive dependency dump, and it credits build and test tooling too.

Every section is **absent-tolerant on its own**, so an install with no plugins, no About text and no legal pages still renders. The operator's blurb reuses this mini-CMS under an `about` slug — that buys per-locale markdown, sanitising, locale fallback and the existing editor for nothing, where a `SiteConfig` column could not do per-locale text without reinventing the translation table. It is **not** a legal page, so its role marker keeps it out of the footer's legal group; it gets its own link there and in the info menu.

### 12.7 Internationalization (i18n)
Built in from the start so the project can grow international and translation is an easy first contribution.
- **Catalogs:** one JSON per language (`locales/en.json`, `locales/de.json`). **English is the source language**; German ships in v1. Adding a language = copy `en.json`, translate, PR (documented in CONTRIBUTING). Library: **i18next** (interpolation, plurals) in the shell.
- **Locale resolution order:** 1) explicit user choice — **works anonymously** (persisted in localStorage/cookie; additionally on the profile when logged in), 2) browser (`Accept-Language` / `navigator.language`), 3) site default from `SiteConfig`. A visible **language switcher** (footer/top bar) requires no login.
- **Plugins:** get `ctx.locale` (+ `onChange`) and a small SDK helper (`createPluginI18n(catalogs)`); each plugin ships its own `locales/*.json` in its frontend bundle — same convention as the shell.
- **Boundaries:** **feed content stays in its original language** (titles/descriptions are data, not UI); dates/numbers format via `Intl` per locale; backend error payloads stay English (the UI translates); legal pages are maintained per locale (§12.6).

---

## 13. Non-Functional

- **Scaling v3:** app instances **stateless** (Redis session, DB as the only truth), periodic jobs **ShedLock**. Moving to multiple instances behind an LB = config, not a rewrite.
- **Observability:** Spring **Actuator** `health`/`info` (compose healthcheck + uptime monitoring hook), structured logging. Nothing fancier in v1.
- **API conventions:** the REST API is **internal** in v1 — the SDK is the only public contract, so no API-versioning machinery. Errors as **RFC 7807** `application/problem+json` (stable `type` codes; the UI translates). **List endpoints paginate from day one.**
- **GDPR:** store minimal (provider, external_id, optional email/name/avatar), no passwords. On account deletion **pseudonymize** public bingo contributions (cut the identity link, aggregates/leaderboard stay correct), don't hard delete. Not a lawyer — have the privacy policy reviewed.
- **Security:** creator/OAuth tokens encrypted at rest. SVG sanitizing. Presigned URLs for gated audio. **Baseline security headers** (CSP, X-Content-Type-Options, Referrer-Policy). **Upload limits** (max body size; archives additionally guarded against zip-slip and zip bombs — see the stats brief). **Basic rate limiting** on auth endpoints and uploads.
- **Deployment:** Docker Compose (app, postgres, caddy/traefik; redis from v3). Secrets via `.env`, not committed. **Backups from day one:** nightly `pg_dump` of the database (host cron or sidecar) + keeping a copy off the VPS; test a restore once.

## 13.5 Testing Strategy

Tests are **layered by tier**, not dogmatically blanket. Focus on risk and contract.

- **SDK (`mosaicast-plugin-sdk`):** test only its own helpers (`defineMosaicastElement`, version constant). **Ships a test kit as part of the contract** (below).
- **core:** real unit tests at the **risk points** — reconciler (3 cases **incl. PLANNED binding**), account **merging rules** (§8.3), fuzzy match, theme seed **contrast clamp** (WCAG), BlobStore range. Plus **integration tests with Testcontainers** (Postgres + Flyway + plugin loading via PF4J). **Shell:** component tests (Vitest + Testing Library) for **slot mounting** and theme token application.
- **Plugins:** unit tests **against the test kit** — no core, no Postgres needed.

### Test kit (in the SDK, so plugin testing is trivial)
The contract ships its test doubles. Production plugin code does **not** bundle them (separate artifact / dev subpath).
- **Java `plugin-testkit`** (own artifact, `testImplementation` only): `FakePluginContext` with `InMemoryDocStore`, `FakeFeedAccess(Map<Scope,List<String>>)`, `MapPluginConfig`, synchronous `onSchedule`. → test a plugin backend without infrastructure: build the fake context, call `register`, assert store contents.
- **TS `@mosaicast/plugin-sdk/testing`** (dev subpath): `makeMockCtx(overrides)` returns a `PluginContext` with a fake `api` (records calls / canned responses), in-memory `consent`/`filter`/`player`, theme tokens. → mount the Web Component with the mock ctx, assert DOM.

---

## 14. Version Roadmap

- **v1:** RSS feeds, unified feed + filter, season, EpisodeRef/snapshot, PLANNED lifecycle, social login (Discord) + account merging, RBAC, SiteConfig/branding + theming/seed, BlobStore (Postgres), plugin system, sequential nav + RelatedProvider (tags/season/fuzzy), plugins: **bingo, stats, wiki**.
- **v2:** Patreon (login/FeedSource/tier), tier gating, **feed ownership** (below), dedup/merge UI (fuzzy), logo→theme stage 2, embedding-related (`pgvector`), transcript display (MAT transcripts are already uploaded — accessibility + SEO nearly for free), Podcasting 2.0 namespace (`<podcast:chapters/transcript/funding>`), first-party cookieless analytics, GDPR data export, oEmbed embed player.
- **v3:** Redis sessions/cache, multiple LB instances, multi-tenant preparation; far future: native audio host (BlobStore `audio/*` → S3, own FeedSource, custom RSS).

**Feed ownership (v2).** A `Feed` has no owner, and **PODCASTER** is a single global role (§8.5): every podcaster can edit every feed, and — because the plugin doc store authorizes per plugin rather than per document (§7.6) — tamper with plugin data on any feed, season or episode. On a single-podcaster install that is invisible. The moment there are two, it is one tenant reaching another's, with no way to express the boundary.

Deliberately **v2, not v3.** "Multi-tenant preparation" is a v3 heading, but this is not preparation: the exposure exists as soon as a v1 install promotes a second podcaster, which is an ordinary thing to do. It is also the prerequisite the doc-store gap is waiting on — per-record ownership needs an owner to point at — so scheduling it later leaves §7.6's residual open across two releases.

Shape, for whoever picks it up: an owner on `Feed` (nullable, so existing installs stay valid), ownership carried down the scope tree (a season/episode belongs to its feed's owner), enforcement on `/api/admin/feeds/**` and on shared-scope plugin writes, and ADMIN unaffected. Whether a feed may have several owners, and whether ownership implies exclusivity or merely attribution, are open — the answer decides whether §7.6 gets "only the author may overwrite" or "only the owning tenant may".

---

## 15. Naming Conventions (carried through initially, not enforced)

- **Repos:** `mosaicast-core`, `mosaicast-plugin-sdk`, `mosaicast-plugin-sample`, `mosaicast-plugin-<name>`.
- **npm:** scope `@mosaicast/...` (e.g. `@mosaicast/plugin-sdk`); community plugins unscoped `mosaicast-plugin-<name>` (the `-plugin-` infix = discoverable, like eslint).
- **Java:** `dev.mosaicast.core.*` (host), `dev.mosaicast.plugin.<name>.*` (plugins).
- **Manifest `id`:** short, unprefixed (`bingo`, `stats`, `wiki`).
- **Flavor:** plugins may be called "tiles" in UI/docs; the technical convention stays `*-plugin-*`.
