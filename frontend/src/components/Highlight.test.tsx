// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 The Mosaicast Authors

import { describe, expect, it } from 'vitest';
import { createRoot } from 'react-dom/client';
import { act } from 'react';
import { makeMockCtx } from '@mosaicast/plugin-sdk/testing';
import type { PluginContext } from '@mosaicast/plugin-sdk';
import { flush } from '../test-utils';
import { Highlight } from './Highlight';
import { MODAL_PORTAL_ATTR } from './HighlightModal';

function mount(ctx: PluginContext) {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => {
    root.render(<Highlight ctx={ctx} />);
  });
  return container;
}

/**
 * The modal portals to its own shadow root on `document.body` (see HighlightModal) to escape any
 * ancestor's transform-trapped `position: fixed` containing block — so it never lives inside `container`.
 */
function findModalShadowRoot(): ShadowRoot | null {
  return document.querySelector(`[${MODAL_PORTAL_ATTR}]`)?.shadowRoot ?? null;
}

const nativeTextareaValueSetter = () =>
  Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value')!.set!;

describe('Highlight — episode scope', () => {
  it('renders sanitized markdown when a highlight exists', async () => {
    const ctx = makeMockCtx({
      scope: { type: 'episode', id: 'ep-1' },
      apiResponses: {
        'get data/episode/ep-1/highlight': { markdown: '**Great** cliffhanger! <script>alert(1)</script>' },
      },
    });

    const container = mount(ctx);
    await flush();

    expect(container.querySelector('strong')?.textContent).toBe('Great');
    expect(container.innerHTML).not.toContain('<script>');
  });

  it('shows the fallback when there is no highlight yet', async () => {
    const ctx = makeMockCtx({ scope: { type: 'episode', id: 'ep-2' } });

    const container = mount(ctx);
    await flush();

    expect(container.textContent).toContain('No highlight yet.');
  });

  it('hides the Edit button for anonymous and fan users', async () => {
    const anon = mount(makeMockCtx({ scope: { type: 'episode', id: 'ep-1' }, user: null }));
    await flush();
    expect(anon.querySelector('button')).toBeNull();

    const fan = mount(
      makeMockCtx({ scope: { type: 'episode', id: 'ep-1' }, user: { id: 'u1', role: 'fan' } }),
    );
    await flush();
    expect(fan.querySelector('button')).toBeNull();
  });

  it('shows the Edit button for podcaster and admin users and saves via ctx.api.put', async () => {
    const ctx = makeMockCtx({
      scope: { type: 'episode', id: 'ep-1' },
      user: { id: 'u1', role: 'podcaster' },
      apiResponses: { 'get data/episode/ep-1/highlight': { markdown: 'Original text' } },
    });

    const container = mount(ctx);
    await flush();

    const editButton = container.querySelector('button') as HTMLButtonElement;
    expect(editButton.textContent).toBe('Edit');

    act(() => {
      editButton.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    await flush();

    const modal = findModalShadowRoot()!;
    const textarea = modal.querySelector('textarea') as HTMLTextAreaElement;
    expect(textarea.value).toBe('Original text');

    act(() => {
      nativeTextareaValueSetter().call(textarea, 'Updated highlight');
      textarea.dispatchEvent(new Event('input', { bubbles: true }));
    });

    const saveButton = Array.from(modal.querySelectorAll('button')).find((b) => b.textContent === 'Save')!;
    act(() => {
      saveButton.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    await flush();

    expect(ctx.api.calls).toContainEqual({
      method: 'put',
      path: 'data/episode/ep-1/highlight',
      body: { markdown: 'Updated highlight' },
    });
    // Modal (and its portal host) is gone after a successful save.
    expect(findModalShadowRoot()).toBeNull();
  });

  it('closes the modal without saving on Cancel', async () => {
    const ctx = makeMockCtx({
      scope: { type: 'episode', id: 'ep-1' },
      user: { id: 'u1', role: 'admin' },
    });
    const container = mount(ctx);
    await flush();

    act(() => {
      (container.querySelector('button') as HTMLButtonElement).dispatchEvent(
        new MouseEvent('click', { bubbles: true }),
      );
    });
    await flush();
    expect(findModalShadowRoot()).not.toBeNull();

    const cancelButton = Array.from(findModalShadowRoot()!.querySelectorAll('button')).find(
      (b) => b.textContent === 'Cancel',
    )!;
    act(() => {
      cancelButton.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    await flush();

    expect(findModalShadowRoot()).toBeNull();
    expect(ctx.api.calls.some((c) => c.method === 'put')).toBe(false);
  });
});

describe('Highlight — feed (podcast) scope', () => {
  it('addresses the feed-scoped doc and does not show episode stats', async () => {
    const ctx = makeMockCtx({
      scope: { type: 'feed', id: 'news' },
      apiResponses: { 'get data/feed/news/highlight': { markdown: 'Weekly news roundup' } },
    });

    const container = mount(ctx);
    await flush();

    expect(container.textContent).toContain('Weekly news roundup');
    expect(container.textContent).not.toMatch(/episodes highlighted/);
  });
});

describe('Highlight — site scope', () => {
  it('shows the backend-computed highlighted-episode stat', async () => {
    const ctx = makeMockCtx({
      scope: { type: 'site', id: 'main' },
      apiResponses: {
        'get data/site/main/highlight': { markdown: 'Welcome to the show' },
        'get data/site/main/stats': { totalEpisodes: 12, highlightedEpisodes: 3 },
      },
    });

    const container = mount(ctx);
    await flush();

    expect(container.textContent).toContain('3 of 12 episodes highlighted');
  });
});
