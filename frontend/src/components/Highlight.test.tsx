// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 The Mosaicast Authors

import { afterEach, describe, expect, it, vi } from 'vitest';
import { createRoot } from 'react-dom/client';
import { act } from 'react';
import { makeMockCtx, makeMockConsent } from '@mosaicast/plugin-sdk/testing';
import type { MockApiClient } from '@mosaicast/plugin-sdk/testing';
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

const nativeInputValueSetter = () =>
  Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!;

/** Opens the edit modal from a mounted podcaster view and returns its portal shadow root. */
async function openEditor(container: ParentNode): Promise<ShadowRoot> {
  const editButton = Array.from(container.querySelectorAll('button')).find((b) => b.textContent === 'Edit')!;
  act(() => {
    editButton.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });
  await flush();
  return findModalShadowRoot()!;
}

async function clickButton(root: ParentNode, label: string) {
  const button = Array.from(root.querySelectorAll('button')).find((b) => b.textContent === label)!;
  act(() => {
    button.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });
  await flush();
}

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
    // Other buttons (the consent click-to-load ones from ConsentExtras) legitimately render for every
    // visitor regardless of role — only the Edit button itself is role-gated.
    const findEditButton = (root: ParentNode) =>
      Array.from(root.querySelectorAll('button')).find((b) => b.textContent === 'Edit');

    const anon = mount(makeMockCtx({ scope: { type: 'episode', id: 'ep-1' }, user: null }));
    await flush();
    expect(findEditButton(anon)).toBeUndefined();

    const fan = mount(
      makeMockCtx({ scope: { type: 'episode', id: 'ep-1' }, user: { id: 'u1', role: 'fan' } }),
    );
    await flush();
    expect(findEditButton(fan)).toBeUndefined();
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
    expect(ctx.logs).toContainEqual({ level: 'info', message: 'highlight saved at data/episode/ep-1/highlight' });
  });

  it('logs a warning and keeps the modal open when the save fails', async () => {
    const mockApi: MockApiClient = {
      calls: [],
      responses: {},
      get: () => Promise.resolve(undefined as never),
      post: () => Promise.reject(new Error('nope')),
      put: () => Promise.reject(new Error('network down')),
      delete: () => Promise.resolve(undefined as never),
    };
    const ctx = makeMockCtx({
      scope: { type: 'episode', id: 'ep-1' },
      user: { id: 'u1', role: 'podcaster' },
      api: mockApi,
    });

    const container = mount(ctx);
    await flush();

    act(() => {
      (container.querySelector('button') as HTMLButtonElement).dispatchEvent(
        new MouseEvent('click', { bubbles: true }),
      );
    });
    await flush();

    const modal = findModalShadowRoot()!;
    const saveButton = Array.from(modal.querySelectorAll('button')).find((b) => b.textContent === 'Save')!;
    await act(async () => {
      saveButton.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await flush();
    });

    expect(ctx.logs).toContainEqual({
      level: 'warn',
      message: 'highlight save at data/episode/ep-1/highlight failed: network down',
    });
    expect(findModalShadowRoot()).not.toBeNull();

    // The modal portals to document.body (see findModalShadowRoot), so leaving it open here would leak
    // into the next test's global lookup — close it now that the assertion above is done.
    const cancelButton = Array.from(modal.querySelectorAll('button')).find((b) => b.textContent === 'Cancel')!;
    act(() => {
      cancelButton.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    await flush();
  });

  it('clamps a negative key moment to 0 instead of storing a seek to a negative offset', async () => {
    const ctx = makeMockCtx({
      scope: { type: 'episode', id: 'ep-1' },
      user: { id: 'u1', role: 'podcaster' },
      apiResponses: { 'get data/episode/ep-1/highlight': { markdown: 'The drop' } },
    });
    const container = mount(ctx);
    await flush();
    const modal = await openEditor(container);

    // `min={0}` on the input only stops typing — a paste or an autofill still lands here.
    const momentInput = modal.querySelector('input[type="number"]') as HTMLInputElement;
    act(() => {
      nativeInputValueSetter().call(momentInput, '-30');
      momentInput.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await clickButton(modal, 'Save');

    expect(ctx.api.calls).toContainEqual({
      method: 'put',
      path: 'data/episode/ep-1/highlight',
      body: { markdown: 'The drop', momentSeconds: 0 },
    });
  });

  it('omits momentSeconds entirely when the field is left blank or unparseable', async () => {
    const ctx = makeMockCtx({
      scope: { type: 'episode', id: 'ep-1' },
      user: { id: 'u1', role: 'podcaster' },
      apiResponses: { 'get data/episode/ep-1/highlight': { markdown: 'The drop' } },
    });
    const container = mount(ctx);
    await flush();
    const modal = await openEditor(container);
    await clickButton(modal, 'Save');

    expect(ctx.api.calls).toContainEqual({
      method: 'put',
      path: 'data/episode/ep-1/highlight',
      body: { markdown: 'The drop' },
    });
  });

  it('names the dialog, focuses the textarea on open and restores focus to Edit on close', async () => {
    const ctx = makeMockCtx({ scope: { type: 'episode', id: 'ep-1' }, user: { id: 'u1', role: 'podcaster' } });
    const container = mount(ctx);
    await flush();
    const editButton = Array.from(container.querySelectorAll('button')).find((b) => b.textContent === 'Edit')!;

    const modal = await openEditor(container);
    const dialog = modal.querySelector('[role="dialog"]')!;
    // A role="dialog" without an accessible name is announced as just "dialog".
    const labelId = dialog.getAttribute('aria-labelledby')!;
    expect(modal.getElementById(labelId)?.textContent).toBe('Edit episode highlight');
    expect(modal.activeElement).toBe(modal.querySelector('textarea'));

    await clickButton(modal, 'Cancel');

    // Without this, a keyboard/screen-reader user is dropped at the top of the document on cancel.
    expect(document.activeElement).toBe(editButton);
  });

  it('removes the highlight via ctx.api.delete after the confirm step', async () => {
    const ctx = makeMockCtx({
      scope: { type: 'episode', id: 'ep-1' },
      user: { id: 'u1', role: 'podcaster' },
      apiResponses: { 'get data/episode/ep-1/highlight': { markdown: 'Delete me' } },
    });
    const container = mount(ctx);
    await flush();
    const modal = await openEditor(container);

    // One click arms the confirm; it does not delete anything yet.
    await clickButton(modal, 'Remove');
    expect(ctx.api.calls.some((c) => c.method === 'delete')).toBe(false);
    expect(modal.textContent).toContain('Remove this highlight permanently?');

    await clickButton(modal, 'Yes, remove');

    expect(ctx.api.calls).toContainEqual({
      method: 'delete',
      path: 'data/episode/ep-1/highlight',
      body: undefined,
    });
    expect(findModalShadowRoot()).toBeNull();
    expect(container.textContent).toContain('No highlight yet.');
    expect(ctx.logs).toContainEqual({ level: 'info', message: 'highlight removed at data/episode/ep-1/highlight' });
  });

  it('backs out of the confirm step without deleting', async () => {
    const ctx = makeMockCtx({
      scope: { type: 'episode', id: 'ep-1' },
      user: { id: 'u1', role: 'podcaster' },
      apiResponses: { 'get data/episode/ep-1/highlight': { markdown: 'Keep me' } },
    });
    const container = mount(ctx);
    await flush();
    const modal = await openEditor(container);

    await clickButton(modal, 'Remove');
    await clickButton(modal, 'Cancel');

    expect(ctx.api.calls.some((c) => c.method === 'delete')).toBe(false);
    // Back to the normal action row, modal still open.
    expect(modal.textContent).toContain('Save');
    expect(findModalShadowRoot()).not.toBeNull();

    await clickButton(modal, 'Cancel');
    expect(container.textContent).toContain('Keep me');
  });

  it('offers no Remove button when there is nothing stored yet', async () => {
    const ctx = makeMockCtx({ scope: { type: 'episode', id: 'ep-1' }, user: { id: 'u1', role: 'podcaster' } });
    const container = mount(ctx);
    await flush();
    const modal = await openEditor(container);

    expect(Array.from(modal.querySelectorAll('button')).map((b) => b.textContent)).toEqual(['Cancel', 'Save']);

    await clickButton(modal, 'Cancel');
  });

  it('logs a warning and keeps the modal open when the removal fails', async () => {
    const mockApi: MockApiClient = {
      calls: [],
      responses: {},
      get: () => Promise.resolve({ markdown: 'Delete me' } as never),
      post: () => Promise.reject(new Error('nope')),
      put: () => Promise.reject(new Error('nope')),
      delete: () => Promise.reject(new Error('network down')),
    };
    const ctx = makeMockCtx({
      scope: { type: 'episode', id: 'ep-1' },
      user: { id: 'u1', role: 'podcaster' },
      api: mockApi,
    });
    const container = mount(ctx);
    await flush();
    const modal = await openEditor(container);

    await clickButton(modal, 'Remove');
    await clickButton(modal, 'Yes, remove');

    expect(ctx.logs).toContainEqual({
      level: 'warn',
      message: 'highlight removal at data/episode/ep-1/highlight failed: network down',
    });
    expect(findModalShadowRoot()).not.toBeNull();

    // Portal lives on document.body — close it so it can't leak into the next test's global lookup.
    await clickButton(modal, 'Cancel');
    await clickButton(modal, 'Cancel');
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
  it('shows the backend-computed highlighted-episode stat, including the key-moment count', async () => {
    const ctx = makeMockCtx({
      scope: { type: 'site', id: 'main' },
      apiResponses: {
        'get data/site/main/highlight': { markdown: 'Welcome to the show' },
        'get data/site/main/stats': { totalEpisodes: 12, highlightedEpisodes: 3, episodesWithMoment: 2 },
      },
    });

    const container = mount(ctx);
    await flush();

    expect(container.textContent).toContain('3 of 12 episodes highlighted');
    expect(container.textContent).toContain('2 with a key moment');
  });

  it('adds the site-wide favourite total once visitors have marked anything', async () => {
    const ctx = makeMockCtx({
      scope: { type: 'site', id: 'main' },
      apiResponses: {
        'get data/site/main/highlight': { markdown: 'Welcome to the show' },
        'get data/site/main/stats': {
          totalEpisodes: 12,
          highlightedEpisodes: 3,
          episodesWithMoment: 2,
          totalFavourites: 9,
        },
      },
    });

    const container = mount(ctx);
    await flush();

    expect(container.textContent).toContain('9 favourite(s) from listeners');
  });

  it('omits the key-moment sentence when no highlighted episode has one', async () => {
    const ctx = makeMockCtx({
      scope: { type: 'site', id: 'main' },
      apiResponses: {
        'get data/site/main/highlight': { markdown: 'Welcome to the show' },
        'get data/site/main/stats': { totalEpisodes: 12, highlightedEpisodes: 3, episodesWithMoment: 0 },
      },
    });

    const container = mount(ctx);
    await flush();

    expect(container.textContent).not.toContain('with a key moment');
  });
});

describe('Highlight — the `user` storage scope (per-visitor favourites, SDK 0.5.0)', () => {
  const HIGHLIGHT = { 'get data/episode/ep-1/highlight': { markdown: 'The drop' } };

  /** Finds the favourite toggle by its star, whichever state it is in. */
  const favButton = (root: ParentNode) =>
    Array.from(root.querySelectorAll('button')).find((b) => b.textContent?.includes('★') || b.textContent?.includes('☆'));

  it('writes this visitor’s mark to data/user/me/… — never to an address naming the user', async () => {
    const ctx = makeMockCtx({
      scope: { type: 'episode', id: 'ep-1' },
      user: { id: 'u1', role: 'fan' },
      apiResponses: HIGHLIGHT,
    });

    const container = mount(ctx);
    await flush();
    await clickButton(container, '☆ Favourite this');

    // `me`, not `u1`: the host resolves the partition from the session and answers 400 to any other id.
    // The episode is in the key, because a user partition is flat.
    expect(ctx.api.calls).toContainEqual({ method: 'put', path: 'data/user/me/fav:ep-1', body: true });
    expect(ctx.api.calls.some((c) => c.path.includes('u1'))).toBe(false);
    expect(favButton(container)?.getAttribute('aria-pressed')).toBe('true');
    expect(ctx.logs).toContainEqual({ level: 'info', message: 'favourite set at data/user/me/fav:ep-1' });
  });

  it('reads the existing mark back and withdraws it with a delete', async () => {
    const ctx = makeMockCtx({
      scope: { type: 'episode', id: 'ep-1' },
      user: { id: 'u1', role: 'fan' },
      apiResponses: { ...HIGHLIGHT, 'get data/user/me/fav:ep-1': true },
    });

    const container = mount(ctx);
    await flush();
    expect(favButton(container)?.getAttribute('aria-pressed')).toBe('true');

    await clickButton(container, '★ Favourited');

    expect(ctx.api.calls).toContainEqual({ method: 'delete', path: 'data/user/me/fav:ep-1' });
    expect(favButton(container)?.getAttribute('aria-pressed')).toBe('false');
  });

  it('asks an anonymous visitor to sign in and never requests a partition they do not have', async () => {
    const ctx = makeMockCtx({ scope: { type: 'episode', id: 'ep-1' }, user: null, apiResponses: HIGHLIGHT });

    const container = mount(ctx);
    await flush();

    expect(container.textContent).toContain('Sign in to favourite this highlight');
    expect(favButton(container)).toBeUndefined();
    // An anonymous call to a user path is a 401 — the component must not make it in the first place.
    expect(ctx.api.calls.some((c) => c.path.startsWith('data/user/'))).toBe(false);
  });

  it('shows the backend-computed tally, which no browser could have assembled', async () => {
    const ctx = makeMockCtx({
      scope: { type: 'episode', id: 'ep-1' },
      user: { id: 'u1', role: 'fan' },
      apiResponses: { ...HIGHLIGHT, 'get data/episode/ep-1/favourites': { count: 7 } },
    });

    const container = mount(ctx);
    await flush();

    // A shared doc written by SamplePlugin's queryAcrossUsers rollup, not a sum of anything this
    // component can see: other visitors' marks are unreachable from here by construction.
    expect(container.textContent).toContain('7 listener(s) favourited this');
  });

  it('rolls the optimistic toggle back and logs when the write fails', async () => {
    const mockApi: MockApiClient = {
      calls: [],
      responses: HIGHLIGHT,
      get: (path: string) => Promise.resolve((HIGHLIGHT as Record<string, unknown>)[`get ${path}`] as never),
      post: () => Promise.reject(new Error('nope')),
      put: () => Promise.reject(new Error('network down')),
      delete: () => Promise.reject(new Error('network down')),
    };
    const ctx = makeMockCtx({
      scope: { type: 'episode', id: 'ep-1' },
      user: { id: 'u1', role: 'fan' },
      api: mockApi,
    });

    const container = mount(ctx);
    await flush();
    await clickButton(container, '☆ Favourite this');

    expect(favButton(container)?.getAttribute('aria-pressed')).toBe('false');
    expect(ctx.logs).toContainEqual({
      level: 'warn',
      message: 'favourite toggle at data/user/me/fav:ep-1 failed: network down',
    });
  });

  it('offers nothing to favourite when there is no highlight', async () => {
    const empty = mount(makeMockCtx({ scope: { type: 'episode', id: 'ep-1' }, user: { id: 'u1', role: 'fan' } }));
    await flush();

    expect(favButton(empty)).toBeUndefined();
  });

  it('offers nothing to favourite while a spoiler is still gated', async () => {
    const gated = mount(
      makeMockCtx({
        scope: { type: 'episode', id: 'ep-1' },
        user: { id: 'u1', role: 'fan' },
        apiResponses: { 'get data/episode/ep-1/highlight': { markdown: 'The twist', spoiler: true } },
        progress: { get: () => Promise.resolve(0) },
      }),
    );
    await flush();
    expect(favButton(gated)).toBeUndefined();
  });
});

describe('Highlight — ctx.consent (one widget per declared service, driven by request())', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('shows a click-to-load button per optional category, and only the necessary badge, when everything else is denied', async () => {
    const fetchSpy = vi.fn().mockResolvedValue(new Response(null));
    vi.stubGlobal('fetch', fetchSpy);

    const container = mount(makeMockCtx({ scope: { type: 'episode', id: 'ep-1' } }));
    await flush();

    expect(container.textContent).toContain('Allow analytics');
    expect(container.textContent).toContain('Allow functional cookies');
    expect(container.textContent).toContain('Allow the share widget');
    // `necessary` is never gated — its badge renders even though every optional category was denied.
    const badges = container.querySelectorAll('img.badge');
    expect(badges).toHaveLength(1);
    expect((badges[0] as HTMLImageElement).src).toBe('https://static.example/highlight-wordmark.svg');
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('pings the analytics beacon and renders the declared external badges once every optional category is granted', async () => {
    const fetchSpy = vi.fn().mockResolvedValue(new Response(null));
    vi.stubGlobal('fetch', fetchSpy);

    const ctx = makeMockCtx({
      scope: { type: 'episode', id: 'ep-1' },
      consent: makeMockConsent(['analytics', 'functional', 'social']),
    });
    const container = mount(ctx);
    await flush();

    expect(fetchSpy).toHaveBeenCalledWith('https://plausible.example/api/event', expect.objectContaining({ method: 'POST' }));
    expect(container.textContent).toContain('Anonymous view counted');
    const badges = container.querySelectorAll('img.badge');
    expect(badges).toHaveLength(3);
    expect(Array.from(badges).map((img) => (img as HTMLImageElement).src).sort()).toEqual([
      'https://cdn.example.com/highlight-badge.svg',
      'https://share.example.com/badge.svg',
      'https://static.example/highlight-wordmark.svg',
    ]);
  });

  it('requests, grants and logs consent on a click, then swaps the placeholder for the badge', async () => {
    const consent = makeMockConsent();
    consent.autoGrantOnRequest = true;
    const ctx = makeMockCtx({ scope: { type: 'episode', id: 'ep-1' }, consent });
    const container = mount(ctx);
    await flush();

    const requestButton = Array.from(container.querySelectorAll('button')).find((b) =>
      b.textContent?.includes('Allow functional cookies'),
    )!;
    await act(async () => {
      requestButton.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await flush();
    });

    expect(consent.requests).toEqual(['functional']);
    expect(
      Array.from(container.querySelectorAll('img.badge')).map((img) => (img as HTMLImageElement).src),
    ).toContain('https://cdn.example.com/highlight-badge.svg');
    expect(ctx.logs).toContainEqual({ level: 'info', message: 'consent: requesting "functional"' });
    expect(ctx.logs).toContainEqual({ level: 'info', message: 'consent: "functional" granted' });
  });

  it('goes back to the click-to-load button when consent is withdrawn mid-session (ctx.consent.onChange)', async () => {
    const consent = makeMockConsent(['functional']);
    const ctx = makeMockCtx({ scope: { type: 'episode', id: 'ep-1' }, consent });
    const container = mount(ctx);
    await flush();
    const badgeSrcs = () =>
      Array.from(container.querySelectorAll('img.badge')).map((img) => (img as HTMLImageElement).src);
    expect(badgeSrcs()).toContain('https://cdn.example.com/highlight-badge.svg');

    act(() => {
      consent.revoke('functional');
    });
    await flush();

    // The functional badge is gone, but the necessary one is unaffected by any decision.
    expect(badgeSrcs()).not.toContain('https://cdn.example.com/highlight-badge.svg');
    expect(badgeSrcs()).toContain('https://static.example/highlight-wordmark.svg');
    expect(container.textContent).toContain('Allow functional cookies');
  });

  it('does not render the consent extras inside the site deep-link view', async () => {
    const ctx = makeMockCtx({
      scope: { type: 'site', id: 'main' },
      route: { path: 'highlight/ep-1', onChange: () => () => {}, navigate: () => {} },
      episodeLabels: { 'ep-1': 'S01E01 · Pilot' },
      apiResponses: { 'get data/episode/ep-1/highlight': { markdown: 'A moment' } },
    });
    const container = mount(ctx);
    await flush();

    expect(container.textContent).not.toContain('analytics');
  });
});

describe('Highlight — ctx.filter (read-only season note)', () => {
  it('shows a season note at feed scope when the host filter selects one', async () => {
    const ctx = makeMockCtx({
      scope: { type: 'feed', id: 'news' },
      filter: { current: () => ({ season: 3 }), onChange: () => () => {} },
    });
    const container = mount(ctx);
    await flush();

    expect(container.textContent).toContain('Filtered to season 3');
  });

  it('shows no season note when the host filter has none selected', async () => {
    const container = mount(makeMockCtx({ scope: { type: 'feed', id: 'news' } }));
    await flush();

    expect(container.textContent).not.toContain('Filtered to season');
  });
});

describe('Highlight — ctx.player (key-moment jump/sync)', () => {
  it('renders a jump button for a highlight with a moment, seeks and logs on click', async () => {
    const seekTo = vi.fn();
    const ctx = makeMockCtx({
      scope: { type: 'episode', id: 'ep-1' },
      apiResponses: { 'get data/episode/ep-1/highlight': { markdown: 'The drop', momentSeconds: 90 } },
      player: { currentTime: () => 0, seekTo, on: () => () => {} },
    });
    const container = mount(ctx);
    await flush();

    expect(container.textContent).toContain('1:30');
    const jumpButton = Array.from(container.querySelectorAll('button')).find((b) => b.textContent?.includes('1:30'))!;
    act(() => {
      jumpButton.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(seekTo).toHaveBeenCalledWith(90);
    expect(ctx.logs).toContainEqual({ level: 'debug', message: 'jumped to key moment 90s for ep-1' });
  });

  it('shows a "played" indicator once the player reports it has passed the moment', async () => {
    let timeUpdateCb: (() => void) | undefined;
    const ctx = makeMockCtx({
      scope: { type: 'episode', id: 'ep-1' },
      apiResponses: { 'get data/episode/ep-1/highlight': { markdown: 'The drop', momentSeconds: 90 } },
      player: {
        currentTime: () => 120,
        seekTo: () => {},
        on: (_ev, cb) => {
          timeUpdateCb = cb as () => void;
          return () => {
            timeUpdateCb = undefined;
          };
        },
      },
    });
    const container = mount(ctx);
    await flush();
    expect(container.textContent).not.toContain('played');

    act(() => {
      timeUpdateCb?.();
    });
    expect(container.textContent).toContain('played');
  });
});

describe('Highlight — ctx.progress (opt-in spoiler gate)', () => {
  it('hides a highlight marked as spoiler until progress shows the visitor has started listening', async () => {
    const ctx = makeMockCtx({
      scope: { type: 'episode', id: 'ep-1' },
      apiResponses: { 'get data/episode/ep-1/highlight': { markdown: 'The killer is...', spoiler: true } },
      progress: { get: () => Promise.resolve(null) },
    });
    const container = mount(ctx);
    await flush();

    expect(container.textContent).toContain('Spoiler protection');
    expect(container.textContent).not.toContain('The killer is');

    const revealButton = Array.from(container.querySelectorAll('button')).find((b) => b.textContent === 'Show anyway')!;
    act(() => {
      revealButton.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(container.textContent).toContain('The killer is');
    expect(ctx.logs).toContainEqual({ level: 'debug', message: 'spoiler manually revealed for ep-1' });
  });

  it('shows a spoiler-marked highlight immediately once progress shows listening has started', async () => {
    const ctx = makeMockCtx({
      scope: { type: 'episode', id: 'ep-1' },
      apiResponses: { 'get data/episode/ep-1/highlight': { markdown: 'The killer is...', spoiler: true } },
      progress: { get: () => Promise.resolve(42) },
    });
    const container = mount(ctx);
    await flush();

    expect(container.textContent).toContain('The killer is');
    expect(container.textContent).not.toContain('Spoiler protection');
  });

  it('never gates a highlight that is not marked as a spoiler, regardless of progress', async () => {
    const ctx = makeMockCtx({
      scope: { type: 'episode', id: 'ep-1' },
      apiResponses: { 'get data/episode/ep-1/highlight': { markdown: 'Not a spoiler' } },
      progress: { get: () => Promise.resolve(null) },
    });
    const container = mount(ctx);
    await flush();

    expect(container.textContent).toContain('Not a spoiler');
  });
});

describe('Highlight — ctx.episode.status (PLANNED badge)', () => {
  it('shows the upcoming-episode badge for a PLANNED episode', async () => {
    const ctx = makeMockCtx({
      scope: { type: 'episode', id: 'ep-planned' },
      episode: { status: 'PLANNED' },
    });
    const container = mount(ctx);
    await flush();

    expect(container.textContent).toContain('Upcoming episode');
  });

  it('shows no badge for a PUBLISHED episode', async () => {
    const ctx = makeMockCtx({
      scope: { type: 'episode', id: 'ep-1' },
      episode: { status: 'PUBLISHED' },
    });
    const container = mount(ctx);
    await flush();

    expect(container.textContent).not.toContain('Upcoming episode');
  });
});

describe('Highlight — ctx.route (site-scope deep link + browse index)', () => {
  it('lists every episode in scope as a highlight deep link at the site root', async () => {
    const ctx = makeMockCtx({
      scope: { type: 'site', id: 'main' },
      episodes: ['ep-1', 'ep-2'],
      episodeLabels: { 'ep-1': 'S01E01 · Pilot', 'ep-2': 'S01E02 · The Reveal' },
    });
    const container = mount(ctx);
    await flush();

    const links = Array.from(container.querySelectorAll('a')).map((a) => [a.getAttribute('href'), a.textContent]);
    expect(links).toContainEqual(['/p/sample/highlight/ep-1', 'S01E01 · Pilot']);
    expect(links).toContainEqual(['/p/sample/highlight/ep-2', 'S01E02 · The Reveal']);
  });

  it('renders a single-episode read-only view when ctx.route.path matches a highlight deep link', async () => {
    const ctx = makeMockCtx({
      scope: { type: 'site', id: 'main' },
      user: { id: 'u1', role: 'admin' },
      route: { path: 'highlight/ep-1', onChange: () => () => {}, navigate: () => {} },
      episodeLabels: { 'ep-1': 'S01E01 · Pilot' },
      apiResponses: { 'get data/episode/ep-1/highlight': { markdown: 'Deep-linked moment' } },
    });
    const container = mount(ctx);
    await flush();

    expect(container.textContent).toContain('Deep-linked moment');
    expect(container.querySelector('.title')!.textContent).toBe('S01E01 · Pilot');
    // Read-only: no Edit button, even for an admin, and no browse index or stats block underneath.
    expect(container.querySelector('button')).toBeNull();
    expect(container.textContent).not.toContain('Browse highlighted episodes');
    const backLink = container.querySelector('a.back') as HTMLAnchorElement;
    expect(backLink.getAttribute('href')).toBe('/p/sample/');
  });

  it('percent-encodes the visitor-controlled deep-link slug before it becomes an API path segment', async () => {
    // `ctx.route.path` comes out of the URL, so an unencoded `..` would be normalized away by the
    // browser and point the request at a different doc than the one the deep link names.
    const ctx = makeMockCtx({
      scope: { type: 'site', id: 'main' },
      route: { path: 'highlight/../../site/main/settings', onChange: () => () => {}, navigate: () => {} },
    });
    mount(ctx);
    await flush();

    expect(ctx.api.calls).toContainEqual({
      method: 'get',
      path: 'data/episode/..%2F..%2Fsite%2Fmain%2Fsettings/highlight',
      body: undefined,
    });
  });

  it('encodes episode slugs in the browse index links', async () => {
    const ctx = makeMockCtx({
      scope: { type: 'site', id: 'main' },
      episodes: ['ep 1/odd'],
    });
    const container = mount(ctx);
    await flush();

    const link = Array.from(container.querySelectorAll('a')).find((a) => a.textContent === 'ep 1/odd')!;
    expect(link.getAttribute('href')).toBe('/p/sample/highlight/ep%201%2Fodd');
  });
});

describe('Highlight — ctx.route.navigate (SPA navigation inside /p/sample/, SDK 0.7.0)', () => {
  /**
   * Clicks a link the way a browser reports it and answers the question these tests actually ask: did the
   * component's handler call `preventDefault`, i.e. did it take the click instead of letting the `href` run?
   *
   * The document-level listener runs after React's (which is bound to the mount container, further down the
   * tree) and cancels whatever survived — otherwise jsdom would try to follow the `href` for real and log
   * `Not implemented: navigation` on every fall-through case.
   */
  function clickWasHandled(el: Element, init: MouseEventInit = { button: 0 }): boolean {
    let handled = false;
    const stopRealNavigation = (e: Event) => {
      handled = e.defaultPrevented;
      e.preventDefault();
    };
    document.addEventListener('click', stopRealNavigation);
    try {
      act(() => {
        el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, ...init }));
      });
    } finally {
      document.removeEventListener('click', stopRealNavigation);
    }
    return handled;
  }

  it('routes a plain click on a browse-index link through navigate instead of the href', async () => {
    const ctx = makeMockCtx({
      scope: { type: 'site', id: 'main' },
      episodes: ['ep 1/odd'],
    });
    const container = mount(ctx);
    await flush();

    const link = Array.from(container.querySelectorAll('a')).find((a) => a.textContent === 'ep 1/odd')!;
    const handled = clickWasHandled(link);

    // The subpath is the same coordinate `ctx.route.path` hands back — relative to /p/sample/, not absolute.
    expect(ctx.navigations).toEqual([{ subpath: 'highlight/ep%201%2Fodd', replace: false }]);
    // preventDefault is what stops the browser also performing the href's full document load.
    expect(handled).toBe(true);
  });

  it('lets a modified click fall through to the browser, so "open in new tab" still opens a new tab', async () => {
    const ctx = makeMockCtx({
      scope: { type: 'site', id: 'main' },
      episodes: ['ep-1'],
      episodeLabels: { 'ep-1': 'S01E01 · Pilot' },
    });
    const container = mount(ctx);
    await flush();

    const link = Array.from(container.querySelectorAll('a')).find((a) => a.textContent === 'S01E01 · Pilot')!;
    for (const modifier of ['metaKey', 'ctrlKey', 'shiftKey', 'altKey'] as const) {
      expect(clickWasHandled(link, { button: 0, [modifier]: true })).toBe(false);
    }
    // Same for a middle-click, which the browser turns into a new tab on its own.
    expect(clickWasHandled(link, { button: 1 })).toBe(false);

    expect(ctx.navigations).toEqual([]);
    // The href survives all of it — that attribute is what a new tab, a copied link and a crawler read.
    expect(link.getAttribute('href')).toBe('/p/sample/highlight/ep-1');
  });

  it('navigates back to the plugin page root from the deep-link view', async () => {
    const navigate = vi.fn();
    const ctx = makeMockCtx({
      scope: { type: 'site', id: 'main' },
      route: { path: 'highlight/ep-1', onChange: () => () => {}, navigate },
      episodeLabels: { 'ep-1': 'S01E01 · Pilot' },
      apiResponses: { 'get data/episode/ep-1/highlight': { markdown: 'Deep-linked moment' } },
    });
    const container = mount(ctx);
    await flush();

    const backLink = container.querySelector('a.back')!;
    expect(backLink.getAttribute('href')).toBe('/p/sample/');
    const handled = clickWasHandled(backLink);

    // '' is the plugin's own page root: navigate's argument is always relative to /p/sample/.
    expect(navigate).toHaveBeenCalledWith('');
    expect(handled).toBe(true);
  });
});
