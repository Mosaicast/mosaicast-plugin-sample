// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 The Mosaicast Authors

import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import type { ThemeTokens } from '@mosaicast/plugin-sdk';

/** Marks the portal host so tests (and curious devs in devtools) can find it unambiguously. */
export const MODAL_PORTAL_ATTR = 'data-mosaicast-sample-highlight-modal';

/** camelCase theme token name → the `--mc-*` custom property `defineMosaicastElement` injects. */
function themeVar(key: keyof ThemeTokens): string {
  return `--mc-${key.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)}`;
}

/**
 * Renders `children` into a brand-new shadow root attached directly to `document.body`, instead of
 * nesting them inside this plugin's own shadow tree.
 *
 * Why: the modal uses `position: fixed` to cover the viewport, but CSS makes any ANCESTOR with a
 * `transform`/`filter`/`will-change` become the containing block for a fixed-position descendant instead
 * of the viewport — and that ancestor's own stacking context then traps the modal below unrelated
 * siblings that have one too (e.g. episode cover art with a hover-reveal transform). Shadow DOM doesn't
 * protect against this: it's a rendering feature, not a new containing-block boundary, so an ancestor's
 * transform reaches straight through it. Porting the modal out to a fresh host on `document.body` — the
 * same fix every modal library uses — sidesteps the whole ancestor chain. It keeps its own shadow root
 * (rather than landing in the light DOM) so its styles stay encapsulated from the host page, and the host
 * element gets `ctx.theme` re-applied as inline `--mc-*` properties so `var(--mc-*)` still resolves
 * correctly inside it.
 */
export function HighlightModal({ theme, children }: { theme: ThemeTokens; children: React.ReactNode }) {
  const [shadowRoot, setShadowRoot] = useState<ShadowRoot | null>(null);

  useEffect(() => {
    const host = document.createElement('div');
    host.setAttribute(MODAL_PORTAL_ATTR, '');
    document.body.appendChild(host);
    const shadow = host.attachShadow({ mode: 'open' });
    setShadowRoot(shadow);
    return () => {
      document.body.removeChild(host);
    };
  }, []);

  useEffect(() => {
    if (!shadowRoot) return;
    const host = shadowRoot.host as HTMLElement;
    for (const key of Object.keys(theme) as Array<keyof ThemeTokens>) {
      const value = theme[key];
      if (value) host.style.setProperty(themeVar(key), value);
    }
  }, [shadowRoot, theme]);

  if (!shadowRoot) return null;
  return createPortal(children, shadowRoot);
}
