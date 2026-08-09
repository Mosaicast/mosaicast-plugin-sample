// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 The Mosaicast Authors

import { describe, expect, it } from 'vitest';
import { act } from 'react';
import { makeMockCtx } from '@mosaicast/plugin-sdk/testing';
import { PLATFORM_API_VERSION } from '@mosaicast/plugin-sdk';
import type { PluginContext, PluginDataDeclaration } from '@mosaicast/plugin-sdk';
import { flush } from './test-utils';
import { MODAL_PORTAL_ATTR } from './components/HighlightModal';
import { SETTINGS_PATH } from './components/AdminSettings';
import { favouriteDocPath, highlightDocPath } from './highlight-doc';
import manifest from '../../plugin.json';
import './sample-element';

type MountedElement = HTMLElement & { ctx: PluginContext };

/**
 * The manifest's `data` block, typed. `PluginDataDeclaration` is documentation only — the host owns and
 * validates the manifest — but since 0.6.0 the block carries a security control, and a typo in
 * `backendOwned` protects nothing while looking exactly like protection.
 *
 * A cast, not an annotation: `resolveJsonModule` widens every string in the imported manifest to `string`,
 * so the compiler cannot check the literal unions here. It types the *reads* below; the assertions in this
 * file are what actually check the values.
 */
const data = manifest.data as PluginDataDeclaration;

/** The last path segment of a doc-store path — the doc *key*, which is what `backendOwned` matches on. */
const keyOf = (path: string): string => path.slice(path.lastIndexOf('/') + 1);

describe('plugin.json ↔ bundle contract', () => {
  it('defines a custom element for every tag the manifest declares', () => {
    // Drift here is the failure mode that made this plugin's deep links a hard 404 once: the manifest and
    // the bundle are validated by different systems (core at load, Vite at build), so nothing else catches
    // an element that is declared but never defined — the slot just silently renders nothing.
    for (const tag of manifest.frontend.elements) {
      expect(customElements.get(tag), `no custom element defined for "${tag}"`).toBeDefined();
    }
  });

  it('declares a data access floor that still admits its anonymous slots (SDK 0.5.0)', () => {
    // The 0.5.0 trap, in one assertion. Core used to derive the read floor from the minimum `visibleTo`
    // across slots; now the manifest declares it, and an ABSENT block defaults readableBy to the *write*
    // floor — so a plugin with a public slot and no block starts answering 403 to reads that worked
    // yesterday. `visibleTo` governs rendering only, and never governed data.
    expect(manifest.data, 'plugin.json declares no "data" block').toBeDefined();
    if (manifest.slots.some((slot) => slot.visibleTo === 'anonymous')) {
      expect(manifest.data.readableBy, 'anonymous slots but non-anonymous readableBy').toBe('anonymous');
    }
    // An unauthenticated write has no owner to attribute it to; core refuses this outright at load.
    expect(manifest.data.writableBy).not.toBe('anonymous');
  });

  it('declares the platformApi version the bundled SDK was built at', () => {
    // Core compares `major.minor` exactly and *rejects* the plugin at load on a mismatch — it does not warn
    // and carry on. Bumping the dependency without the manifest (or the reverse) therefore ships a plugin
    // that never loads, and the only symptom is a line in the admin log viewer.
    expect(manifest.platformApi).toBe(PLATFORM_API_VERSION);
  });

  it('declares the keys the backend authors, and only those (SDK 0.6.0)', () => {
    // A shared-scope document has no owner: authorization is per plugin, not per document, so any caller
    // above `writableBy` can overwrite a value the backend computed. `stats` and `favourites` are written by
    // SamplePlugin's scheduled pass and by nothing else, so they are declared and a client PUT/DELETE to
    // them is a 403.
    expect(data.backendOwned).toEqual(['stats', 'favourites']);

    // The mirror image, and the easier mistake: declaring a key the *frontend* writes locks this plugin out
    // of its own store. Each of these is written over HTTP by a component in this bundle.
    const clientWritten = [
      keyOf(highlightDocPath('episode', 'ep-1')),
      keyOf(SETTINGS_PATH),
      keyOf(favouriteDocPath('ep-1')),
    ];
    const covers = (pattern: string, key: string): boolean =>
      pattern.endsWith('*') ? key.startsWith(pattern.slice(0, -1)) : pattern === key;
    for (const key of clientWritten) {
      for (const pattern of data.backendOwned ?? []) {
        expect(covers(pattern, key), `backendOwned "${pattern}" blocks client-written "${key}"`).toBe(false);
      }
    }
  });

  it('declares every element it defines a slot for', () => {
    const declared = new Set(manifest.frontend.elements);
    for (const slot of manifest.slots) {
      expect(declared.has(slot.element), `slot targets undeclared element "${slot.element}"`).toBe(true);
    }
  });
});

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
