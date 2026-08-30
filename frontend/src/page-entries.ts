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
 * Picks the view for a route subpath.
 *
 * Anything unrecognised falls back to the root view rather than rendering an error: the host reserves the
 * whole `/p/sample/*` subtree, so a stale bookmark or a typo lands here, and an empty page would be a
 * worse answer than the index the visitor was probably looking for.
 */
export function viewFor(path: string): { view: string; slug: string } {
  if (path.startsWith(DETAIL_PREFIX)) {
    const slug = path.slice(DETAIL_PREFIX.length);
    if (slug) return { view: 'detail', slug };
  }
  const match = PAGE_ENTRIES.find((entry) => entry.path === path);
  return { view: match ? match.path || 'index' : 'index', slug: '' };
}
