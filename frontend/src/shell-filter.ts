// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 The Mosaicast Authors

import { useEffect, useRef, useState } from 'react';
import {
  type DisplaySnapshot,
  type FilterState,
  type PluginContext,
} from '@mosaicast/plugin-sdk';

/** Whether the shell's filter narrows or orders anything — `{}` (and core 0.7.5 and older) does neither. */
export function isFiltered(filter: FilterState): boolean {
  return filter.season != null || (filter.tags?.length ?? 0) > 0 || filter.sort != null;
}

/**
 * The shell's filter (ARCHITECTURE §6.1) applied to a list of episode slugs, the way the shell's own list
 * applies it.
 *
 * <p>**The host does not do this for us.** `ctx.filter` says what the visitor picked; `ctx.episodes` stays the
 * whole scope regardless. A tile listing episodes beside a filtered feed has to narrow its own list, or it
 * contradicts the page around it.
 *
 * <p>The season comes from {@link DisplaySnapshot.season} (SDK 0.17.0) — the identity layer's number, the one
 * part of a snapshot that is authoritative. Before 0.17 the only place it existed was `ctx.episodeLabels`, a
 * display string that drops the season of an unnumbered episode and is not ours to parse.
 *
 * @param slugs     the episodes to narrow, in the host's order
 * @param filter    `ctx.filter.current()`; every axis optional, absent means unfiltered
 * @param displays  snapshots for (at least) `slugs`; a slug without one has no known season or date
 * @param tagged    the slugs carrying every filtered tag, or `null` when no tag is filtered
 * @returns the slugs that match, newest first unless the filter asks for `oldest`
 */
export function applyShellFilter(
  slugs: string[],
  filter: FilterState,
  displays: Record<string, DisplaySnapshot>,
  tagged: ReadonlySet<string> | null,
): string[] {
  let kept = slugs;
  if (filter.season != null) kept = kept.filter((slug) => displays[slug]?.season === filter.season);
  if (tagged) kept = kept.filter((slug) => tagged.has(slug));
  if (filter.sort == null) return kept;
  // The shell's two orders (`?order=oldest`, and newest otherwise). An episode with no date sorts last both
  // ways rather than jumping to the front of "oldest".
  const at = (slug: string) => Date.parse(displays[slug]?.publishedAt ?? '');
  const oldest = filter.sort === 'oldest';
  return [...kept].sort((a, b) => {
    const [x, y] = [at(a), at(b)];
    if (Number.isNaN(x) || Number.isNaN(y)) return Number.isNaN(x) ? (Number.isNaN(y) ? 0 : 1) : -1;
    return oldest ? x - y : y - x;
  });
}

/** What {@link useShellFilteredEpisodes} could do with the filter. */
export type ShellFilterResult =
  /** Nothing to apply, or applied: `slugs` is what the list shows. */
  | { state: 'ready'; slugs: string[] }
  /** Still fetching what the filter needs; show nothing rather than the unfiltered list for a moment. */
  | { state: 'loading' }
  /** The snapshots or the tag listing failed: `slugs` is the **unfiltered** scope, and the UI must say so. */
  | { state: 'unfiltered'; slugs: string[] };

/**
 * `ctx.episodes` narrowed and ordered by the live `ctx.filter` (core 0.7.6).
 *
 * Costs nothing on an unfiltered view: the snapshots and the tag listing are fetched only while a filter
 * axis needs them, and refetched only when the filter or the scope changes — `ctx.filter.onChange` fires
 * on a new filter and on nothing else.
 *
 * @param enabled `false` where nothing renders the list (a hook cannot be called conditionally), which
 *                skips every request and answers the unfiltered scope
 */
export function useShellFilteredEpisodes(ctx: PluginContext, enabled = true): ShellFilterResult {
  const [filter, setFilter] = useState<FilterState>(() => ctx.filter.current());
  useEffect(() => {
    setFilter(ctx.filter.current());
    return ctx.filter.onChange(setFilter);
  }, [ctx]);

  const [result, setResult] = useState<ShellFilterResult>({ state: 'ready', slugs: ctx.episodes });
  // Value dependencies, not identities: the host reassigns ctx for reasons that have nothing to do with this
  // list (playback progress, a locale switch), and each of those must not refetch every snapshot. The latest
  // ctx is read through a ref instead.
  const ctxRef = useRef(ctx);
  ctxRef.current = ctx;
  const episodesKey = ctx.episodes.join(',');
  const filterKey = JSON.stringify([filter.season, filter.tags, filter.sort]);
  useEffect(() => {
    const ctx = ctxRef.current;
    const slugs = episodesKey ? episodesKey.split(',') : [];
    if (!enabled || !isFiltered(filter)) {
      setResult({ state: 'ready', slugs });
      return;
    }
    let live = true;
    setResult({ state: 'loading' });
    const needsDisplays = filter.season != null || filter.sort != null;
    const tags = filter.tags ?? [];
    const tagsClient = ctx.tags;
    Promise.all([
      // One call for the whole scope: `displayMany` splits past `DISPLAY_BATCH_LIMIT` itself since SDK 0.19.0
      // (it used to clamp, and this file carried a batching helper of its own to make up for it).
      needsDisplays ? ctx.feeds.displayMany(slugs) : Promise.resolve({}),
      tags.length === 0
        ? Promise.resolve(null)
        : tagsClient
          ? Promise.all(tags.map((tag) => tagsClient.episodesWith(tag))).then(
              // Every filtered tag, as the shell narrows by each one it is given.
              (lists) => new Set(lists.reduce((acc, list) => acc.filter((slug) => list.includes(slug)))),
            )
          : Promise.reject(new Error('ctx.tags is null — is tags.readsVocabulary still declared?')),
    ])
      .then(([displays, tagged]) => {
        if (live) setResult({ state: 'ready', slugs: applyShellFilter(slugs, filter, displays, tagged) });
      })
      .catch((e: unknown) => {
        if (!live) return;
        ctx.log('warn', `shell filter not applied: ${e instanceof Error ? e.message : String(e)}`);
        setResult({ state: 'unfiltered', slugs });
      });
    return () => {
      live = false;
    };
    // `filter` is covered by `filterKey`, and `ctx` is read through the ref on purpose.
  }, [enabled, episodesKey, filterKey]);
  return result;
}
