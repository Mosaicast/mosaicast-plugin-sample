// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 The Mosaicast Authors

import { describe, expect, it } from 'vitest';
import { createRoot } from 'react-dom/client';
import { act } from 'react';
import { makeMockCtx, makeMockFeeds, makeMockTags } from '@mosaicast/plugin-sdk/testing';
import { DISPLAY_BATCH_LIMIT, type DisplaySnapshot, type FilterState, type PluginContext } from '@mosaicast/plugin-sdk';
import { flush } from './test-utils';
import { applyShellFilter, useShellFilteredEpisodes, type ShellFilterResult } from './shell-filter';

const snap = (season: number | undefined, publishedAt: string): DisplaySnapshot =>
  ({ title: '', description: '', season, publishedAt }) as DisplaySnapshot;

/** A `ctx.filter` the test can move, standing in for the shell's URL filters (core 0.7.6). */
function liveFilter(initial: FilterState) {
  let state = initial;
  const listeners = new Set<(f: FilterState) => void>();
  return {
    current: () => state,
    onChange(cb: (f: FilterState) => void) {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    set(next: FilterState) {
      state = next;
      act(() => listeners.forEach((cb) => cb(next)));
    },
  };
}

function probe(ctx: PluginContext, enabled = true) {
  const seen: { last?: ShellFilterResult } = {};
  function Probe() {
    seen.last = useShellFilteredEpisodes(ctx, enabled);
    return null;
  }
  const root = createRoot(document.createElement('div'));
  act(() => root.render(<Probe />));
  return seen;
}

describe('applyShellFilter', () => {
  const displays = {
    a: snap(1, '2026-01-01T00:00:00Z'),
    b: snap(2, '2026-03-01T00:00:00Z'),
    c: snap(1, '2026-02-01T00:00:00Z'),
    bonus: snap(undefined, '2026-04-01T00:00:00Z'),
  };

  it('is the identity for an empty filter — what core 0.7.5 and older always send', () => {
    expect(applyShellFilter(['b', 'a', 'gated'], {}, {}, null)).toEqual(['b', 'a', 'gated']);
  });

  it('keeps one season by the snapshot number, dropping a bonus episode with none and one the host withheld', () => {
    expect(applyShellFilter(['a', 'b', 'c', 'bonus', 'gated'], { season: 1 }, displays, null)).toEqual(['a', 'c']);
  });

  it('orders newest first, or oldest first for ?order=oldest', () => {
    expect(applyShellFilter(['a', 'b', 'c'], { sort: 'newest' }, displays, null)).toEqual(['b', 'c', 'a']);
    expect(applyShellFilter(['a', 'b', 'c'], { sort: 'oldest' }, displays, null)).toEqual(['a', 'c', 'b']);
  });

  it('puts an undated episode last in both orders', () => {
    expect(applyShellFilter(['gated', 'a', 'b'], { sort: 'oldest' }, displays, null)).toEqual(['a', 'b', 'gated']);
    expect(applyShellFilter(['gated', 'a', 'b'], { sort: 'newest' }, displays, null)).toEqual(['b', 'a', 'gated']);
  });

  it('intersects with the tagged set', () => {
    expect(applyShellFilter(['a', 'b', 'c'], { tags: ['x'] }, displays, new Set(['c', 'b']))).toEqual(['b', 'c']);
  });
});

describe('useShellFilteredEpisodes', () => {
  it('asks the host for nothing while the view is unfiltered', async () => {
    const feeds = makeMockFeeds();
    const seen = probe(makeMockCtx({ episodes: ['a', 'b'], feeds }));
    await flush();

    expect(seen.last).toEqual({ state: 'ready', slugs: ['a', 'b'] });
    expect(feeds.requested).toEqual([]);
  });

  it('follows a filter the visitor changes, without a new ctx', async () => {
    const feeds = makeMockFeeds({
      a: { title: 'A', description: '', season: 1 },
      b: { title: 'B', description: '', season: 2 },
    });
    const filter = liveFilter({});
    const seen = probe(makeMockCtx({ episodes: ['a', 'b'], feeds, filter }));
    await flush();
    expect(seen.last).toEqual({ state: 'ready', slugs: ['a', 'b'] });

    filter.set({ season: 2 });
    await flush();
    expect(seen.last).toEqual({ state: 'ready', slugs: ['b'] });
  });

  it('asks for snapshots in batches, so a show past the batch limit keeps its tail', async () => {
    const slugs = Array.from({ length: DISPLAY_BATCH_LIMIT + 5 }, (_, i) => `ep-${i}`);
    const feeds = makeMockFeeds();
    const last = slugs[slugs.length - 1];
    feeds.withDisplay(last, { title: 'Last', description: '', season: 3 });
    const seen = probe(makeMockCtx({ episodes: slugs, feeds, filter: liveFilter({ season: 3 }) }));
    await flush();

    expect(seen.last).toEqual({ state: 'ready', slugs: [last] });
    expect(feeds.requested).toHaveLength(slugs.length);
  });

  it('narrows by tag through ctx.tags', async () => {
    const tags = makeMockTags({ writesEpisodes: true, episodes: { b: ['maritime'] } });
    const seen = probe(makeMockCtx({ episodes: ['a', 'b'], tags, filter: liveFilter({ tags: ['maritime'] }) }));
    await flush();

    expect(seen.last).toEqual({ state: 'ready', slugs: ['b'] });
  });

  it('says so when it cannot apply the filter, instead of passing the whole scope off as filtered', async () => {
    // ctx.tags is null by default — a manifest that lost tags.readsVocabulary.
    const ctx = makeMockCtx({ episodes: ['a', 'b'], filter: liveFilter({ tags: ['maritime'] }) });
    const seen = probe(ctx);
    await flush();

    expect(seen.last).toEqual({ state: 'unfiltered', slugs: ['a', 'b'] });
    expect(ctx.logs.some((l) => l.level === 'warn' && l.message.includes('shell filter not applied'))).toBe(true);
  });

  it('stays out of it where nothing renders the list', async () => {
    const feeds = makeMockFeeds();
    const seen = probe(makeMockCtx({ episodes: ['a'], feeds, filter: liveFilter({ season: 1 }) }), false);
    await flush();

    expect(seen.last).toEqual({ state: 'ready', slugs: ['a'] });
    expect(feeds.requested).toEqual([]);
  });
});
