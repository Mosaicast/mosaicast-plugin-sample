// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 The Mosaicast Authors

import { afterEach, describe, expect, it, vi } from 'vitest';
import { createRoot } from 'react-dom/client';
import { act } from 'react';
import { makeMockCtx, makeMockConsent, makeMockBlobs, makeMockDocs, makeMockFeeds, makeMockTags } from '@mosaicast/plugin-sdk/testing';
import type { MockBlobClient, MockDocClient } from '@mosaicast/plugin-sdk/testing';
import type { PluginContext } from '@mosaicast/plugin-sdk';
import { docsFailing, docsRecording, flush, hostError, mockUser } from '../test-utils';
import { Highlight } from './Highlight';
import { MODAL_PORTAL_ATTR } from './HighlightModal';

/**
 * What the mock doc store currently holds, keyed `"<partition>/<key>"`.
 *
 * The doc double replaces the recorded `ctx.api.calls` these tests used to assert on, and asserting on
 * *state* rather than on a call is the better test anyway: it survives the component batching two writes
 * into one, or reordering them, and it fails when a write lands somewhere other than where it was aimed.
 */
const storedIn = (ctx: PluginContext) => (ctx.docs as MockDocClient).stored;

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
      docs: makeMockDocs({
        'data/episode/ep-1/highlight': { markdown: '**Great** cliffhanger! <script>alert(1)</script>' },
      }),
    });

    const container = mount(ctx);
    await flush();

    expect(container.querySelector('strong')?.textContent).toBe('Great');
    expect(container.innerHTML).not.toContain('<script>');
  });

  it('drops a stylesheet in the markdown, which DOMPurify defaults let through (SDK 0.16.0)', async () => {
    // The payload that defaced the wiki plugin: under the contract's `style-src 'unsafe-inline'` a
    // podcaster-written `<style>` becomes a full-viewport overlay. `ctx.sanitize` applies the host's policy.
    const ctx = makeMockCtx({
      scope: { type: 'episode', id: 'ep-1' },
      docs: makeMockDocs({
        'data/episode/ep-1/highlight': {
          markdown: 'Fine <style>:host{position:fixed;inset:0}</style><span style="position:fixed">x</span>',
        },
      }),
    });

    const container = mount(ctx);
    await flush();

    const content = container.querySelector('.content')!;
    expect(content.textContent).toContain('Fine');
    expect(content.querySelector('style')).toBeNull();
    expect(content.querySelector('[style]')).toBeNull();
  });

  it('keeps a resumed list number and table alignment through the sanitizer (SDK 0.16.1)', async () => {
    // Ordinary Markdown the 0.16.0 policy broke: `marked` writes `<ol start="3">` for a list that resumes
    // after a paragraph and `align` for a column's alignment. Dropping `start` renumbers from 1, which
    // changes what the list says.
    const ctx = makeMockCtx({
      scope: { type: 'episode', id: 'ep-1' },
      docs: makeMockDocs({
        'data/episode/ep-1/highlight': {
          markdown: '3. third\n4. fourth\n\n| Time | Topic |\n| :--: | ----- |\n| 12:00 | Kraken |',
        },
      }),
    });

    const container = mount(ctx);
    await flush();

    const content = container.querySelector('.content')!;
    expect(content.querySelector('ol')?.getAttribute('start')).toBe('3');
    expect(content.querySelector('th')?.getAttribute('align')).toBe('center');
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
      makeMockCtx({ scope: { type: 'episode', id: 'ep-1' }, user: mockUser('u1', 'fan') }),
    );
    await flush();
    expect(findEditButton(fan)).toBeUndefined();
  });

  it('shows the Edit button for podcaster and admin users and saves via ctx.api.put', async () => {
    const ctx = makeMockCtx({
      scope: { type: 'episode', id: 'ep-1' },
      user: mockUser('u1', 'podcaster'),
      docs: makeMockDocs({ 'data/episode/ep-1/highlight': { markdown: 'Original text' } }),
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

    expect(storedIn(ctx)['data/episode/ep-1/highlight']).toEqual({ markdown: 'Updated highlight', authorId: 'u1' });
    // Modal (and its portal host) is gone after a successful save.
    expect(findModalShadowRoot()).toBeNull();
    expect(ctx.logs).toContainEqual({ level: 'info', message: 'highlight saved for episode ep-1' });
  });

  it('shows the refusal and keeps the modal open when the save fails', async () => {
    // A 403 with the host's own problem detail — which is the case worth picking, because it is the one
    // the contract deliberately words apart from the *other* 403 (the write floor vs. a `backendOwned`
    // key). Before SDK 0.9.0 the rejection was untyped and a plugin could not tell them apart, so both
    // became the same silent log line and a Save button that appeared to work.
    const ctx = makeMockCtx({
      scope: { type: 'episode', id: 'ep-1' },
      user: mockUser('u1', 'podcaster'),
      docs: docsFailing(makeMockDocs(), 'put', hostError(403, 'this key is written by the plugin backend')),
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
      message: 'highlight save for episode ep-1 failed',
    });
    expect(findModalShadowRoot()).not.toBeNull();
    // The point of the release: the podcaster is *told*, in the modal they are still standing in, and the
    // host's own wording for the refusal is carried through rather than being flattened into "failed".
    expect(modal.textContent).toContain('The site refused this request.');
    expect(modal.textContent).toContain('this key is written by the plugin backend');

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
      user: mockUser('u1', 'podcaster'),
      docs: makeMockDocs({ 'data/episode/ep-1/highlight': { markdown: 'The drop' } }),
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

    expect(storedIn(ctx)['data/episode/ep-1/highlight']).toEqual({ markdown: 'The drop', momentSeconds: 0, authorId: 'u1' });
  });

  it('omits momentSeconds entirely when the field is left blank or unparseable', async () => {
    const ctx = makeMockCtx({
      scope: { type: 'episode', id: 'ep-1' },
      user: mockUser('u1', 'podcaster'),
      docs: makeMockDocs({ 'data/episode/ep-1/highlight': { markdown: 'The drop' } }),
    });
    const container = mount(ctx);
    await flush();
    const modal = await openEditor(container);
    await clickButton(modal, 'Save');

    expect(storedIn(ctx)['data/episode/ep-1/highlight']).toEqual({ markdown: 'The drop', authorId: 'u1' });
  });

  it('credits whoever wrote the highlight, not whoever last edited it (SDK 0.13.0)', async () => {
    // Preserve-or-set. A second podcaster fixing a typo is not the author, and `ctx.users` resolves the
    // stored id at render — so overwriting here would quietly reassign the byline on every save.
    const ctx = makeMockCtx({
      scope: { type: 'episode', id: 'ep-1' },
      user: mockUser('u2', 'podcaster'),
      docs: makeMockDocs({
        'data/episode/ep-1/highlight': { markdown: 'The drop', authorId: 'u1' },
      }),
    });
    const container = mount(ctx);
    await flush();
    const modal = await openEditor(container);
    await clickButton(modal, 'Save');

    expect(storedIn(ctx)['data/episode/ep-1/highlight']).toEqual({ markdown: 'The drop', authorId: 'u1' });
  });

  it('names the dialog, focuses the textarea on open and restores focus to Edit on close', async () => {
    const ctx = makeMockCtx({ scope: { type: 'episode', id: 'ep-1' }, user: mockUser('u1', 'podcaster') });
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
      user: mockUser('u1', 'podcaster'),
      docs: makeMockDocs({ 'data/episode/ep-1/highlight': { markdown: 'Delete me' } }),
    });
    const container = mount(ctx);
    await flush();
    const modal = await openEditor(container);

    // One click arms the confirm; it does not delete anything yet.
    await clickButton(modal, 'Remove');
    expect(storedIn(ctx)['data/episode/ep-1/highlight']).toBeDefined();
    expect(modal.textContent).toContain('Remove this highlight permanently?');

    await clickButton(modal, 'Yes, remove');

    expect(storedIn(ctx)['data/episode/ep-1/highlight']).toBeUndefined();
    expect(findModalShadowRoot()).toBeNull();
    expect(container.textContent).toContain('No highlight yet.');
    expect(ctx.logs).toContainEqual({ level: 'info', message: 'highlight removed for episode ep-1' });
  });

  it('backs out of the confirm step without deleting', async () => {
    const ctx = makeMockCtx({
      scope: { type: 'episode', id: 'ep-1' },
      user: mockUser('u1', 'podcaster'),
      docs: makeMockDocs({ 'data/episode/ep-1/highlight': { markdown: 'Keep me' } }),
    });
    const container = mount(ctx);
    await flush();
    const modal = await openEditor(container);

    await clickButton(modal, 'Remove');
    await clickButton(modal, 'Cancel');

    expect(storedIn(ctx)['data/episode/ep-1/highlight']).toBeDefined();
    // Back to the normal action row, modal still open.
    expect(modal.textContent).toContain('Save');
    expect(findModalShadowRoot()).not.toBeNull();

    await clickButton(modal, 'Cancel');
    expect(container.textContent).toContain('Keep me');
  });

  it('offers no Remove button when there is nothing stored yet', async () => {
    const ctx = makeMockCtx({ scope: { type: 'episode', id: 'ep-1' }, user: mockUser('u1', 'podcaster') });
    const container = mount(ctx);
    await flush();
    const modal = await openEditor(container);

    expect(Array.from(modal.querySelectorAll('button')).map((b) => b.textContent)).toEqual(['Cancel', 'Save']);

    await clickButton(modal, 'Cancel');
  });

  it('shows the failure and keeps the modal open when the removal fails', async () => {
    const ctx = makeMockCtx({
      scope: { type: 'episode', id: 'ep-1' },
      user: mockUser('u1', 'podcaster'),
      // A 500 rather than a refusal: the read still works, so the modal loads and only the delete fails.
      // `error.unavailable` is what a status the plugin has no specific branch for renders as — including
      // the network failure that carries no status at all, which is why `isPluginApiError` is a guard and
      // not an assumption.
      docs: docsFailing(
        makeMockDocs({ 'data/episode/ep-1/highlight': { markdown: 'Delete me' } }),
        'remove',
        hostError(500),
      ),
    });
    const container = mount(ctx);
    await flush();
    const modal = await openEditor(container);

    await clickButton(modal, 'Remove');
    await clickButton(modal, 'Yes, remove');

    expect(ctx.logs).toContainEqual({
      level: 'warn',
      message: 'highlight removal for episode ep-1 failed',
    });
    expect(findModalShadowRoot()).not.toBeNull();
    expect(modal.textContent).toContain('This could not be loaded right now.');

    // Portal lives on document.body — close it so it can't leak into the next test's global lookup.
    await clickButton(modal, 'Cancel');
    await clickButton(modal, 'Cancel');
  });

  it('closes the modal without saving on Cancel', async () => {
    const ctx = makeMockCtx({
      scope: { type: 'episode', id: 'ep-1' },
      user: mockUser('u1', 'admin'),
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
    expect(storedIn(ctx)['data/episode/ep-1/highlight']).toBeUndefined();
  });
});

describe('Highlight — feed (podcast) scope', () => {
  it('addresses the feed-scoped doc and does not show episode stats', async () => {
    const ctx = makeMockCtx({
      scope: { type: 'feed', id: 'news' },
      docs: makeMockDocs({ 'data/feed/news/highlight': { markdown: 'Weekly news roundup' } }),
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
      docs: makeMockDocs({
        'data/site/main/highlight': { markdown: 'Welcome to the show' },
        'data/site/main/stats': { totalEpisodes: 12, highlightedEpisodes: 3, episodesWithMoment: 2 },
      }),
    });

    const container = mount(ctx);
    await flush();

    expect(container.textContent).toContain('3 of 12 episodes highlighted');
    expect(container.textContent).toContain('2 with key moments');
  });

  it('adds the site-wide favourite total once visitors have marked anything', async () => {
    const ctx = makeMockCtx({
      scope: { type: 'site', id: 'main' },
      docs: makeMockDocs({
        'data/site/main/highlight': { markdown: 'Welcome to the show' },
        'data/site/main/stats': {
          totalEpisodes: 12,
          highlightedEpisodes: 3,
          episodesWithMoment: 2,
          totalFavourites: 9,
        },
      }),
    });

    const container = mount(ctx);
    await flush();

    expect(container.textContent).toContain('9 favourites from listeners');
  });

  it('omits the key-moment sentence when no highlighted episode has one', async () => {
    const ctx = makeMockCtx({
      scope: { type: 'site', id: 'main' },
      docs: makeMockDocs({
        'data/site/main/highlight': { markdown: 'Welcome to the show' },
        'data/site/main/stats': { totalEpisodes: 12, highlightedEpisodes: 3, episodesWithMoment: 0 },
      }),
    });

    const container = mount(ctx);
    await flush();

    expect(container.textContent).not.toContain('with a key moment');
  });
});

describe('Highlight — the `user` storage scope (per-visitor favourites, SDK 0.5.0)', () => {
  const HIGHLIGHT = { 'data/episode/ep-1/highlight': { markdown: 'The drop' } };

  /** Finds the favourite toggle in either state. `aria-pressed` is the only marker it always carries —
   *  its label changes with the state, and since the icons became `--mc-icon-*` masks (core 0.6.15) the
   *  star is a CSS background rather than text, so nothing about it is greppable from the DOM. */
  const favButton = (root: ParentNode) =>
    Array.from(root.querySelectorAll('button')).find((b) => b.hasAttribute('aria-pressed'));

  it('writes this visitor’s mark to data/user/me/… — never to an address naming the user', async () => {
    const ctx = makeMockCtx({
      scope: { type: 'episode', id: 'ep-1' },
      user: mockUser('u1', 'fan'),
      docs: makeMockDocs(HIGHLIGHT),
    });

    const container = mount(ctx);
    await flush();
    await clickButton(container, 'Favourite this');

    // `me`, not `u1`: `ctx.docs.put('self', …)` resolves to `data/user/me`, which the host resolves from
    // the session and answers 400 to any other id for. The episode is in the key, because a user
    // partition is flat. That `'self'` is also the *shortest* call is the whole design — the most
    // security-relevant convention in the contract is the one that has to be the least work to follow.
    expect(storedIn(ctx)['data/user/me/fav:ep-1']).toBe(true);
    expect(Object.keys(storedIn(ctx)).some((path) => path.includes('u1'))).toBe(false);
    expect(favButton(container)?.getAttribute('aria-pressed')).toBe('true');
    expect(ctx.logs).toContainEqual({ level: 'info', message: 'favourite set for ep-1' });
  });

  it('reads the existing mark back and withdraws it with a delete', async () => {
    const ctx = makeMockCtx({
      scope: { type: 'episode', id: 'ep-1' },
      user: mockUser('u1', 'fan'),
      docs: makeMockDocs({ ...HIGHLIGHT, 'data/user/me/fav:ep-1': true }),
    });

    const container = mount(ctx);
    await flush();
    expect(favButton(container)?.getAttribute('aria-pressed')).toBe('true');

    await clickButton(container, 'Favourited');

    expect(storedIn(ctx)['data/user/me/fav:ep-1']).toBeUndefined();
    expect(favButton(container)?.getAttribute('aria-pressed')).toBe('false');
  });

  it('asks an anonymous visitor to sign in and never requests a partition they do not have', async () => {
    const docs = docsRecording(makeMockDocs(HIGHLIGHT));
    const ctx = makeMockCtx({ scope: { type: 'episode', id: 'ep-1' }, user: null, docs });

    const container = mount(ctx);
    await flush();

    expect(container.textContent).toContain('Sign in to favourite this highlight');
    expect(favButton(container)).toBeUndefined();
    // An anonymous call to a user path is a 401 — the component must not make it in the first place, and
    // the rendered hint above does not prove that. This is the one assertion the in-memory doc double
    // cannot make on its own, which is why test-utils wraps it in a recorder.
    expect(docs.reads.some((read) => read.startsWith('self/'))).toBe(false);
  });

  it('shows the backend-computed tally, which no browser could have assembled', async () => {
    const ctx = makeMockCtx({
      scope: { type: 'episode', id: 'ep-1' },
      user: mockUser('u1', 'fan'),
      docs: makeMockDocs({ ...HIGHLIGHT, 'data/episode/ep-1/favourites': { count: 7 } }),
    });

    const container = mount(ctx);
    await flush();

    // A shared doc written by SamplePlugin's queryAcrossUsers rollup, not a sum of anything this
    // component can see: other visitors' marks are unreachable from here by construction.
    expect(container.textContent).toContain('7 listeners favourited this');
  });

  it('rolls the optimistic toggle back and logs when the write fails', async () => {
    const ctx = makeMockCtx({
      scope: { type: 'episode', id: 'ep-1' },
      user: mockUser('u1', 'fan'),
      docs: docsFailing(makeMockDocs(HIGHLIGHT), 'put', hostError(500)),
    });

    const container = mount(ctx);
    await flush();
    await clickButton(container, 'Favourite this');

    expect(favButton(container)?.getAttribute('aria-pressed')).toBe('false');
    expect(ctx.logs).toContainEqual({
      level: 'warn',
      message: 'favourite toggle for ep-1 failed (error.unavailable)',
    });
  });

  it('offers nothing to favourite when there is no highlight', async () => {
    const empty = mount(makeMockCtx({ scope: { type: 'episode', id: 'ep-1' }, user: mockUser('u1', 'fan') }));
    await flush();

    expect(favButton(empty)).toBeUndefined();
  });

  it('offers nothing to favourite while a spoiler is still gated', async () => {
    const gated = mount(
      makeMockCtx({
        scope: { type: 'episode', id: 'ep-1' },
        user: mockUser('u1', 'fan'),
        docs: makeMockDocs({ 'data/episode/ep-1/highlight': { markdown: 'The twist', spoiler: true } }),
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
      route: { path: 'highlight/ep-1' },
      episodeLabels: { 'ep-1': 'S01E01 · Pilot' },
      docs: makeMockDocs({ 'data/episode/ep-1/highlight': { markdown: 'A moment' } }),
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
      docs: makeMockDocs({ 'data/episode/ep-1/highlight': { markdown: 'The drop', momentSeconds: 90 } }),
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
      docs: makeMockDocs({ 'data/episode/ep-1/highlight': { markdown: 'The drop', momentSeconds: 90 } }),
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
      docs: makeMockDocs({ 'data/episode/ep-1/highlight': { markdown: 'The killer is...', spoiler: true } }),
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
      docs: makeMockDocs({ 'data/episode/ep-1/highlight': { markdown: 'The killer is...', spoiler: true } }),
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
      docs: makeMockDocs({ 'data/episode/ep-1/highlight': { markdown: 'Not a spoiler' } }),
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
      user: mockUser('u1', 'admin'),
      route: { path: 'highlight/ep-1' },
      episodeLabels: { 'ep-1': 'S01E01 · Pilot' },
      docs: makeMockDocs({ 'data/episode/ep-1/highlight': { markdown: 'Deep-linked moment' } }),
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

  it('cannot express a traversal out of the deep-link route at all', async () => {
    // `ctx.route.path` comes out of the URL. The version of this test before 2.12.0 asserted that the
    // plugin percent-encoded a `..` before splicing it into a doc *path* — a defence that had to be
    // remembered at every call site. `matchRoute` removes the need for it: `highlight/:slug` captures
    // exactly **one** segment, so a six-segment path matches nothing, there is no deep link, and no
    // request is built from it. The safe thing stopped being a step someone can forget.
    const docs = docsRecording(makeMockDocs());
    const ctx = makeMockCtx({
      scope: { type: 'site', id: 'main' },
      route: { path: 'highlight/../../site/main/settings' },
      docs,
    });
    mount(ctx);
    await flush();

    expect(docs.reads.some((read) => read.startsWith('episode:'))).toBe(false);
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
    // `route` is the one override makeMockCtx *merges* (SDK 0.7.1): pinning `path` is enough, and the
    // default `navigate` it leaves in place is still the one recording into `ctx.navigations`.
    const ctx = makeMockCtx({
      scope: { type: 'site', id: 'main' },
      route: { path: 'highlight/ep-1' },
      episodeLabels: { 'ep-1': 'S01E01 · Pilot' },
      docs: makeMockDocs({ 'data/episode/ep-1/highlight': { markdown: 'Deep-linked moment' } }),
    });
    const container = mount(ctx);
    await flush();

    const backLink = container.querySelector('a.back')!;
    expect(backLink.getAttribute('href')).toBe('/p/sample/');
    const handled = clickWasHandled(backLink);

    // '' is the plugin's own page root: navigate's argument is always relative to /p/sample/.
    expect(ctx.navigations).toEqual([{ subpath: '', replace: false }]);
    expect(handled).toBe(true);
  });
});

describe('Highlight — ctx.links (linking to core pages, SDK 0.8.0)', () => {
  const hrefsOf = (root: ParentNode) =>
    Array.from(root.querySelectorAll('a')).map((a) => a.getAttribute('href'));

  it('links each browse-index row to core’s episode page as well as to its own deep link', async () => {
    const ctx = makeMockCtx({
      scope: { type: 'site', id: 'main' },
      episodes: ['ep-1'],
      episodeLabels: { 'ep-1': 'S01E01 · Pilot' },
    });
    const container = mount(ctx);
    await flush();

    // Both links, and the pair is the point: one stays in the plugin's subtree, one leaves for core.
    expect(hrefsOf(container)).toContain('/p/sample/highlight/ep-1');
    expect(hrefsOf(container)).toContain(ctx.links.episode('ep-1'));
  });

  it('carries the podcaster’s key moment into core’s ?t= deep link from the single-highlight view', async () => {
    const ctx = makeMockCtx({
      scope: { type: 'site', id: 'main' },
      route: { path: 'highlight/ep-1' },
      episodeLabels: { 'ep-1': 'S01E01 · Pilot' },
      docs: makeMockDocs({
        'data/episode/ep-1/highlight': { markdown: 'The drop', momentSeconds: 724 },
      }),
    });
    const container = mount(ctx);
    await flush();

    const listen = container.querySelector('.listen a') as HTMLAnchorElement;
    // Built by the host, not by this plugin concatenating `/episodes/${slug}?t=`.
    expect(listen.getAttribute('href')).toBe(ctx.links.episode('ep-1', { t: 724 }));
    expect(listen.textContent).toContain('12:04');
  });

  it('omits ?t= when the highlight names no key moment', async () => {
    const ctx = makeMockCtx({
      scope: { type: 'site', id: 'main' },
      route: { path: 'highlight/ep-1' },
      docs: makeMockDocs({ 'data/episode/ep-1/highlight': { markdown: 'A moment' } }),
    });
    const container = mount(ctx);
    await flush();

    const listen = container.querySelector('.listen a') as HTMLAnchorElement;
    expect(listen.getAttribute('href')).toBe(ctx.links.episode('ep-1'));
  });

  it('links the feed-scope season note to core’s filtered feed', async () => {
    const ctx = makeMockCtx({
      scope: { type: 'feed', id: 'main' },
      filter: { current: () => ({ season: 2 }), onChange: () => () => {} },
      docs: makeMockDocs({ 'data/feed/main/highlight': { markdown: 'Season two' } }),
    });
    const container = mount(ctx);
    await flush();

    const note = container.querySelector('.filterNote a') as HTMLAnchorElement;
    // The axis is numeric on ctx.filter and a string in the URL builder — the host owns that conversion.
    expect(note.getAttribute('href')).toBe(ctx.links.feed('main', { season: '2' }));
  });
});

describe('Highlight — ctx.blobs (podcaster-uploaded image, SDK 0.8.0)', () => {
  const PNG = 'image/png';

  /** A stand-in for what an `<input type="file">` hands over. */
  function file(name: string, mime: string, bytes: number): File {
    return new File([new Uint8Array(bytes)], name, { type: mime });
  }

  /** Mounts a podcaster view with blob storage and opens the editor. */
  async function openEditorWith(blobs: MockBlobClient, overrides: Record<string, unknown> = {}) {
    const ctx = makeMockCtx({
      scope: { type: 'episode', id: 'ep-1' },
      user: mockUser('u1', 'podcaster'),
      blobs,
      docs: makeMockDocs({ 'data/episode/ep-1/highlight': { markdown: 'The drop' } }),
      ...overrides,
    });
    const container = mount(ctx);
    await flush();
    const modal = await openEditor(container);
    return { ctx, container, modal };
  }

  /** Picks a file through the modal's file input, the way a podcaster would. */
  async function pick(modal: ParentNode, f: File) {
    const input = modal.querySelector('input[type="file"]') as HTMLInputElement;
    Object.defineProperty(input, 'files', { value: [f], configurable: true });
    await act(async () => {
      input.dispatchEvent(new Event('change', { bubbles: true }));
      await flush();
    });
  }

  afterEach(async () => {
    // The modal portals to document.body, so an open one would leak into the next test.
    const modal = findModalShadowRoot();
    if (modal) await clickButton(modal, 'Cancel');
  });

  it('uploads a picked image and stores the ref — never the URL — in the highlight doc', async () => {
    const blobs = makeMockBlobs({ mimeTypes: [PNG] });
    const { ctx, modal } = await openEditorWith(blobs);

    await pick(modal, file('cover.png', PNG, 1024));
    expect(blobs.uploads).toEqual([{ filename: 'cover.png', mime: PNG, size: 1024 }]);

    await clickButton(modal, 'Save');

    const body = storedIn(ctx)['data/episode/ep-1/highlight'] as { image?: { ref: string; alt: string } };
    expect(body.image?.ref).toBe(blobs.stored[0].ref);
    // The whole point of storing a ref: no derived URL is persisted anywhere in the document.
    expect(JSON.stringify(body)).not.toContain(blobs.urlFor(blobs.stored[0].ref));
  });

  it('renders a stored image through urlFor, derived at render time', async () => {
    const blobs = makeMockBlobs({ mimeTypes: [PNG] });
    const stored = await blobs.upload(file('cover.png', PNG, 512));
    const ctx = makeMockCtx({
      scope: { type: 'episode', id: 'ep-1' },
      blobs,
      docs: makeMockDocs({
        'data/episode/ep-1/highlight': {
          markdown: 'The drop',
          image: { ref: stored.ref, alt: 'A waveform' },
        },
      }),
    });
    const container = mount(ctx);
    await flush();

    const img = container.querySelector('img.image') as HTMLImageElement;
    expect(img.getAttribute('src')).toBe(blobs.urlFor(stored.ref));
    expect(img.getAttribute('alt')).toBe('A waveform');
  });

  it('shows the refusal to the podcaster when the file is too large', async () => {
    const blobs = makeMockBlobs({ mimeTypes: [PNG], maxFileBytes: 1000 });
    const { modal } = await openEditorWith(blobs);

    await pick(modal, file('huge.png', PNG, 5000));

    // Reaching the DOM is the assertion that matters: only the person at the file picker can fix this,
    // so a ctx.log line alone would be a silent failure.
    expect(modal.querySelector('.uploadError')!.textContent).toContain('Upload refused');
    expect(blobs.stored).toHaveLength(0);
  });

  it('shows the refusal when the type is outside the manifest’s allow-list', async () => {
    const blobs = makeMockBlobs({ mimeTypes: [PNG] });
    const { modal } = await openEditorWith(blobs);

    await pick(modal, file('diagram.gif', 'image/gif', 100));

    expect(modal.querySelector('.uploadError')).not.toBeNull();
    expect(blobs.stored).toHaveLength(0);
  });

  it('shows the refusal when the bytes contradict the declared type', async () => {
    // Stands in for the host reading the leading bytes — the check neither double reimplements.
    const blobs = makeMockBlobs({ mimeTypes: [PNG], rejectContent: ['not-really.png'] });
    const { modal } = await openEditorWith(blobs);

    await pick(modal, file('not-really.png', PNG, 100));

    expect(modal.querySelector('.uploadError')).not.toBeNull();
    expect(blobs.stored).toHaveLength(0);
  });

  it('drops the previous blob when an image is replaced', async () => {
    const blobs = makeMockBlobs({ mimeTypes: [PNG] });
    const { modal } = await openEditorWith(blobs);

    await pick(modal, file('first.png', PNG, 100));
    const first = blobs.stored[0].ref;
    await pick(modal, file('second.png', PNG, 200));

    expect(blobs.removals).toContain(first);
  });

  it('drops the blob after the highlight that pointed at it is removed', async () => {
    const blobs = makeMockBlobs({ mimeTypes: [PNG] });
    const stored = await blobs.upload(file('cover.png', PNG, 128));
    const { modal } = await openEditorWith(blobs, {
      docs: makeMockDocs({
        'data/episode/ep-1/highlight': {
          markdown: 'The drop',
          image: { ref: stored.ref, alt: 'A waveform' },
        },
      }),
    });

    // Two-step confirm: the first click arms it, the second is the irreversible one.
    await clickButton(modal, 'Remove');
    await clickButton(modal, 'Yes, remove');

    expect(blobs.removals).toContain(stored.ref);
  });

  it('degrades to text when the operator refused the blobs block (ctx.blobs === null)', async () => {
    const ctx = makeMockCtx({
      scope: { type: 'episode', id: 'ep-1' },
      user: mockUser('u1', 'podcaster'),
      blobs: null,
      docs: makeMockDocs({
        'data/episode/ep-1/highlight': {
          markdown: 'The drop',
          image: { ref: 'blob-1', alt: 'A waveform' },
        },
      }),
    });
    const container = mount(ctx);
    await flush();

    // No broken <img> pointing nowhere; the alt text still carries the meaning.
    expect(container.querySelector('img.image')).toBeNull();
    expect(container.querySelector('.imageAlt')!.textContent).toBe('A waveform');

    const modal = await openEditor(container);
    expect(modal.querySelector('input[type="file"]')).toBeNull();
    await clickButton(modal, 'Cancel');
  });

  it('offers no upload at feed scope, because the backend sweep cannot enumerate feeds', async () => {
    const blobs = makeMockBlobs({ mimeTypes: [PNG] });
    const ctx = makeMockCtx({
      scope: { type: 'feed', id: 'main' },
      user: mockUser('u1', 'podcaster'),
      blobs,
      docs: makeMockDocs({ 'data/feed/main/highlight': { markdown: 'Season two' } }),
    });
    const container = mount(ctx);
    await flush();
    const modal = await openEditor(container);

    expect(modal.querySelector('input[type="file"]')).toBeNull();
    await clickButton(modal, 'Cancel');
  });
});

/** plugin-sample#48: the section titles are headings, so heading navigation finds them. */
describe('Highlight — headings', () => {
  it('titles the section with an h2, the level below every placement’s own h1', async () => {
    const container = mount(makeMockCtx({ scope: { type: 'episode', id: 'ep-1' } }));
    await flush();

    const title = container.querySelector('.title')!;
    expect(title.tagName).toBe('H2');
    expect(title.textContent).toBe('Episode Highlight');
  });

  it('nests the browse list under it as an h3', async () => {
    const container = mount(
      makeMockCtx({
        scope: { type: 'site', id: 'main' },
        episodes: ['ep-1'],
        docs: makeMockDocs({ 'data/site/main/highlight': { markdown: 'Welcome' } }),
      }),
    );
    await flush();

    expect(container.querySelector('.browseTitle')!.tagName).toBe('H3');
  });
});

/**
 * plugin-sample#47, #49: an image that fails to load stands down. What it leaves behind depends on what it
 * was for — decoration goes, content leaves its alt text.
 */
describe('Highlight — failed images', () => {
  const fail = (img: Element) =>
    act(() => {
      img.dispatchEvent(new Event('error'));
    });

  it('drops a consent badge whose host does not resolve, and tells the author through ctx.log', async () => {
    const ctx = makeMockCtx({ scope: { type: 'episode', id: 'ep-1' } });
    const container = mount(ctx);
    await flush();
    const wordmark = container.querySelector('img.badge')!;

    fail(wordmark);

    expect(container.querySelector('img.badge')).toBeNull();
    expect(container.textContent).not.toContain('Highlight plugin wordmark');
    expect(ctx.logs).toContainEqual(
      expect.objectContaining({ level: 'warn', message: expect.stringContaining('static.example') }),
    );
  });

  it('explains what the consent buttons have in common', async () => {
    const container = mount(makeMockCtx({ scope: { type: 'episode', id: 'ep-1' } }));
    await flush();

    expect(container.querySelector('.extras .intro')!.textContent).toContain('three things from other companies');
  });

  it('leaves the podcaster’s alt text as text when their picture fails', async () => {
    const blobs = makeMockBlobs({ mimeTypes: ['image/png'] });
    const stored = await blobs.upload(new File([new Uint8Array(8)], 'cover.png', { type: 'image/png' }));
    const container = mount(
      makeMockCtx({
        scope: { type: 'episode', id: 'ep-1' },
        blobs,
        docs: makeMockDocs({
          'data/episode/ep-1/highlight': { markdown: 'The drop', image: { ref: stored.ref, alt: 'A waveform' } },
        }),
      }),
    );
    await flush();

    fail(container.querySelector('img.image')!);

    expect(container.querySelector('img.image')).toBeNull();
    expect(container.querySelector('.imageAlt')!.textContent).toBe('A waveform');
  });

  it('hides a failed image inside the rendered Markdown', async () => {
    const container = mount(
      makeMockCtx({
        scope: { type: 'episode', id: 'ep-1' },
        docs: makeMockDocs({
          'data/episode/ep-1/highlight': { markdown: 'Look ![a chart](https://blocked.example/chart.png)' },
        }),
      }),
    );
    await flush();
    const img = container.querySelector<HTMLImageElement>('.content img')!;
    expect(img.style.display).toBe('');

    fail(img);

    expect(img.style.display).toBe('none');
    expect(container.querySelector('.content')!.textContent).toContain('Look');
  });
});
