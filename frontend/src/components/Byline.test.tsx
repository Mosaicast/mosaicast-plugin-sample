// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 The Mosaicast Authors

import { describe, expect, it } from 'vitest';
import { createRoot } from 'react-dom/client';
import { act } from 'react';
import { makeMockCtx, makeMockUsers } from '@mosaicast/plugin-sdk/testing';
import type { MockUserDirectory } from '@mosaicast/plugin-sdk/testing';
import type { PluginContext } from '@mosaicast/plugin-sdk';
import { flush } from '../test-utils';
import { makeI18n } from '../i18n';
import { Byline, useAuthors } from './Byline';

/**
 * A probe that exercises {@link useAuthors} and {@link Byline} together.
 *
 * The hook is the interesting half — it is where the batching and the id-keyed `Map` live — and it cannot
 * be called outside a component, so the two are tested through one mount rather than apart.
 */
function Probe({ ctx, ids }: { ctx: PluginContext; ids: string[] }) {
  const authors = useAuthors(ctx, ids);
  const i18n = makeI18n(ctx.locale);
  return (
    <>
      {ids.map((id) => (
        <Byline key={id} i18n={i18n} authorId={id} authors={authors} />
      ))}
    </>
  );
}

function mount(ctx: PluginContext, ids: string[]) {
  const container = document.createElement('div');
  document.body.appendChild(container);
  act(() => {
    createRoot(container).render(<Probe ctx={ctx} ids={ids} />);
  });
  return container;
}

/** A context whose manifest declares `identity`, i.e. one where `ctx.users` is not null. */
function ctxWith(users: MockUserDirectory) {
  return makeMockCtx({ scope: { type: 'episode', id: 'ep-1' }, users });
}

describe('Byline — ctx.users (SDK 0.13.0, §8.8)', () => {
  it('renders the name and the host-served avatar behind a stored UUID', async () => {
    const users = makeMockUsers({ 'u-1': 'Ana Ruiz' });
    const container = mount(ctxWith(users), ['u-1']);
    await flush();

    expect(container.textContent).toContain('Written by Ana Ruiz');
    // The host's own path, never a provider URL: core proxies the bytes rather than redirecting, which is
    // what keeps a Discord snowflake out of the page source (§8.7). Always populated, so no fallback.
    expect(container.querySelector('img')?.getAttribute('src')).toBe('/api/users/u-1/avatar');
  });

  it('renders a placeholder when the author has been erased, and keeps the highlight', async () => {
    // The rule this component exists to demonstrate: `resolve` **omits** an unknown, erased or
    // pseudonymised id rather than returning a tombstone. Match on `UserRef.id`, never on position — a
    // shorter array read positionally would attribute one person's highlight to another.
    const users = makeMockUsers({ 'u-1': 'Ana Ruiz' });
    users.forget('u-1');
    const container = mount(ctxWith(users), ['u-1']);
    await flush();

    expect(container.textContent).toContain('former contributor');
    expect(container.querySelector('img')).toBeNull();
  });

  it('attributes each highlight to its own author when one of several is gone', async () => {
    const users = makeMockUsers({ 'u-1': 'Ana Ruiz', 'u-3': 'Cal Weir' });
    const container = mount(ctxWith(users), ['u-1', 'u-2', 'u-3']);
    await flush();

    // Three rows out of a two-element result: the map is keyed on id, so the gap lands on `u-2` and the
    // two known authors keep their own names. Index-aligned code would put Cal Weir on `u-2`'s row.
    const rows = [...container.querySelectorAll('.byline')].map((n) => n.textContent);
    expect(rows[0]).toContain('Ana Ruiz');
    expect(rows[1]).toContain('former contributor');
    expect(rows[2]).toContain('Cal Weir');
  });

  it('resolves the whole listing in one call, de-duplicated', async () => {
    const users = makeMockUsers({ 'u-1': 'Ana Ruiz', 'u-2': 'Bo Tan' });
    mount(ctxWith(users), ['u-1', 'u-2', 'u-1', 'u-2']);
    await flush();

    // One request for a page of any length — the reason `resolve` takes an array. A byline that resolved
    // per row would be one request per card.
    expect(users.resolved).toEqual(['u-1', 'u-2']);
  });

  it('renders nothing at all when the manifest declares no identity block', async () => {
    // `ctx.users` defaults to null in `makeMockCtx`, which is the undeclared-manifest case and the one
    // more plugins get wrong. Same shape as `ctx.tags`, `ctx.schema` and `ctx.blobs`.
    const ctx = makeMockCtx({ scope: { type: 'episode', id: 'ep-1' } });
    expect(ctx.users).toBeNull();
    const container = mount(ctx, ['u-1']);
    await flush();

    expect(container.querySelector('.byline')).toBeNull();
  });

  it('renders nothing for a highlight written before authorId existed', async () => {
    const users = makeMockUsers({ 'u-1': 'Ana Ruiz' });
    const container = mount(ctxWith(users), []);
    await flush();

    expect(container.querySelector('.byline')).toBeNull();
    // And costs no request: an empty listing has nothing to resolve.
    expect(users.resolved).toEqual([]);
  });
});
