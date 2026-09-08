// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 The Mosaicast Authors

import type { IconName } from './icons';

/**
 * One declared way into this plugin's page.
 *
 * @param path      the subpath under `/p/sample/`; `''` is the page root
 * @param labelKey  i18n key for the in-page tab — see {@link PAGE_ENTRIES} for why the menu cannot use it
 * @param icon      a host icon name (§12.3), the same palette the manifest's `nav[].icon` draws from
 * @param visibleTo the minimum role, mirroring the manifest's own `visibleTo`
 */
export interface PageEntry {
  path: string;
  labelKey: string;
  icon: IconName;
  visibleTo: 'anonymous' | 'podcaster';
}

/**
 * Every entrance this plugin offers, declared once.
 *
 * **What this demonstrates.** A `page` plugin owns `/p/{id}/*` outright, so it may put as many entrances
 * on it as it has genuinely different things to show — core 0.6.15 added `nav[]` to the manifest precisely
 * so those entrances can appear in the shell's navigation menu instead of being URLs only their author
 * knows. This plugin declares four, and they are four *views of one dataset* rather than four features:
 * everything highlighted, only the moments, only the pictures, and — for a podcaster — the episodes with
 * nothing written yet. That last one is the interesting member: an entrance can be role-gated, and the
 * host resolves that server-side, so an anonymous visitor is never sent the entry at all.
 *
 * **Why this array exists rather than the manifest alone.** The same four entrances have to appear twice:
 * in `plugin.json`'s `nav[]`, which the host reads to build its menu, and as this page's own tab bar, so a
 * visitor already on the page can move between views without going back to the menu. Two hand-maintained
 * lists drift — a renamed path becomes a menu entry leading to an empty view. So the code keeps this one
 * and `page-entries.test.ts` asserts the manifest agrees with it, field by field.
 *
 * **The one asymmetry worth knowing.** The host's menu label comes from the manifest as a plain string and
 * is *not* translated — core has no access to a plugin's catalogs. The in-page tab below is, via
 * {@link PageEntry.labelKey}. So the manifest carries a short, neutral English label and the tab carries
 * the localised one; they are deliberately allowed to differ in wording, and only path/icon/role are
 * pinned by the test.
 *
 * `highlight/<slug>` is deliberately **absent**: a per-episode detail view is a destination, not an
 * entrance, and a menu cannot hold one row per episode. An entry point is where someone starts.
 */
export const PAGE_ENTRIES: readonly PageEntry[] = [
  { path: '', labelKey: 'page.nav.highlights', icon: 'star', visibleTo: 'anonymous' },
  { path: 'moments', labelKey: 'page.nav.moments', icon: 'clock', visibleTo: 'anonymous' },
  { path: 'gallery', labelKey: 'page.nav.gallery', icon: 'image', visibleTo: 'anonymous' },
  { path: 'unwritten', labelKey: 'page.nav.unwritten', icon: 'compose', visibleTo: 'podcaster' },
];

/** The detail view's subpath prefix — a destination rather than an entrance (see {@link PAGE_ENTRIES}). */
export const DETAIL_PREFIX = 'highlight/';

/**
 * Every subpath this page renders, in priority order, for {@link matchRoute}.
 *
 * **The specific pattern comes before the general one**, because the first match wins — that ordering is
 * the caller's job and the SDK does not sort for you.
 *
 * ## Why this replaced a hand-rolled matcher (SDK 0.9.0)
 *
 * The version here until 2.11.0 was a `startsWith(DETAIL_PREFIX)` plus a `find` over {@link PAGE_ENTRIES},
 * which is the shape every page plugin arrives at and the shape that has the bug: `startsWith('moments')`
 * also matches `moments-archive`, and `'moments'` used to match `moments/3` because nothing checked that
 * the whole path had been consumed. {@link matchRoute} matches whole paths, captures `:param` segments
 * already `decodeURIComponent`-ed, and returns **`null`** for the not-found branch.
 *
 * ## The `null` branch is a real view now, not a fallback
 *
 * Until SDK 0.9.1 an unrecognised subpath here quietly rendered the index, because the host answered
 * `200` for the whole `/p/sample/*` subtree regardless and an empty page seemed the worse answer. Now the
 * backend's `PageRouteProvider` answers `false` for exactly these paths and the host sends a real **404**
 * (ARCHITECTURE §6.6) — so rendering the index under a 404 status line would make the body disagree with
 * the response. Keep the two in step: **this list and `SamplePlugin.PAGE_SUBPATHS` describe the same set**,
 * and `page-entries.test.ts` asserts the entrance half against the manifest.
 */
export const PAGE_PATTERNS = ['', 'moments', 'gallery', 'unwritten', `${DETAIL_PREFIX}:slug`] as const;

/** One of the subpaths {@link PAGE_PATTERNS} declares. */
export type PagePattern = (typeof PAGE_PATTERNS)[number];
