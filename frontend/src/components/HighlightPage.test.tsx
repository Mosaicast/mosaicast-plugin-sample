// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 The Mosaicast Authors

import { describe, expect, it } from 'vitest';
import { createRoot } from 'react-dom/client';
import { act } from 'react';
import {
  makeMockCtx,
  makeMockDocs,
  makeMockFeeds,
  makeMockTags,
  makeMockUsers,
} from '@mosaicast/plugin-sdk/testing';
import type { MockFeedsClient } from '@mosaicast/plugin-sdk/testing';
import type { DisplaySnapshot, PluginContext } from '@mosaicast/plugin-sdk';
import { flush, localesOf, mockUser } from '../test-utils';
import { HighlightPage } from './HighlightPage';

function mount(ctx: PluginContext) {
  const container = document.createElement('div');
  document.body.appendChild(container);
  act(() => {
    createRoot(container).render(<HighlightPage ctx={ctx} />);
  });
  return container;
}

const snapshot = (over: Partial<DisplaySnapshot> = {}): DisplaySnapshot => ({
  title: 'The Kraken',
  description: 'notes',
  descriptionText: 'notes',
  ...over,
});

const INDEX = {
  'data/site/main/index': {
    entries: [
      { slug: 'the-kraken', excerpt: 'the squid shows up', momentSeconds: 724, imageRef: null,
        favourites: 9, authorId: 'u-1' },
      { slug: 'the-lighthouse', excerpt: 'the keeper speaks', momentSeconds: null, imageRef: null,
        favourites: 2, authorId: 'u-2' },
    ],
  },
};

/** A page context with the backend's listing and the host's snapshots for both episodes. */
function pageCtx(over: Parameters<typeof makeMockCtx>[0] = {}) {
  return makeMockCtx({
    scope: { type: 'site', id: 'main' },
    episodes: ['the-kraken', 'the-lighthouse'],
    docs: makeMockDocs(INDEX),
    feeds: makeMockFeeds({
      'the-kraken': snapshot({ publishedAt: '2026-03-01T00:00:00Z', duration: 'PT1H2M3S' }),
      'the-lighthouse': snapshot({ title: 'The Lighthouse', publishedAt: '2026-06-01T00:00:00Z' }),
    }),
    ...over,
  });
}

/**
 * `ctx.feeds` (SDK 0.9.0) — the frontend half of the Java `FeedAccess`.
 *
 * Before it, every card here was a slug and an excerpt, because nothing in the contract handed a frontend
 * a `DisplaySnapshot`. The alternative plugins reached for was projecting the host's episode data into
 * their own doc store on a schedule — a backend, an ingest, a `backendOwned` key and a copy that is stale
 * between runs, for fields the host already has.
 */
describe('HighlightPage — ctx.feeds', () => {
  it('draws cards from the host’s own titles rather than from slugs', async () => {
    const container = mount(pageCtx());
    await flush();

    expect(container.textContent).toContain('The Kraken');
    expect(container.textContent).toContain('The Lighthouse');
    expect(container.textContent).not.toContain('the-kraken');
  });

  it('renders the feed’s date and its ISO-8601 runtime, both locale-formatted', async () => {
    const container = mount(pageCtx());
    await flush();

    // i18n.duration takes the ISO-8601 duration string the contract actually carries — the `PT1H2M3S`
    // parse every plugin was otherwise hand-rolling beside its own `90 -> "1:30"` helper.
    expect(container.textContent).toContain('1:02:03');
    expect(container.textContent).toMatch(/2026/);
  });

  it('asks once for every slug, not once per card', async () => {
    const ctx = pageCtx();
    mount(ctx);
    await flush();

    // The N-request version is the thing this surface exists to prevent, so the batch is the assertion.
    expect([...new Set((ctx.feeds as MockFeedsClient).requested)].sort()).toEqual(['the-kraken', 'the-lighthouse']);
  });

  it('drops a card the host answered without, instead of treating it as an error', async () => {
    // A withdrawn, gated or quiet planned episode is **absent** from the answer rather than redacted —
    // telling those apart would confirm an episode this visitor was never shown. Until 2.19.0 the card fell
    // back to its slug; with quiet planned episodes (SDK 0.18.0) that slug and its excerpt are exactly what
    // must not show, in the window before the backend's next pass drops the entry from the index.
    const ctx = pageCtx({ feeds: makeMockFeeds({ 'the-kraken': snapshot() }) });
    const container = mount(ctx);
    await flush();

    expect(container.textContent).toContain('The Kraken');
    expect(container.textContent).not.toContain('the-lighthouse');
    expect(ctx.logs.filter((l) => l.level === 'error')).toEqual([]);
  });

  it('still degrades to slugs when the host could not answer at all', async () => {
    const feeds = makeMockFeeds();
    feeds.displayMany = () => Promise.reject(new Error('host down'));
    const container = mount(pageCtx({ feeds }));
    await flush();

    expect(container.textContent).toContain('the-kraken');
    expect(container.textContent).toContain('the-lighthouse');
  });

  it('places each card in its season from the snapshot (SDK 0.17.0), and leaves a bonus episode unplaced', async () => {
    const ctx = pageCtx({
      feeds: makeMockFeeds({
        'the-kraken': snapshot({ season: 2, episodeNo: 14 }),
        'the-lighthouse': snapshot({ title: 'The Lighthouse', season: 2 }),
      }),
    });
    const container = mount(ctx);
    await flush();

    const positions = [...container.querySelectorAll('.feedMeta .position')].map((p) => p.textContent);
    expect(positions.sort()).toEqual(['S2 · E14', 'Season 2']);
  });
});

/**
 * `ctx.route.query` (SDK 0.9.0).
 *
 * `navigate` always accepted a `?query` and until 0.9.0 there was no supported way to read one back: the
 * only route was `location.search`, which is exactly the "do not reach past this handle" the contract
 * forbids. Sort order is the textbook case — state a visitor should be able to share.
 */
describe('HighlightPage — ?sort=', () => {
  const names = (container: ParentNode) =>
    Array.from(container.querySelectorAll('.card .name')).map((n) => n.textContent);

  it('defaults to newest first, using the host’s publication date', async () => {
    const container = mount(pageCtx());
    await flush();

    expect(names(container)).toEqual(['The Lighthouse', 'The Kraken']);
  });

  it('reads the order back out of the URL the visitor arrived on', async () => {
    // The whole point of putting it in the query rather than in component state: this is a link somebody
    // could have been sent.
    const container = mount(pageCtx({ route: { path: '', query: new URLSearchParams('sort=favourites') } }));
    await flush();

    // Deliberately the *opposite* order to the default above — a fixture where both sorts agree would
    // pass whether the query was read or ignored.
    expect(names(container)).toEqual(['The Kraken', 'The Lighthouse']); // 9 favourites, then 2
  });

  it('falls back to the default for a value it does not recognise', async () => {
    // The query string is visitor input like any other. Narrowing it against the known set means a junk
    // value renders the default order rather than an unsorted list or an exception.
    const container = mount(pageCtx({ route: { path: '', query: new URLSearchParams('sort=drop tables') } }));
    await flush();

    expect(names(container)).toEqual(['The Lighthouse', 'The Kraken']);
  });

  it('replaces the history entry rather than stacking one per sort change', async () => {
    const ctx = pageCtx();
    const container = mount(ctx);
    await flush();

    const link = Array.from(container.querySelectorAll('.sorter a')).find(
      (a) => a.textContent === 'Most favourited',
    ) as HTMLAnchorElement;
    // A real href as well as the handler — copy-link and "open in new tab" read the attribute.
    expect(link.getAttribute('href')).toBe('/p/sample/?sort=favourites');

    act(() => {
      link.dispatchEvent(new MouseEvent('click', { bubbles: true, button: 0 }));
    });

    expect(ctx.navigations).toContainEqual({ subpath: '?sort=favourites', replace: true });
  });
});

/**
 * `matchRoute` and the not-found branch (SDK 0.9.0 / 0.9.1).
 *
 * The backend's `PageRouteProvider` makes the host answer a real 404 for exactly the paths that fall
 * through here, so the body has to agree with the status line. Until 2.12.0 this page rendered its index
 * for anything it did not recognise — a soft-404 (ARCHITECTURE §6.6).
 */
describe('HighlightPage — routing', () => {
  it('renders a not-found view for an unknown subpath, not the index', async () => {
    const container = mount(pageCtx({ route: { path: 'nonsense' } }));
    await flush();

    expect(container.textContent).toContain('No such highlight');
    expect(container.textContent).not.toContain('The Kraken');
  });

  it('does not treat a deeper path as the entrance above it', async () => {
    // `startsWith`, the hand-rolled version, rendered the moments view here.
    const container = mount(pageCtx({ route: { path: 'moments/3' } }));
    await flush();

    expect(container.textContent).toContain('No such highlight');
  });

  it('marks the current tab, matching on the pattern rather than on a stringly view name', async () => {
    const container = mount(pageCtx({ route: { path: 'moments' } }));
    await flush();

    const current = container.querySelector('.tab[aria-current="page"]');
    expect(current?.textContent).toBe('Key moments');
  });

  it('offers the podcaster-only entrance to a podcaster and nobody else', async () => {
    const anon = mount(pageCtx());
    await flush();
    expect(anon.textContent).not.toContain('To write');

    const staff = mount(pageCtx({ user: mockUser('u1', 'podcaster') }));
    await flush();
    expect(staff.textContent).toContain('To write');
  });

  it('refuses the staff view’s chrome without pretending the route does not exist', async () => {
    // Deliberately not the not-found view: `hasRoute` answers about *existence*, and this route exists —
    // this caller may not use it. The host already refuses the data; this is only about the chrome.
    const container = mount(pageCtx({ route: { path: 'unwritten' } }));
    await flush();

    expect(container.textContent).not.toContain('No such highlight');
    expect(container.textContent).toContain("for the show's own team");
  });

  it('marks a quiet planned episode in the podcaster’s to-write list (SDK 0.18.0)', async () => {
    // Only a podcaster's `ctx.episodes` holds a quiet planned episode, and this is the one list here where it
    // belongs — preparing before the announcement is the point — so it says which one it is.
    const feeds = makeMockFeeds({ 'the-kraken': snapshot(), 'the-plan': snapshot({ title: 'The Plan' }) }).withPhase(
      'the-plan',
      'planned',
    );
    const container = mount(
      pageCtx({
        route: { path: 'unwritten' },
        episodes: ['the-kraken', 'the-plan'],
        feeds,
        user: mockUser('p-1', 'podcaster'),
      }),
    );
    await flush();

    const rows = [...container.querySelectorAll('.todo li')];
    const plan = rows.find((r) => r.textContent!.includes('The Plan'))!;
    expect(plan.querySelector('.chip')!.textContent).toBe('Not announced');
    expect(rows.filter((r) => r.querySelector('.chip'))).toHaveLength(1);
  });
});

/** `ctx.tags` (SDK 0.9.0) — null unless the manifest declares a `tags` block. */
describe('HighlightPage — the detail view’s tags', () => {
  const detail = (over: Parameters<typeof makeMockCtx>[0] = {}) =>
    pageCtx({
      route: { path: 'highlight/the-kraken' },
      docs: makeMockDocs({ ...INDEX, 'data/episode/the-kraken/highlight': { markdown: 'the squid shows up' } }),
      ...over,
    });

  it('renders the vocabulary the backend mirrored onto this highlight’s subject', async () => {
    const tags = makeMockTags({ subjects: { 'highlight:the-kraken': ['Maritime'] } });
    const container = mount(detail({ tags }));
    await flush();

    // The label, not the canonical key: the host casefolds for storage and keeps `label` from first use,
    // so rendering `tag` would lower-case what a visitor reads (§6.1.1).
    expect(container.textContent).toContain('Maritime');
    const link = Array.from(container.querySelectorAll('a')).find((a) => a.textContent?.includes('Maritime'));
    // Out to the host's own filtered feed view: a plugin consumes filter axes and never defines them.
    expect(link?.getAttribute('href')).toContain('tag=maritime');
  });

  it('renders nothing at all on an install with no tag surface', async () => {
    const container = mount(detail()); // makeMockCtx leaves `tags` null, like a manifest with no block
    await flush();

    expect(container.querySelector('.tags')).toBeNull();
    expect(container.textContent).toContain('the squid shows up'); // the highlight itself is unaffected
  });
});

/**
 * The detail view in the reader's language (SDK 0.12.0).
 *
 * This is the URL that goes into `sitemap.xml`, and the backend now declares an `hreflang` alternate for
 * every language a highlight was translated into (`SamplePlugin.urls()`). Core serves the alternate by
 * resolving `?lang=de` into the shell locale this page reads — so a page that rendered the default-locale
 * `markdown` regardless, which this one did until 2.14.0, would answer that alternate with the original and
 * make the sitemap a lie. These tests are what keep the two halves saying the same thing.
 */
describe('HighlightPage — the language the page is written in', () => {
  const TRANSLATED = {
    markdown: 'the squid shows up',
    translations: { de: { markdown: 'der Tintenfisch taucht auf' } },
  };

  const detail = (over: Parameters<typeof makeMockCtx>[0] = {}) =>
    pageCtx({
      route: { path: 'highlight/the-kraken' },
      docs: makeMockDocs({ ...INDEX, 'data/episode/the-kraken/highlight': TRANSLATED }),
      ...over,
    });

  it('serves the translation to a reader whose shell is in that language', async () => {
    const container = mount(detail({ locale: localesOf(['en', 'de'], ['en', 'de'], 'de') }));
    await flush();

    expect(container.textContent).toContain('der Tintenfisch taucht auf');
    expect(container.textContent).not.toContain('the squid shows up');
    // `lang` on the content element, not only in the copy: a German paragraph announced by an English
    // synthesiser is unintelligible in a way no visible badge fixes.
    expect(container.querySelector('.content')?.getAttribute('lang')).toBe('de');
  });

  it('falls back to the site default and says so, rather than showing an empty page', async () => {
    // A language the site renders in but nobody translated this highlight into. Serving the original is the
    // kindness; the note is what stops it reading as the author's choice of language.
    const container = mount(detail({ locale: localesOf(['en', 'de', 'nl'], ['en', 'de', 'nl'], 'nl') }));
    await flush();

    expect(container.textContent).toContain('the squid shows up');
    expect(container.querySelector('.content')?.getAttribute('lang')).toBe('en');
    expect(container.querySelector('.provenance')).not.toBeNull();
  });

  it('labels a machine translation on the page a search engine sends people to', async () => {
    const container = mount(
      detail({
        locale: localesOf(['en', 'de'], ['en', 'de'], 'de'),
        docs: makeMockDocs({
          ...INDEX,
          'data/episode/the-kraken/highlight': {
            markdown: 'the squid shows up',
            translations: { de: { markdown: 'der Tintenfisch taucht auf', machineTranslated: true } },
          },
        }),
      }),
    );
    await flush();

    expect(container.textContent).toContain('der Tintenfisch taucht auf');
    // The stored flag, which the *reader* sees — distinct from the editor-local unconfirmed badge that
    // never leaves the modal. Typing over the words clears it, because they are the podcaster's then.
    expect(container.querySelector('.provenance')).not.toBeNull();
  });
});

describe('HighlightPage — who writes the highlights (ctx.users, SDK 0.13.0)', () => {
  it('resolves every author in the listing with one call and counts their highlights', async () => {
    const users = makeMockUsers({ 'u-1': 'Ana Ruiz', 'u-2': 'Bo Tan' });
    const container = mount(pageCtx({ users }));
    await flush();

    const credit = container.querySelector('.contributors')!;
    expect(credit.textContent).toContain('Ana Ruiz');
    expect(credit.textContent).toContain('Bo Tan');
    expect(credit.textContent).toContain('1 highlight');
    // One request for the whole page — the reason `resolve` takes an array rather than an id.
    expect(users.resolved).toEqual(['u-1', 'u-2']);
  });

  it('keeps the tally of an author who has since been erased, under a placeholder', async () => {
    // The property §8.8 exists to give an aggregate: the count stays true while the person becomes a
    // placeholder, and the page never had to keep a copy of anybody's name to make that work.
    const users = makeMockUsers({ 'u-1': 'Ana Ruiz', 'u-2': 'Bo Tan' });
    users.forget('u-2');
    const container = mount(pageCtx({ users }));
    await flush();

    const credit = container.querySelector('.contributors')!;
    expect(credit.textContent).toContain('Ana Ruiz');
    expect(credit.textContent).not.toContain('Bo Tan');
    expect(credit.querySelector('.gone')?.textContent).toContain('1 highlight');
  });

  it('draws no credit row when the manifest declares no identity block', async () => {
    const container = mount(pageCtx());
    await flush();

    expect(container.querySelector('.contributors')).toBeNull();
  });
});

/**
 * plugin-sample#46: an empty index names the action to whoever can take it, and describes it to whoever
 * cannot. Before 2.17.0 a podcaster was told "a podcaster can write the first one" and handed no link.
 */
describe('HighlightPage — the empty index', () => {
  const empty = () => makeMockDocs({ 'data/site/main/index': { entries: [] } });

  it('describes the page to a visitor who may not write, with no action to click', async () => {
    const container = mount(pageCtx({ docs: empty() }));
    await flush();

    expect(container.querySelector('.empty')!.textContent).toContain('A podcaster can write the first one');
    expect(container.querySelector('.empty a')).toBeNull();
  });

  it('offers a podcaster the newest episode by the feed’s date, and the list of the rest', async () => {
    // `ctx.episodes` promises no order: the Kraken is first here, and the Lighthouse is newer.
    const container = mount(pageCtx({ docs: empty(), user: mockUser('u1', 'podcaster') }));
    await flush();

    const write = container.querySelector<HTMLAnchorElement>('.empty a.listen')!;
    expect(write.textContent).toBe('Write the first highlight');
    expect(write.getAttribute('href')).toBe('/episodes/the-lighthouse');
    expect(container.querySelector('.empty a.pick')!.getAttribute('href')).toBe('/p/sample/unwritten');
    expect(container.querySelector('.empty')!.textContent).not.toContain('A podcaster can');
  });

  it('makes the same offer in German', async () => {
    const container = mount(pageCtx({ docs: empty(), user: mockUser('u1', 'admin'),
      locale: localesOf(['en', 'de'], ['en', 'de'], 'de') }));
    await flush();

    expect(container.querySelector('.empty a.listen')!.textContent).toBe('Das erste Highlight schreiben');
  });

  it('tells a podcaster on a feed with no episodes what unlocks the offer, rather than a dead link', async () => {
    const container = mount(pageCtx({ docs: empty(), user: mockUser('u1', 'podcaster'), episodes: [] }));
    await flush();

    expect(container.querySelector('.empty a')).toBeNull();
    expect(container.querySelector('.empty')!.textContent).toContain('Once the feed has an episode');
  });
});

/** plugin-sample#49: an image that fails to load stands down instead of painting a broken glyph. */
describe('HighlightPage — failed images', () => {
  it('swaps a card’s failed artwork for the tile a card without artwork gets', async () => {
    const ctx = pageCtx({
      feeds: makeMockFeeds({
        'the-kraken': snapshot({ imageUrl: 'https://cdn.feed.example/kraken.png' }),
        'the-lighthouse': snapshot({ title: 'The Lighthouse' }),
      }),
    });
    const container = mount(ctx);
    await flush();
    const img = container.querySelector<HTMLImageElement>('img.thumb')!;
    expect(img).not.toBeNull();

    act(() => {
      img.dispatchEvent(new Event('error'));
    });

    expect(container.querySelector('img.thumb')).toBeNull();
    expect(container.querySelectorAll('.thumb.blank')).toHaveLength(2);
  });
});
