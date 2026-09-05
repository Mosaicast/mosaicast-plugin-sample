// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 The Mosaicast Authors

import { describe, expect, it } from 'vitest';
import { createRoot } from 'react-dom/client';
import { act } from 'react';
import { ICON_CSS, ICON_NAMES, Icon } from './icons';
import en from '../locales/en.json';
import de from '../locales/de.json';

/**
 * Tests for the host icon channel (ARCHITECTURE §12.3).
 *
 * There is nothing to assert about how an icon *looks* — the artwork lives in the shell and jsdom
 * computes no masks — so these guard the two things that can actually regress in this repo: the CSS
 * contract each token reference must satisfy, and the rule that put the icons here in the first place.
 */
describe('host icons — the CSS contract', () => {
  it('references every name as a host token, and masks rather than paints it', () => {
    for (const name of ICON_NAMES) {
      // The rule the SDK emits per name. Asserted rather than assumed, because this repo's ICON_NAMES is
      // a *narrowed* list and a name that never reaches `iconCss` renders as nothing with no other sign.
      expect(ICON_CSS).toContain(`.mc-icon-${name} {`);
      expect(ICON_CSS).toContain(`mask-image: var(--mc-icon-${name},`);
    }
    // `background-image` would bake the artwork's own colour (black) into the icon, which disappears on
    // a dark --mc-surface. currentColor behind a mask is what makes it re-theme with its label.
    expect(ICON_CSS).toContain('background: currentColor');
    expect(ICON_CSS).not.toContain('background-image');
  });

  it('gives every token a blank *image* fallback, not `none`', () => {
    // The failure this pins down is unintuitive, and is the reason `iconCss` exists at all: an unresolved
    // var() makes `mask-image` invalid at computed-value time, so it falls back to its initial `none` — an
    // *unmasked* element painting currentColor across its whole box. Without a real, blank image as the
    // fallback, a host predating the icon set (or a token this plugin misspelled) shows a filled block in
    // every button rather than no icon at all. `mask-image: none` is the obvious guess and the cause.
    for (const name of ICON_NAMES) {
      const rule = ICON_CSS.match(new RegExp(`\\.mc-icon-${name} \\{[^}]*\\}`))![0];
      expect(rule, name).toContain('data:image/svg+xml');
      expect(rule, name).not.toMatch(/var\(--mc-icon-[a-z0-9-]+,\s*none\)/);
    }
  });

  it('never declares into the host’s own --mc-* namespace', () => {
    // Reading `--mc-icon-*` is the contract; *defining* one would shadow the real token for this plugin's
    // subtree the moment core publishes it. The whole stylesheet may reference them and must declare none.
    const declared = [...ICON_CSS.matchAll(/(--[a-z0-9-]+)\s*:/g)].map((m) => m[1]);
    expect(declared.filter((prop) => prop.startsWith('--mc-'))).toEqual([]);
  });

  it('keeps this plugin’s own layout rule, which the SDK does not and should not own', () => {
    // `iconCss` owns the mechanics (mask, fallback, em sizing). Whether an icon may shrink inside a flex
    // row, and how far below the baseline it sits, is this plugin's taste — so it is concatenated on
    // rather than argued for upstream.
    expect(ICON_CSS).toContain('.mc-icon { flex: none; vertical-align: -0.125em; }');
  });
});

describe('host icons — the element', () => {
  it('is decorative: hidden from assistive tech, and carries no text of its own', () => {
    const container = document.createElement('div');
    act(() => {
      createRoot(container).render(<Icon name="edit" />);
    });

    const icon = container.querySelector('span')!;
    expect(icon.className).toBe('mc-icon mc-icon-edit');
    // Every call site puts the icon beside a real label. Announcing it too would read the meaning
    // twice ("star star Favourite this")…
    expect(icon.getAttribute('aria-hidden')).toBe('true');
    // …and an empty `textContent` is what lets the tests elsewhere in this repo go on finding buttons
    // by their exact label (`b.textContent === label`) with an icon now inside them.
    expect(icon.textContent).toBe('');
  });
});

describe('translation catalogs', () => {
  it('carry no icon glyphs — an icon is presentation, not a word', () => {
    // Until core 0.6.15 published the icon set, this plugin drew its marks as literal characters inside
    // the translated strings ("▶ Jump to {{time}}", "☆ Favourite this"). That made a piece of
    // presentation something a translator could change, drop, or mirror wrongly in an RTL locale — and
    // rendered as whatever emoji font the visitor's platform happened to ship. Both catalogs are now
    // sentences only; the mark comes from `--mc-icon-*` at the call site.
    // Arrows, geometric shapes/box drawing/misc symbols/dingbats (▶ ★ ☆ ✓ ✨ all live here), the
    // miscellaneous-symbols-and-arrows block, and the emoji planes.
    const glyphs = /[←-⇿─-➿⬀-⯿]|[\u{1F300}-\u{1FAFF}]/u;
    for (const [name, catalog] of Object.entries({ en, de })) {
      for (const [key, value] of Object.entries(catalog as Record<string, string>)) {
        // settings.headingPlaceholder is example *content* a podcaster would type, not a UI mark.
        if (key === 'settings.headingPlaceholder') continue;
        expect(glyphs.test(value), `${name}.json: "${key}" still carries an icon glyph`).toBe(false);
      }
    }
  });
});
