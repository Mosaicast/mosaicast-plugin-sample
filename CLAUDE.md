# Project: Mosaicast – mosaicast-plugin-sample

Reference plugin + build.sh as a copy template for plugin authors (incl. a test example).

## Read first (mandatory)
- `docs/ARCHITECTURE.md` — source of truth for the whole system. On conflict, this file wins.
- `docs/BRIEF.md` — what THIS repo builds, scope, public contract, tasks.

Read both fully before writing code. Work in plan mode first.

## Tech stack
Java 21 (Gradle, PF4J extension) · React + Vite (Web Component)

## Commands
```
./build.sh        # -> dist/
cd backend && ./gradlew test  ;  cd ../frontend && npm test && npm run typecheck
```
Vite does not type-check — `npm run typecheck` (`tsc --noEmit`) is the only thing that does.

## Conventions (binding)
- Java packages `dev.mosaicast.*`; npm scope `@mosaicast`.
- Plugins import ONLY against the SDK, never against core code.
- The manifest `platformApi` must match the built SDK version (**currently 0.14.0**, hosted by core 0.7.0) — core compares `major.minor` exactly and rejects a mismatch at load (the patch floats).
- Never commit secrets; configure via `.env` / environment variables.
- Migrations exclusively via Flyway.
- **Tests are part of the work** (see DoD in the BRIEF, ARCHITECTURE §13.5; plugins test against the SDK test kit).
- **CI:** create and maintain `.github/workflows/ci.yml` (build + tests on every PR) as soon as the build exists; the Definition of Done includes green CI.
- **Releases:** `.github/workflows/release.yml` is core's template, copied unmodified. The asset name `plugin.tgz` is load-bearing (the installer resolves `owner/repo@tag` straight to it), and the tag must equal `plugin.json`'s `version` — the workflow fails the release otherwise. Keep `plugin.json` / `backend/build.gradle.kts` / `frontend/package{,-lock}.json` versions in lockstep.
- **Icons come from the host** as `--mc-icon-*` (§12.3). `iconCss(ICON_NAMES)` from the SDK emits the rules; `icons.tsx` keeps only the narrowed name list and this plugin's layout. An unresolved token paints a **solid square**, not nothing — which is why the fallback is a blank SVG and not `none`. Never put a glyph in a translated string; never declare into the `--mc-*` namespace.
- **Page entrances** live in the manifest's `nav[]`, in `frontend/src/page-entries.ts` and in `SamplePlugin.PAGE_SUBPATHS`; `page-entries.test.ts` keeps the first two in step. The host's menu label can't be translated (core has no plugin catalogs) — the in-page tab can.
- **Routing:** `matchRoute(ctx.route.path, PAGE_PATTERNS)`, never `startsWith` (which also matches `moments-archive`). A `null` match is a **real 404** — `PageRouteProvider.hasRoute` must answer `false` for the same paths, and **the root is a route** (`subpath` is `""` there).
- **`nav[]` role field is `visibleTo`** — core's `NavEntry` reads that; the SDK's `PluginNavDeclaration` says `role`. Core wins (see `page-entries.test.ts`).
- **Uploads:** pass the raw `File` — `blobs.upload` normalises the declared type itself since SDK 0.9.0 (§11.1). `File.type` is `''` in Firefox when the OS can't map the extension and the host refuses on the *declared* type before sniffing, which is the failure that normalisation prevents. `{ declaredType: 'preserve' }` opts out.
- **Doc access:** `ctx.docs` (path building, key validation, null-on-404), with `'self'` = `data/user/me` and `'site'` = `data/site/main`. `ctx.api` stays as the documented escape hatch — `AdminSettings.tsx` keeps one call on it deliberately.
- **Absence is not an error:** `ctx.docs.get` / `api.getOrNull` resolve `null` for "nothing written yet". Never `.catch(() => undefined)` — that swallows the 403 and the 500 too. Branch with `isPluginApiError` (structural, not `instanceof`; see `api-error.ts`).
- **No hand-rolled formatters or plurals:** `i18n.duration` / `bytes` / `n` / `plural`. Catalog keys for counts are families (`fav.count.one` / `.other`); `if (n === 1)` is wrong in Polish, Russian and Arabic.
- **Tags** (`ctx.tags`, §6.1.1): display `TagInfo.label`, compare on `TagInfo.tag`. The manifest declares `readsVocabulary` and **`writesEpisodes: false`** — tagging an episode is a capability this plugin does not need, and the restraint is part of what it demonstrates.
- **Two locale lists, and picking the wrong one is silent** (SDK 0.10.0): `ctx.locale.available()` is what the shell *renders* in, `content()` is what text may be *authored* in. Anything editorial builds from `content()` — `TranslationEditor.tsx` does; `AdminSettings.tsx` shows both, labelled, because that panel is where the difference is actionable. `ctx.locales()` / `Locales.isContentLocale` is the same pair on the backend.
- **`ctx.translation` is `null` for two indistinguishable reasons** (SDK 0.11.0): the manifest omits `external.kinds: ["translation"]`, or the operator configured no provider (every site by default). **Check the manifest first.** Never cache the handle — the operator half moves under a running plugin. `available()` disables a button; the 403/409/429/503 path still has to exist, because `usedBy` is enforced at the call and a non-null handle is not permission.
- **`hreflang` alternates are a claim, not a listing** (SDK 0.12.0): `SitemapUrl.alternates` is `locale -> path` and **must** contain an entry pointing at `loc` itself (that entry names the language the page is written in; the constructor throws without it). Filter to `isContentLocale()` **∩** `available()` — a content locale the shell can't render has no `?lang=` to point at. Nothing translated -> the 2-arg constructor, i.e. no claim. `OgMeta.locale` is only for a page fixed in **one** language; this plugin's page follows the shell, so it stays **unset** (3-arg ctor) and the host's resolved locale wins — naming the default put `og:locale=en_US` on the same `?lang=de` URL the sitemap called German. Any page you declare an alternate for must actually render per locale — `HighlightPage.tsx` does since 2.14.0.
- **Machine output is a draft, and is labelled twice:** an editor-local unconfirmed badge that lasts until Save (never stored), and `machineTranslated` on the stored translation, which the *reader* sees. Typing clears the second — the words are the podcaster's then. The backend drafts into `drafts` (backendOwned) and **never** into `highlight.translations`; a scheduled job must not publish prose no human read.
- **Store the UUID, resolve at render** (SDK 0.13.0, `ctx.users` / `ctx.users()`): a display name copied into plugin storage outlives the rename meant to shed it and the erasure meant to end it, and core cannot reach inside to fix either — the doc comment is the enforcement. `resolve` **omits** an unknown/erased/pseudonymised id rather than returning a tombstone, so the result is **not index-aligned**: key a `Map` on `UserRef.id`, never match on position (`useAuthors` returns only the Map for that reason). `avatarUrl` is always populated and always the host's `/api/users/{id}/avatar`. `authorId` sits in a shared-scope doc, so it is **client input — a byline, not an authorization fact**; the ids this plugin trusts are the `fav:` owners `queryAcrossUsers` resolves from the partition.
- **`ctx.notifier()` writes into somebody else's site** (SDK 0.14.0, §17), so it is bounded twice by the host: only users the plugin holds `USER`-scope rows for, and the operator's rate limits. **`notifier()` in Java, `ctx.notify` in TS** — `Object.notify()` is `final`, so the asymmetry is forced. `NotifyMessage.text` is **one finished sentence per locale, `en` mandatory** — a key cannot resolve (catalogs live in the frontend bundle; the bell is shell chrome), and one rendered string freezes the language at send time. `send` returns **who was actually notified**: compare it against what you asked for, an erased recipient is ordinary. `NotificationException` is checked — `RATE_LIMITED` is `retryable()`, so hold the work and do **not** advance `announced`; the other two are your bug, so advance it.
- **Seed, don't backfill:** the first pass that sees an episode records its current locales and notifies nobody. Treating an absent `announced` doc as "nothing sent yet" turns installing a version into a spam cannon.
- **One instance, not a `static`:** core installs PF4J's `SingletonExtensionFactory` (0.6.7), so every extension point runs on the object `register()` ran on — `SamplePlugin.ctx` is a plain `volatile` field and the tests use one instance. Keep the null guard: a provider lookup can still precede `register()`.
- CSS lives in `<style>{\`…\`}</style>` template literals — **a backtick in a CSS comment ends the string** and the build fails with a confusing parse error.
- **Verify sitemap/OG work against a running core**, not only the harness: `dev/instance.sh up --plugins` in the sibling `mosaicast-core` checkout (disposable Postgres :5433 + app :8081, seeded with the fictional sample feed) after copying `dist/` to `mosaicast-core/plugins/sample`. `status` / `logs` / `down` are the rest. Locale policy is `PUT /api/admin/i18n`; a contradiction between `og:locale` and an `hreflang` alternate is invisible to every unit test.
- **Document public APIs** (Javadoc/TSDoc); take SDK signatures from the built SDK docs, don't guess (§3.5).
- **Sign off commits** (`git commit -s`, DCO).
- **SPDX header in EVERY new source file**:
  `// SPDX-License-Identifier: Apache-2.0`
  `// SPDX-FileCopyrightText: 2026 The Mosaicast Authors`
  Don't guess the copyright holder from git config — use this fixed value. CI blocks PRs without a header.

## Architecture guardrails (do not violate)
- Identity (`EpisodeRef`) is separate from presentation (feed snapshot). Runtime/date in the core display come from the feed; plugin metrics are non-authoritative and live only in the plugin UI.
- The host resolves scopes and decides access/filters — plugins only consume.
- The generic doc store is the default; schema tables only platform-mediated (declarative).
- Per-user data belongs in the host-owned `USER` scope (`data/user/me/…`, `Scope.user()`), **never in a doc key** — a key is client input. Aggregate it only on the backend via `DocStore.queryAcrossUsers(prefix)`.
- The manifest declares its own data access floor (`"data": { readableBy, writableBy }`); a slot's `visibleTo` governs rendering only. Neither floor applies to the `USER` scope.

## Keep docs current (continuously)
- Keep **README.md** and **this CLAUDE.md** up to date (commands, structure, setup, conventions) — repo-local, your job.
- **ARCHITECTURE.md and BRIEF.md are READ-ONLY specs** — don't change them unilaterally; flag deviations.
- Keep CLAUDE.md slim (< ~200 lines); leave incidental learnings to Claude Code's auto memory.

## Plugin-dev skill (check before building)
This repo is meant to be built with the shared **writing-a-mosaicast-plugin** skill (from the `mosaicast-skills` marketplace). Before scaffolding or modifying plugin code, check whether that skill is among your available skills.
- Available -> use it.
- Not available -> **pause**, tell the user it's recommended and how to install it (see CONTRIBUTING -> "Recommended skill"), and proceed without it only if the user confirms.

## When unsure
Ask, or note the assumption visibly, instead of silently diverging from ARCHITECTURE.md.
