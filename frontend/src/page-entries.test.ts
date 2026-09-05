// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 The Mosaicast Authors

import { describe, expect, it } from 'vitest';
import {
  PLATFORM_API_VERSION,
  defineManifest,
  matchRoute,
  type PluginManifest,
} from '@mosaicast/plugin-sdk';
import rawManifest from '../../plugin.json';
import { DETAIL_PREFIX, PAGE_ENTRIES, PAGE_PATTERNS } from './page-entries';
import { ICON_NAMES } from './icons';
import en from '../locales/en.json';
import de from '../locales/de.json';

/**
 * The shipped manifest, run through the SDK's own type (SDK 0.9.0).
 *
 * **`defineManifest` validates nothing at runtime** — it is an identity function, and the host is and
 * remains the validator; if this type and core disagree, core wins. What it buys is `tsc --noEmit`:
 * `slots[].element` that is missing from `frontend.elements`, a `visibleTo` that is not a role, a `blobs`
 * block missing its quota. Every one of those is a load-time failure today, found by copying `dist/` into
 * a running host and reading the admin log. Here they are found by `npm run typecheck`.
 *
 * The cast is the honest part: `plugin.json` is imported as a structurally-typed JSON module, and
 * `PluginManifest` keeps an index signature precisely because the host ignores fields it does not know —
 * so this asserts the *known* fields line up and lets the rest through.
 */
const manifest = defineManifest(rawManifest as PluginManifest);

/**
 * The manifest's `nav[]`, read back with the field name **core** uses.
 *
 * ⚠️ **The SDK type and core disagree here, and core wins.** `PluginNavDeclaration` (SDK 0.9.1) names the
 * role field `role`; `dev.mosaicast.core.plugin.PluginManifest.NavEntry` reads `visibleTo`, matching
 * `slots[]` and every other role gate in the file. A manifest written to the TypeScript type would declare
 * `role`, core would parse `visibleTo` as absent, and the entrance would default to the most restrictive
 * role — a podcaster-only menu entry that silently never appears, which is the failure mode nobody reports
 * because there is nothing to see.
 *
 * `PluginManifest` says this outright — "the manifest is owned and validated by the host; if this type and
 * core disagree, **core wins** — treat a mismatch as a bug in the SDK, not as permission to ignore the
 * host" — so `plugin.json` keeps `visibleTo` and this reads it through the index signature the type carries
 * for exactly this reason. Filed against the SDK; remove the cast when `PluginNavDeclaration` is corrected.
 */
const nav = (manifest.nav ?? []) as ReadonlyArray<{
  path: string;
  label: string;
  icon?: string;
  visibleTo?: string;
}>;

/**
 * The manifest and the page's own tab bar describe the same four entrances, and nothing but a test stops
 * them drifting. Core reads `nav[]` to build the shell's menu; the page reads {@link PAGE_ENTRIES} to
 * build its tabs. A path renamed in one and not the other is a menu entry that lands on the fallback
 * view — which looks like a working link, so no one notices.
 */
describe('nav entries — the manifest and the page agree', () => {
  it('declares one manifest entry per page entry, in the same order', () => {
    expect(nav.map((e) => e.path)).toEqual(PAGE_ENTRIES.map((e) => e.path));
  });

  it('matches on path, icon and role for every entry', () => {
    for (const entry of PAGE_ENTRIES) {
      const declared = nav.find((e) => e.path === entry.path);
      expect(declared, `no manifest nav entry for ${JSON.stringify(entry.path)}`).toBeDefined();
      expect(declared!.icon).toBe(entry.icon);
      // The manifest omits `visibleTo` for a public entry rather than spelling out "anonymous", which is
      // the default; the code names it either way.
      expect(declared!.visibleTo ?? 'anonymous').toBe(entry.visibleTo);
    }
  });

  it('gives every manifest entry a non-empty label, since the host cannot translate one', () => {
    // Core has no access to a plugin's catalogs, so this string is what the menu shows in every language.
    // The in-page tab is translated instead — the deliberate asymmetry documented on PAGE_ENTRIES.
    for (const entry of nav) {
      expect(entry.label?.trim()).toBeTruthy();
    }
  });

  it('translates every tab label in both catalogs', () => {
    for (const entry of PAGE_ENTRIES) {
      expect((en as Record<string, string>)[entry.labelKey], `en: ${entry.labelKey}`).toBeTruthy();
      expect((de as Record<string, string>)[entry.labelKey], `de: ${entry.labelKey}`).toBeTruthy();
    }
  });

  it('only names icons this plugin actually ships a rule for', () => {
    // An unknown icon never rejects a plugin — core deliberately holds no icon list — so a typo here is
    // silent on both sides: a blank in the host's menu and a blank in the tab bar.
    for (const entry of PAGE_ENTRIES) {
      expect(ICON_NAMES).toContain(entry.icon);
    }
  });

  it('declares paths the host will accept without normalising', () => {
    // Core refuses a path it would have had to clean rather than rewriting it (a link to a URL the author
    // did not write is worse than an error), so a leading slash or a `..` fails the whole plugin at load.
    for (const entry of PAGE_ENTRIES) {
      expect(entry.path).not.toMatch(/^\//);
      expect(entry.path.split('/')).not.toContain('..');
      expect(entry.path).toBe(entry.path.trim());
    }
  });

  it('has a `page` slot, without which core rejects nav entries outright', () => {
    expect(manifest.slots?.some((s) => s.placement === 'page')).toBe(true);
  });

  it('mounts every element a slot names, which is otherwise a load-time failure', () => {
    // The mistake `PluginManifest` was typed to catch, checked here as well because the type only knows
    // that both lists are arrays of strings — it cannot know they must agree. Core rejects the plugin at
    // load with the reason in the admin log viewer; this fails in CI instead.
    const registered = new Set(manifest.frontend?.elements ?? []);
    for (const slot of manifest.slots ?? []) {
      expect(registered, `slot element ${slot.element} is not in frontend.elements`).toContain(slot.element);
    }
  });

  it('declares the tag surface it reads, and no capability it does not use', () => {
    // `ctx.tags` is null without this block, so the vocabulary this plugin renders needs it declared. The
    // second flag is the point: tagging an *episode* changes the shell's filter options and what core
    // recommends beside it (§6.1.1), so it is a separate declaration — and this plugin only tags its own
    // subjects. Writing `false` rather than omitting it keeps the restraint visible in the file people copy.
    expect(manifest.tags?.readsVocabulary).toBe(true);
    expect(manifest.tags?.writesEpisodes).toBe(false);
  });

  it('declares the external services it uses, without which ctx.translation is null', () => {
    // The 0.11.0 trap, pinned. `ctx.translation` was already `TranslationClient | null`, so dropping this
    // block breaks nothing the type system can see: the handle simply goes `null` at runtime and the
    // translate button stops working. Nothing else in this repo would catch that, because every component
    // is *required* to handle `null` anyway — the operator half of the gate is a site the admin never
    // configured, which is every site by default.
    expect(manifest.external?.kinds).toEqual(['translation']);

    // `podcaster`, matching `data.writableBy`, and stated rather than left to the default so the file
    // people copy shows the decision being made. `anonymous` is legal here — unlike `data.writableBy`,
    // because a self-hosted LibreTranslate costs nothing per call — and core loads it with a warning. It
    // would still be wrong for this plugin: only a podcaster writes a highlight, so only a podcaster has
    // anything to translate, and a lower floor would put a metered API behind a page anyone can load.
    expect(manifest.external?.usedBy).toBe('podcaster');
  });

  it('declares the contract version the SDK it builds against publishes', () => {
    // Core matches major.minor exactly and rejects a mismatch at startup, so a manifest copied from an
    // older sample fails to load rather than warning. The patch floats: `0.12.1` would load here too.
    //
    // Asserted against the SDK's own constant rather than a literal, deliberately: `npm install` moving the
    // dependency is exactly the moment the manifest goes stale, and a hardcoded string here is a test that
    // has to be remembered instead of one that fails. The two halves of the pin ship together and share one
    // SemVer anchor, so the SDK on disk is the contract version this build actually compiles against.
    expect(manifest.platformApi).toBe(PLATFORM_API_VERSION);
  });

  it('never offers the detail route as an entrance', () => {
    // A menu cannot hold one row per episode. An entry point is where someone starts, not everywhere
    // they can end up.
    expect(PAGE_ENTRIES.some((e) => e.path.startsWith(DETAIL_PREFIX))).toBe(false);
    expect(nav.some((e) => e.path.startsWith(DETAIL_PREFIX))).toBe(false);
  });
});

/**
 * Routing, on `matchRoute` since 2.12.0 (SDK 0.9.0).
 *
 * The hand-rolled matcher this replaced was a `startsWith` plus a `find`, which is what every page plugin
 * writes and which has two bugs in it. Both are asserted below, because the point of adopting a helper is
 * lost if nothing pins the behaviour that made it worth adopting.
 */
describe('matchRoute — routing the subpath', () => {
  it('maps each declared entrance to its own pattern', () => {
    for (const path of ['', 'moments', 'gallery', 'unwritten']) {
      expect(matchRoute(path, PAGE_PATTERNS)?.pattern, path).toBe(path);
    }
  });

  it('reads an episode slug out of the detail route', () => {
    const match = matchRoute('highlight/ep-1', PAGE_PATTERNS);
    expect(match?.pattern).toBe(`${DETAIL_PREFIX}:slug`);
    expect(match?.params.slug).toBe('ep-1');
  });

  it('decodes the captured segment, so a doc call gets the real slug', () => {
    // The hand-rolled version sliced the raw path and handed the encoded form to a doc-path builder, which
    // then percent-encoded it a second time.
    expect(matchRoute('highlight/a%20b', PAGE_PATTERNS)?.params.slug).toBe('a b');
  });

  it('consumes the whole path, so a deeper URL is not the entrance above it', () => {
    // Bug one. `'moments'` matched `moments/3` when nothing checked that the path had been fully consumed.
    expect(matchRoute('moments/3', PAGE_PATTERNS)).toBeNull();
    expect(matchRoute('gallery/2/rows', PAGE_PATTERNS)).toBeNull();
  });

  it('does not match a longer name that merely starts the same way', () => {
    // Bug two, and the one the SDK's own docs lead with: `startsWith('moments')` also matches
    // `moments-archive`, which is a different page that this one would have quietly rendered.
    expect(matchRoute('moments-archive', PAGE_PATTERNS)).toBeNull();
    expect(matchRoute('gallery-2024', PAGE_PATTERNS)).toBeNull();
  });

  it('returns null for anything else, which is now a real 404', () => {
    // Until SDK 0.9.1 this fell back to the index, because the host answered 200 for the whole subtree and
    // an empty page seemed worse. The backend's PageRouteProvider answers `false` for exactly these, so the
    // host sends a 404 and the page must render a body that agrees with it.
    expect(matchRoute('nonsense', PAGE_PATTERNS)).toBeNull();
    expect(matchRoute('highlight/', PAGE_PATTERNS)).toBeNull(); // a detail route naming no episode is not one
  });

  it('lists the specific pattern before the general one, since the first match wins', () => {
    // Ordering is the caller's job — the SDK does not sort. `''` sitting last would be harmless; a
    // hypothetical `:anything` sitting first would swallow every entrance above it.
    const detail = PAGE_PATTERNS.indexOf(`${DETAIL_PREFIX}:slug`);
    const literals = PAGE_PATTERNS.filter((p) => !p.includes(':'));
    expect(literals.every((p) => PAGE_PATTERNS.indexOf(p) < detail)).toBe(true);
  });

  it('covers every entrance the manifest offers, so no menu entry lands on a 404', () => {
    // The reconciliation that matters most now: an entrance in nav[] with no pattern here is a menu item
    // the page cannot render *and* — since the backend derives its own route set from the same list — one
    // the host would answer 200 for while showing a not-found body.
    for (const entry of PAGE_ENTRIES) {
      expect(matchRoute(entry.path, PAGE_PATTERNS)?.pattern, entry.path).toBe(entry.path);
    }
  });
});
