// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 The Mosaicast Authors

import { describe, expect, it } from 'vitest';
import { act } from 'react';
import { makeMockCtx } from '@mosaicast/plugin-sdk/testing';
import type { PluginContext } from '@mosaicast/plugin-sdk';
import { flush } from './test-utils';
import { MODAL_PORTAL_ATTR } from './components/HighlightModal';
import './sample-element';

type MountedElement = HTMLElement & { ctx: PluginContext };

describe('sample-highlight custom element', () => {
  it('registers once and mounts into an open shadow root, isolated from the light DOM', async () => {
    // A page-level stylesheet that would collide with the component's own `.title` class if it leaked.
    const collidingStyle = document.createElement('style');
    collidingStyle.textContent = '.title { color: red; }';
    document.head.appendChild(collidingStyle);

    const el = document.createElement('sample-highlight') as MountedElement;
    document.body.appendChild(el);
    act(() => {
      el.ctx = makeMockCtx({ scope: { type: 'episode', id: 'ep-1' } });
    });
    await flush();

    // The component's `.title` node exists only inside the shadow tree — unreachable from the document,
    // proving real structural encapsulation (not just a visual claim).
    expect(document.querySelector('.title')).toBeNull();
    expect(el.shadowRoot).not.toBeNull();
    expect(el.shadowRoot!.mode).toBe('open');
    expect(el.shadowRoot!.querySelector('.title')).not.toBeNull();
    expect(el.shadowRoot!.querySelector('.title')!.textContent).toBe('Episode Highlight');

    document.head.removeChild(collidingStyle);
  });

  it('mounts at all three scope types with the scope-appropriate title', async () => {
    const cases: Array<[PluginContext['scope'], string]> = [
      [{ type: 'episode', id: 'ep-1' }, 'Episode Highlight'],
      [{ type: 'feed', id: 'news' }, 'Podcast Highlight'],
      [{ type: 'site', id: 'main' }, 'Site Highlight'],
    ];

    for (const [scope, expectedTitle] of cases) {
      const el = document.createElement('sample-highlight') as MountedElement;
      document.body.appendChild(el);
      act(() => {
        el.ctx = makeMockCtx({ scope });
      });
      await flush();
      expect(el.shadowRoot!.querySelector('.title')!.textContent).toBe(expectedTitle);
    }
  });

  it('re-renders when ctx is reassigned', async () => {
    const el = document.createElement('sample-highlight') as MountedElement;
    document.body.appendChild(el);

    act(() => {
      el.ctx = makeMockCtx({
        scope: { type: 'episode', id: 'ep-1' },
        apiResponses: { 'get data/episode/ep-1/highlight': { markdown: 'First note' } },
      });
    });
    await flush();
    expect(el.shadowRoot!.textContent).toContain('First note');

    act(() => {
      el.ctx = makeMockCtx({
        scope: { type: 'episode', id: 'ep-2' },
        apiResponses: { 'get data/episode/ep-2/highlight': { markdown: 'Second note' } },
      });
    });
    await flush();
    expect(el.shadowRoot!.textContent).toContain('Second note');
    expect(el.shadowRoot!.textContent).not.toContain('First note');
  });

  it('portals the edit modal to its own shadow root on document.body, not the light DOM or the element\'s own shadow root', async () => {
    // This is the fix for the real bug it guards against: a plain `position: fixed` modal nested inside
    // this element's own shadow tree can get trapped below unrelated siblings (e.g. episode cover art
    // using a transform for its hover effect) because a transformed ancestor becomes the fixed-position
    // containing block instead of the viewport. Porting to a fresh host on document.body sidesteps any
    // such ancestor entirely.
    const el = document.createElement('sample-highlight') as MountedElement;
    document.body.appendChild(el);
    act(() => {
      el.ctx = makeMockCtx({
        scope: { type: 'site', id: 'main' },
        user: { id: 'u1', role: 'podcaster' },
      });
    });
    await flush();

    const editButton = el.shadowRoot!.querySelector('button') as HTMLButtonElement;
    act(() => {
      editButton.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    await flush();

    // Not nested inside this element's own shadow tree...
    expect(el.shadowRoot!.querySelector('textarea')).toBeNull();
    // ...not sitting unencapsulated in the light DOM either...
    expect(document.querySelector('textarea')).toBeNull();
    // ...but inside its own dedicated shadow root, attached directly to document.body.
    const portalHost = document.body.querySelector(`[${MODAL_PORTAL_ATTR}]`);
    expect(portalHost).not.toBeNull();
    expect(portalHost!.shadowRoot).not.toBeNull();
    expect(portalHost!.shadowRoot!.querySelector('textarea')).not.toBeNull();
    expect(portalHost!.shadowRoot!.querySelector('[role="dialog"]')).not.toBeNull();

    // Closing the modal tears the portal host back down.
    const cancelButton = Array.from(portalHost!.shadowRoot!.querySelectorAll('button')).find(
      (b) => b.textContent === 'Cancel',
    )!;
    act(() => {
      cancelButton.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    await flush();
    expect(document.body.querySelector(`[${MODAL_PORTAL_ATTR}]`)).toBeNull();
  });
});
