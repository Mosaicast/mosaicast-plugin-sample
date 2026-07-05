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
Title, description, audio URL, pubDate **and runtime/duration** (`<itunes:duration>`/enclosure). **Overwritten** on every fetch from the raw feed, only read-through cached. So a description change in the RSS propagates automatically and never lives in the DB as truth.
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

**Filter state lives in the URL** (query params, e.g. `?season=2`): filtered views are shareable/bookmarkable, the back button works, and the server can read the params when rendering share metadata (§6.4). Plugins still consume filters read-only via `ctx.filter`.

### 6.2 Sequential navigation (always shown)
Previous/next episode are **core navigation, not related and not a plugin** — always shown (detail page + player). Order: by season + episode no., fallback pubDate. **The player auto-advances to the next episode when one ends** (same sequence logic). Must work with zero plugins.

### 6.3 RelatedProvider (core, swappable strategy – not a plugin)
Interface: `related(EpisodeRef ctx, int limit) → List<EpisodeRef>` with capabilities.
**v1 strategy (deterministic, no ML):** pinned episodes (podcaster-curated in admin) win, otherwise a weighted blend of **same season** (recency), **shared tags/keywords** (`<itunes:keywords>`/`<category>` or manual), fuzzy title. Exclude: current episode, PLANNED, WITHDRAWN; locked ones at most as a lock stub. **Computed on-request + cached**, invalidated on new episodes.
**Future (v2):** an embedding strategy (`pgvector`, cosine) or a recommender plugin overrides the provider — the sidebar widget doesn't change. Runs over `EpisodeRef` → automatically respects dedup + tier gating.

### 6.4 Deep links & share metadata (SEO/OG)
The shell is an SPA, but link scrapers (WhatsApp/Discord/Facebook) **do not run JS**. So core injects **OpenGraph/Twitter meta tags server-side** into `index.html` per URL before serving it.
- **OgResolver per scope:** episode → episode title + episode image (fallback: podcast cover); feed/site → cover + site name + description; season → "site name – Season N". The resolver reads the **query params** (§6.1), so a shared filtered view gets matching meta.
- **Plugin deep links:** the host reserves **`/p/{pluginId}/*`** and passes the subpath to the plugin as `ctx.route` (read-only + `onChange`). That makes plugin content (e.g. a wiki page) linkable and shareable at all.
- **`ShareMetadataProvider`** (optional backend extension point, §7.4): when serving a `/p/{pluginId}/…` URL, core asks the plugin for title/description/image; no provider (or no match) → site-level OG fallback. The wiki implements it in v1 as the reference.

### 6.5 Listening progress (core service)
Per-user playback progress is a **core service, not a plugin concern**: the player stores position per episode (anonymous → localStorage only; logged-in → server-side), **resumes playback** where the user left off, and exposes read access to plugins via `ctx.progress` (e.g. bingo's spoiler protection). One source of truth for "has this user heard this episode".

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

**Configurable plugins path (no forced folder layout):** core reads the plugins folder from `MOSAICAST_PLUGINS_DIR` (env/property, default `./plugins`). Plugins know **nothing** about it — their `build.sh` only writes to their own local `dist/` and never touches core. Distribution (`dist/` → plugins folder) is a **separate, manual step**; location is free to choose (sibling folder, central folder, Docker volume). An optional `install.sh` in a plugin may shortcut the copy if `MOSAICAST_PLUGINS_DIR` is set — never as a requirement.

> **Known rough edge:** PF4J classloading inside a Spring Boot fat JAR is fiddly. Keeping plugins Spring-free (plain PF4J extensions against the SDK) is the deliberate mitigation; still budget real time for the classloader setup in core (E5) instead of fighting it late.

### 7.2 Manifest (`plugin.json`)
```json
{
  "id": "bingo",
  "version": "1.0.0",
  "platformApi": "1.x",
  "name": "Bingo",
  "backend":  { "basePath": "/api/plugins/bingo", "extensions": ["dev.mosaicast.plugin.bingo.BingoPlugin"] },
  "frontend": { "entry": "bingo.es.js", "elements": ["bingo-episode-card", "bingo-host-board"] },
  "slots": [
    { "scope": "episode", "element": "bingo-episode-card", "placement": "main",    "visibleTo": "anonymous", "order": 100 },
    { "scope": "episode", "element": "bingo-host-board",   "placement": "admin",   "visibleTo": "podcaster" }
  ],
  "storage": "doc",
  "config":  { "fuzzyThreshold": { "type": "number", "default": 0.85, "editableBy": "podcaster" } },
  "consent": { "categories": [], "externalSources": [] }
}
```
- **`platformApi`**: which SDK contract version it was built against. The host **rejects incompatible plugins at startup** (stability anchor).
- **`slots`**: scope + Web Component + `placement` (named region) + `visibleTo` (minimum role) + optional `order`.
- **`storage`**: `"doc"` = generic JSONB store. For the wiki, a schema declaration instead (§7.6).
- **`consent`**: categories + external sources (§12.4).
- **`config`**: declared fields are rendered by core as a **generic admin form** (respecting `editableBy`) — plugins never build their own config UI.

### 7.3 Slots & placements
- Regions (`main`, `sidebar`, `admin`, `card`, …) are defined by the **host shell** per view. Plugins only target existing names; an unknown region → startup rejection.
- **Multiple plugins in one region → stacked** vertically, sorted by `order` (ties: plugin ID alphabetical). No "battle royale". Admin can steer `order` via config.
- `card` placement (episode, compact): plugins show a one-liner on the feed card (stats summary, bingo badge), full rendering only in the detail page `main`. A plugin declares `card` or omits it.

### 7.4 Backend contract (in the SDK)
```java
public interface PluginBackend extends ExtensionPoint { void register(PluginContext ctx); }
public interface PluginContext {
    DocStore     store();    // (scope, key) → JSON, hard-scoped
    SchemaStore  schema();   // only present if the manifest declares schema
    PluginConfig config();
    FeedAccess   feeds();
    void onSchedule(Duration every, Runnable task); // ShedLock-wrapped
}
interface DocStore {
    <T> Optional<T> get(Scope scope, String key, Class<T> type);
    void            put(Scope scope, String key, Object value);
    List<JsonNode>  query(Scope scope, String keyPrefix);
}   // Scope = (SITE|FEED|SEASON|EPISODE, id)

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
  consent:  { has(cat: string): boolean; onChange(cb: () => void): void };
  filter:   { current(): FilterState; onChange(cb: (f: FilterState) => void): void }; // read-only
  player:   { currentTime(): number; seekTo(s: number): void; on(ev, cb): void };     // for sync plugins
  route:    { path: string; onChange(cb: (p: string) => void): void };   // subpath under /p/<pluginId>/ (§6.4)
  locale:   { current(): string; onChange(cb: (l: string) => void): void }; // active UI locale (§12.7)
  progress: { get(episodeId: string): Promise<number | null> };          // core listening progress, seconds (§6.5)
  theme:    ThemeTokens;              // host colors/spacing as CSS variables
}
```
**Important:** plugins *consume* filters, they don't *define* them. Filter axes (season, tags, sorting) belong to the host.

### 7.6 Generic store + schema provider
- **Default store:** `plugin_data(plugin_id, scope_type, scope_id, key, value JSONB)` + GIN index. Scales comfortably to thousands in Postgres. Optional: a plugin declares **indexable fields** (expression index) as an escape hatch. Writes are **last-write-wins** — plugins needing stronger concurrency control model it in their data design (e.g. per-user keys, as bingo does).
- **Schema provider (for relational plugins like the wiki):** the manifest declares entities + indexed/FTS fields; the **platform** provisions dedicated, namespaced tables (`plugin_wiki_*`) via a **platform-managed migration runner** and cleans up on uninstall. (Implementation note: Flyway itself is static — dynamic per-plugin DDL is applied programmatically with the platform's own bookkeeping table; "never trust plugin DDL" still holds.) **The plugin never writes DDL.** Every plugin may use the mechanism; most declare nothing.
  ```json
  "storage": { "schema": { "page": {
      "slug": "string:indexed:unique", "title": "string",
      "markdown": "text:fulltext", "updatedAt": "timestamp:indexed" } } }
  ```

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
    String urlFor(BlobRef ref, AccessContext ctx); // direct/presigned URL or own endpoint
    BlobCapabilities capabilities();           // supportsRange, supportsPresignedUrls
}
```
- **Streaming-first + range requests** from day one (a 5 KB favicon like a 100 MB audio file).
- **Namespace routing:** `branding/*` may stay in Postgres forever, `audio/*` later S3/CDN. One interface, one backend per namespace.
- v1: `PostgresBlobStore` (BYTEA). Later: `S3BlobStore`, `FilesystemBlobStore` (config switch).
- Tier-gated audio (future): expiring presigned URLs only after the entitlement check (`AccessContext`).

---

## 12. Branding & Theming

### 12.1 SiteConfig (DB, editable by admin – no config files needed)
Single-row now, tenant-keyed later: `site_name`, `logo_asset_id`, `favicon_asset_id`, optional dark logo, **theme_seed** (accent + mode policy: light/dark/system). Editable by ADMIN only. `GET /api/site` returns name + branding + seed at boot.

### 12.2 Assets
Via `BlobStore` (namespace `branding/`). Served at `/branding/logo`, `/branding/favicon` with an **ETag** from `updated_at` (a change propagates immediately, otherwise cached). `index.html` points `<link rel="icon">` at the dynamic endpoint.
**Security:** uploaded **SVGs are an XSS vector** → either sanitize server-side or restrict to raster (PNG/ICO) and serve with `Content-Disposition`/CSP.

### 12.3 Light/dark + seed generator
- **Semantic tokens** as CSS custom properties: `--mc-bg, --mc-surface, --mc-text, --mc-text-muted, --mc-accent, --mc-accent-contrast, --mc-border` (+ accent-2). Light/dark = two value sets, `data-theme` on the root. **Shell AND plugins read the same properties** → they re-theme automatically.
- **Seed:** the admin sets **one accent**, the system generates the rest. **OKLCH** (perceptually uniform) + **WCAG contrast clamp** (text/bg ≥ 4.5:1), so no unreadable theme can result.
- **No theme flash:** a tiny inline script in `index.html` sets `data-theme` + accent synchronously from the site payload before first paint.
- **Previews:** the branding panel shows the logo on a light AND a dark swatch; the theme seed renders live as the accent is dragged. Both client-side.

### 12.4 Logo→theme (stage 2, moderate)
On logo upload, **suggest** an accent: for SVG parse the `fill` values (cleaner than rasterizing), for PNG quantize (k-means/median-cut, Vibrant) → **not** the most frequent, but the **most saturated** color. Feeds the same seed generator. **Extract → suggest → admin confirms/adjusts.** Never auto-lock fully.

### 12.5 Consent (platform service)
Strictly necessary cookies (session/CSRF/LB) need **no** consent → the core runs banner-free. Plugins that load third-party content with cookies declare categories + external sources in the manifest → the host generates the cookie/privacy notice + admin audit from that. A plugin loads consent-requiring resources only after `ctx.consent.has(cat)`, before that a click-to-load placeholder. Self-host fonts, cookieless analytics (Plausible/Umami).

### 12.6 Legal pages (mini-CMS, jurisdiction-agnostic)
Publicly operated sites need jurisdiction-specific legal documents (e.g. Germany: Impressum + Datenschutzerklärung; other countries: other sets). Core therefore ships a **generic legal-pages mechanism instead of hardcoded documents**:
- Admin creates any number of **static pages** (markdown; slug, title), shown automatically as **footer links**, order sortable.
- Pages are **translatable per locale** (§12.7): one logical page, one markdown body per language, served in the active UI locale with fallback to the default locale.
- A page can carry a **role marker** (`privacy`, `imprint`, `terms`, …); the consent service (§12.5) links to the page marked `privacy`.
- Markdown is rendered sanitized (same care as wiki content).
- Docs note for operators: German operators typically need Impressum + Datenschutzerklärung. **Mosaicast ships the mechanism, not legal texts** — bundling texts would be false safety. *(Not legal advice.)*

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
- **v2:** Patreon (login/FeedSource/tier), tier gating, dedup/merge UI (fuzzy), logo→theme stage 2, embedding-related (`pgvector`), transcript display (MAT transcripts are already uploaded — accessibility + SEO nearly for free), Podcasting 2.0 namespace (`<podcast:chapters/transcript/funding>`), first-party cookieless analytics, GDPR data export, oEmbed embed player.
- **v3:** Redis sessions/cache, multiple LB instances, multi-tenant preparation; far future: native audio host (BlobStore `audio/*` → S3, own FeedSource, custom RSS).

---

## 15. Naming Conventions (carried through initially, not enforced)

- **Repos:** `mosaicast-core`, `mosaicast-plugin-sdk`, `mosaicast-plugin-sample`, `mosaicast-plugin-<name>`.
- **npm:** scope `@mosaicast/...` (e.g. `@mosaicast/plugin-sdk`); community plugins unscoped `mosaicast-plugin-<name>` (the `-plugin-` infix = discoverable, like eslint).
- **Java:** `dev.mosaicast.core.*` (host), `dev.mosaicast.plugin.<name>.*` (plugins).
- **Manifest `id`:** short, unprefixed (`bingo`, `stats`, `wiki`).
- **Flavor:** plugins may be called "tiles" in UI/docs; the technical convention stays `*-plugin-*`.
