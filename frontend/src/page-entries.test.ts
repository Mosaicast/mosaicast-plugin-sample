// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 The Mosaicast Authors

import { describe, expect, it } from 'vitest';
import manifest from '../../plugin.json';
import { DETAIL_PREFIX, PAGE_ENTRIES, viewFor } from './page-entries';
import { ICON_NAMES } from './icons';
import en from '../locales/en.json';
import de from '../locales/de.json';

interface ManifestNavEntry {
  path: string;
  label: string;
  icon?: string;
  visibleTo?: string;
}
const nav = (manifest as { nav?: ManifestNavEntry[] }).nav ?? [];

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
    const slots = (manifest as { slots: { placement: string }[] }).slots;
    expect(slots.some((s) => s.placement === 'page')).toBe(true);
  });

  it('never offers the detail route as an entrance', () => {
    // A menu cannot hold one row per episode. An entry point is where someone starts, not everywhere
    // they can end up.
    expect(PAGE_ENTRIES.some((e) => e.path.startsWith(DETAIL_PREFIX))).toBe(false);
    expect(nav.some((e) => e.path.startsWith(DETAIL_PREFIX))).toBe(false);
  });
});

describe('viewFor — routing the subpath', () => {
  it('maps each declared entrance to its own view', () => {
    expect(viewFor('')).toEqual({ view: 'index', slug: '' });
    expect(viewFor('moments')).toEqual({ view: 'moments', slug: '' });
    expect(viewFor('gallery')).toEqual({ view: 'gallery', slug: '' });
    expect(viewFor('unwritten')).toEqual({ view: 'unwritten', slug: '' });
  });

  it('reads an episode slug out of the detail route', () => {
    expect(viewFor('highlight/ep-1')).toEqual({ view: 'detail', slug: 'ep-1' });
  });

  it('falls back to the index rather than rendering nothing', () => {
    // The host hands this element every path under /p/sample/, including a stale bookmark or a typo.
    expect(viewFor('nonsense').view).toBe('index');
    expect(viewFor('highlight/').view).toBe('index'); // a detail route naming no episode is not one
  });
});
