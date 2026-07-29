// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 The Mosaicast Authors

import { defineMosaicastElement } from '@mosaicast/plugin-sdk';
import { createRoot } from 'react-dom/client';
import { Highlight } from './components/Highlight';
import { AdminSettings } from './components/AdminSettings';

defineMosaicastElement({
  tag: 'sample-highlight',
  render: ({ ctx, root }) => {
    const reactRoot = createRoot(root);
    reactRoot.render(<Highlight ctx={ctx} />);
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
