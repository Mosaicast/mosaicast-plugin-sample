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
      expect(ICON_CSS).toContain(`.mcIcon--${name} { mask-image: var(--mc-icon-${name},`);
    }
    // `background-image` would bake the artwork's own colour (black) into the icon, which disappears on
    // a dark --mc-surface. currentColor behind a mask is what makes it re-theme with its label.
    expect(ICON_CSS).toContain('background: currentColor');
    expect(ICON_CSS).not.toContain('background-image');
  });

  it('gives every token a blank fallback, so an older host renders nothing instead of a solid square', () => {
    // The failure this pins down is unintuitive: an unresolved var() makes `mask-image` invalid at
    // computed-value time, so it falls back to its initial `none` — an *unmasked* element painting
    // currentColor across its whole box. Without the fallback, a host predating the icon set (or a
    // token this plugin misspelled) shows a filled block in every button rather than no icon at all.
    for (const name of ICON_NAMES) {
      const rule = ICON_CSS.match(new RegExp(`\\.mcIcon--${name} \\{[^}]*\\}`))![0];
      expect(rule).toContain('var(--sample-icon-blank)');
    }
    expect(ICON_CSS).toContain("--sample-icon-blank: url(\"data:image/svg+xml,%3Csvg");
  });

  it('never declares into the host’s own --mc-* namespace', () => {
    // Reading `--mc-icon-*` is the contract; *defining* one would shadow the real token for this
    // plugin's subtree the moment core publishes it. Every property this stylesheet declares is ours.
    const declared = [...ICON_CSS.matchAll(/(--[a-z0-9-]+)\s*:/g)].map((m) => m[1]);
    expect(declared).not.toHaveLength(0);
    expect(declared.every((prop) => prop.startsWith('--sample-'))).toBe(true);
  });
});

describe('host icons — the element', () => {
  it('is decorative: hidden from assistive tech, and carries no text of its own', () => {
    const container = document.createElement('div');
    act(() => {
      createRoot(container).render(<Icon name="edit" />);
    });

    const icon = container.querySelector('span')!;
    expect(icon.className).toBe('mcIcon mcIcon--edit');
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
