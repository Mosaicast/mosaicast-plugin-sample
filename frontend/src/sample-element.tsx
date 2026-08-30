// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 The Mosaicast Authors

import { defineMosaicastElement } from '@mosaicast/plugin-sdk';
import { createRoot } from 'react-dom/client';
import { Highlight } from './components/Highlight';
import { HighlightCard } from './components/HighlightCard';
import { HighlightPage } from './components/HighlightPage';
import { AdminSettings } from './components/AdminSettings';

defineMosaicastElement({
  tag: 'sample-highlight',
  render: ({ ctx, root }) => {
    const reactRoot = createRoot(root);
    reactRoot.render(<Highlight ctx={ctx} />);
    return () => reactRoot.unmount();
  },
});

// The episode/card slot — the compact badge on a feed card. A separate, minimal element on purpose;
// see HighlightCard.tsx for why the `card` placement gets its own component instead of reusing the above.
defineMosaicastElement({
  tag: 'sample-highlight-card',
  render: ({ ctx, root }) => {
    const reactRoot = createRoot(root);
    reactRoot.render(<HighlightCard ctx={ctx} />);
    return () => reactRoot.unmount();
  },
});

// The site/page slot — everything under /p/sample/, including the four entrances the manifest's `nav[]`
// offers to the shell's navigation menu. A page is not a tile, which is why it is not `sample-highlight`
// with a flag; see HighlightPage.tsx.
defineMosaicastElement({
  tag: 'sample-highlight-page',
  render: ({ ctx, root }) => {
    const reactRoot = createRoot(root);
    reactRoot.render(<HighlightPage ctx={ctx} />);
    return () => reactRoot.unmount();
  },
});

// The plugin's site/sidebar, podcaster-only admin slot (see AdminSettings.tsx for why this exists).
defineMosaicastElement({
  tag: 'sample-highlight-settings',
  render: ({ ctx, root }) => {
    const reactRoot = createRoot(root);
    reactRoot.render(<AdminSettings ctx={ctx} />);
    return () => reactRoot.unmount();
  },
});
