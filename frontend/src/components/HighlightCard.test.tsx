// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 The Mosaicast Authors

import { describe, expect, it } from 'vitest';
import { createRoot } from 'react-dom/client';
import { act } from 'react';
import { makeMockCtx, makeMockDocs } from '@mosaicast/plugin-sdk/testing';
import type { PluginContext } from '@mosaicast/plugin-sdk';
import { docsRecording, flush } from '../test-utils';
import { HighlightCard } from './HighlightCard';

function mount(ctx: PluginContext) {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => {
    root.render(<HighlightCard ctx={ctx} />);
  });
  return container;
}

function cardCtx(highlight?: unknown) {
  return makeMockCtx({
    scope: { type: 'episode', id: 'ep-1' },
    ...(highlight === undefined ? {} : { docs: makeMockDocs({ 'data/episode/ep-1/highlight': highlight }) }),
  });
}

describe('HighlightCard — the episode/card compact badge', () => {
  it('renders a one-line badge for an episode that has a highlight', async () => {
    const container = mount(cardCtx({ markdown: 'A long highlight body that belongs on the detail page' }));
    await flush();

    expect(container.textContent).toContain('Highlight');
  });

  it('never renders the markdown body — full rendering belongs to the main placement', async () => {
    const container = mount(cardCtx({ markdown: '# Heading\n\nThe **whole** story, spoilers and all.' }));
    await flush();

    expect(container.textContent).not.toContain('whole');
    expect(container.textContent).not.toContain('story');
    expect(container.querySelector('h1')).toBeNull();
  });

  it('renders nothing at all when the episode has no highlight', async () => {
    const container = mount(cardCtx());
    await flush();

    // Not an empty-state line: a feed card belongs to the host, and this mounts once per episode.
    expect(container.textContent).toBe('');
    expect(container.querySelector('.card')).toBeNull();
  });

  it('renders nothing for a contentless highlight doc, matching the backend publishable rule', async () => {
    const container = mount(cardCtx({ markdown: '   ' }));
    await flush();

    expect(container.querySelector('.card')).toBeNull();
  });

  it('shows the key moment when the podcaster set one', async () => {
    const container = mount(cardCtx({ markdown: 'The drop', momentSeconds: 90 }));
    await flush();

    expect(container.textContent).toContain('key moment at 1:30');
  });

  it('announces a spoiler-marked highlight without leaking it, and without its timestamp', async () => {
    const container = mount(cardCtx({ markdown: 'The killer is...', momentSeconds: 90, spoiler: true }));
    await flush();

    expect(container.textContent).toContain('spoiler');
    expect(container.textContent).not.toContain('killer');
    expect(container.textContent).not.toContain('1:30');
  });

  it('makes exactly one request — no settings fetch, since this mounts once per episode in a list', async () => {
    const docs = docsRecording(makeMockDocs({ 'data/episode/ep-1/highlight': { markdown: 'A highlight' } }));
    const ctx = makeMockCtx({ scope: { type: 'episode', id: 'ep-1' }, docs });
    mount(ctx);
    await flush();

    // One read, of one document. The badge deliberately skips the site-wide `settings` doc the full
    // tile reads, because this component mounts once per episode in a feed list and a second fetch each
    // would be N extra round trips for a heading override it does not render anyway.
    expect(docs.reads).toEqual(['episode:ep-1/highlight']);
  });
});
