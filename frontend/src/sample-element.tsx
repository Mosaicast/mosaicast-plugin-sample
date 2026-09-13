// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 The Mosaicast Authors

import { defineMosaicastElement } from '@mosaicast/plugin-sdk';
import type { MosaicastRender, PluginContext } from '@mosaicast/plugin-sdk';
import type { ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import { Highlight } from './components/Highlight';
import { HighlightCard } from './components/HighlightCard';
import { HighlightPage } from './components/HighlightPage';
import { AdminSettings } from './components/AdminSettings';

/**
 * Mounts a React tree into the host's `root` and keeps it alive across `ctx` reassignments (SDK 0.15.0).
 *
 * All four of this plugin's elements differ only in which component they render, so the decision that
 * matters is made once, here, rather than copied four times.
 *
 * **Why a handle and not a cleanup callback.** Returning `() => reactRoot.unmount()` is still valid and
 * still means what it always meant — but it means *destroy and re-render on every `ctx` assignment*. The
 * host re-assigns `ctx` for ordinary reasons (a language switch, a consent choice), and each one used to
 * unmount the React tree: component state, scroll position, an open edit modal and every in-flight request
 * went with it, and every effect behind them re-ran. Returning `{ update, destroy }` makes a new `ctx` a
 * React re-render of the *same* root instead — React reconciles, the DOM stays, `destroy` fires only on a
 * real disconnect.
 *
 * Honesty about the motivating bug: core **0.7.2** fixed the pathological case on its own side, where the
 * shell rebuilt its context object roughly four times a second during playback and tore every plugin
 * element down at that rate. So this is not a workaround for a host that still misbehaves — it is the
 * shape the contract has, for the assignments a host legitimately still makes.
 *
 * The components' own `useEffect(…, [ctx])` dependencies are left alone deliberately: when `ctx` genuinely
 * changes, refetching *is* the right answer. What changed is that the tree is no longer thrown away for it.
 * An identical context object never reaches `update` at all — the SDK filters that case out.
 *
 * @param node renders the component for a given context
 * @returns a render callback for {@link defineMosaicastElement}
 */
const reactElement =
  (node: (ctx: PluginContext) => ReactNode): MosaicastRender =>
  ({ ctx, root }) => {
    const reactRoot = createRoot(root);
    reactRoot.render(node(ctx));
    return {
      update: (next) => reactRoot.render(node(next)),
      destroy: () => reactRoot.unmount(),
    };
  };

defineMosaicastElement({
  tag: 'sample-highlight',
  render: reactElement((ctx) => <Highlight ctx={ctx} />),
});

// The episode/card slot — the compact badge on a feed card. A separate, minimal element on purpose;
// see HighlightCard.tsx for why the `card` placement gets its own component instead of reusing the above.
defineMosaicastElement({
  tag: 'sample-highlight-card',
  render: reactElement((ctx) => <HighlightCard ctx={ctx} />),
});

// The site/page slot — everything under /p/sample/, including the four entrances the manifest's `nav[]`
// offers to the shell's navigation menu. A page is not a tile, which is why it is not `sample-highlight`
// with a flag; see HighlightPage.tsx.
defineMosaicastElement({
  tag: 'sample-highlight-page',
  render: reactElement((ctx) => <HighlightPage ctx={ctx} />),
});

// The plugin's site/sidebar, podcaster-only admin slot (see AdminSettings.tsx for why this exists).
defineMosaicastElement({
  tag: 'sample-highlight-settings',
  render: reactElement((ctx) => <AdminSettings ctx={ctx} />),
});
