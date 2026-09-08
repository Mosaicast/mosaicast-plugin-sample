// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 The Mosaicast Authors

import { useEffect, useMemo, useState } from 'react';
import type { MouseEvent } from 'react';
import {
  DISPLAY_BATCH_LIMIT,
  matchRoute,
  resolveArtwork,
  type DisplaySnapshot,
  type PluginContext,
  type PluginI18n,
  type PluginRoute,
} from '@mosaicast/plugin-sdk';
import { marked } from 'marked';
import DOMPurify from 'dompurify';
import { makeI18n, nativeNameOf } from '../i18n';
import { ICON_CSS, Icon } from '../icons';
import { DETAIL_PREFIX, PAGE_ENTRIES, PAGE_PATTERNS } from '../page-entries';
import { FONT_STACKS, type SiteSettings } from './AdminSettings';
import { HighlightTags } from './HighlightTags';
import { useAuthors } from './Byline';
import {
  HIGHLIGHT_KEY,
  defaultLocaleOf,
  episodeTarget,
  resolveHighlightText,
  type HighlightDoc,
} from '../highlight-doc';

/** One highlighted episode as the backend's `index` doc lists it — mirrors `SamplePlugin.IndexEntry`. */
interface IndexEntry {
  slug: string;
  excerpt: string;
  momentSeconds: number | null;
  imageRef: string | null;
  favourites: number;
  /** The author's UUID (SDK 0.13.0) — `null` for a highlight written before 2.15.0. Never a name. */
  authorId: string | null;
}

/** The backend-written listing at `data/site/main/index` — see `SamplePlugin.HighlightIndex` for why. */
interface HighlightIndex {
  entries: IndexEntry[];
}

/** How this page's list views may be ordered. Read from, and written to, `?sort=` (SDK 0.9.0). */
const SORTS = ['newest', 'favourites'] as const;
type Sort = (typeof SORTS)[number];

/** Renders markdown to sanitized HTML — never trust a podcaster-authored string verbatim (§12.6). */
function renderMarkdown(markdown: string): string {
  return DOMPurify.sanitize(marked.parse(markdown, { async: false }) as string);
}

/**
 * A link that stays inside this plugin's own subtree: a real `href` **and** an `onClick` that hands a
 * plain left-click to `ctx.route.navigate` instead (SDK 0.7.0).
 *
 * The `href` is what makes it a link — middle-click, "open in new tab", copy-link and crawlers all read
 * the attribute, not the handler. `navigate` is what makes the plain click SPA navigation rather than a
 * full reload of the shell and this bundle. The modifier guard keeps both honest: a ctrl/cmd/shift/alt
 * click, or any non-primary button, must fall through to the browser untouched.
 */
function internalLink(route: PluginRoute, subpath: string) {
  return {
    href: `/p/sample/${subpath}`,
    onClick: (e: MouseEvent<HTMLAnchorElement>) => {
      if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
      e.preventDefault();
      route.navigate(subpath);
    },
  };
}

/**
 * Episode display snapshots for a list of slugs, in **one** request (SDK 0.9.0, `ctx.feeds`).
 *
 * ## What this replaced
 *
 * Until 2.12.0 every card on this page was drawn from a slug and `ctx.episodeLabels` — a slug-shaped
 * heading with no artwork, no date and no runtime — because the frontend contract had no way to read a
 * `DisplaySnapshot`. `DisplaySnapshot` and {@link resolveArtwork} had shipped since 0.1.0 with nothing that
 * hands a frontend one; the alternative every plugin reached for was to project the host's own episode data
 * into its doc store on a schedule, which costs a backend, a scheduled ingest, a `backendOwned` key and a
 * copy that is stale between runs — for fields the host already has.
 *
 * ## Two properties worth knowing before using it
 *
 * - **The host filters, the plugin consumes.** The answer contains only what *this* visitor may see, so a
 *   `WITHDRAWN` or tier-gated episode is **absent rather than redacted**. A missing key is therefore normal
 *   and must never be treated as an error — every caller below skips the row instead.
 * - **Read it live; never cache it past a render.** The snapshot is overwritten on every feed refetch, and
 *   that is the feature: a podcaster's title edit propagates. Storing a copy re-creates the staleness this
 *   surface exists to remove.
 *
 * Beyond {@link DISPLAY_BATCH_LIMIT} slugs the host clamps rather than failing, so the extras are simply
 * absent — which is again indistinguishable from "filtered out", and again handled by skipping.
 */
function useEpisodeDisplays(ctx: PluginContext, slugs: string[]): Record<string, DisplaySnapshot> {
  const [displays, setDisplays] = useState<Record<string, DisplaySnapshot>>({});
  // The join is the dependency: a new array with the same slugs must not re-fetch on every render.
  const key = slugs.join(',');
  useEffect(() => {
    const wanted = key ? key.split(',') : [];
    if (wanted.length === 0) return;
    ctx.feeds
      .displayMany(wanted.slice(0, DISPLAY_BATCH_LIMIT))
      .then(setDisplays)
      .catch(() => {
        // Cards degrade to their slugs rather than disappearing: the highlight is this plugin's content and
        // is worth showing even when the host's presentation layer is briefly unavailable.
        ctx.log('warn', 'episode display snapshots unavailable; falling back to slugs');
      });
  }, [ctx, key]);
  return displays;
}

/**
 * The plugin's **page** element, mounted at the `site`/`page` placement and owning `/p/sample/*`.
 *
 * <p>This is a separate Web Component from {@link Highlight}, and the split is the lesson. A slot tile is
 * a guest in someone else's layout: it is narrow, it sits below an episode's show notes, and it should say
 * one thing. A page is the whole canvas — the plugin decides the layout, and nothing else is competing for
 * the space.
 *
 * <p><strong>Multiple entrances (core 0.6.15).</strong> `plugin.json` declares four `nav[]` entries and the
 * host offers them in its navigation menu; the tab bar below offers the same four from inside the page.
 * Both come from {@link PAGE_ENTRIES}, and a test pins the manifest to it. One of the four is
 * `visibleTo: "podcaster"` — the host filters it server-side, so an anonymous visitor is never sent it,
 * and this component filters again from `ctx.user` because the tab bar is drawn client-side.
 *
 * <p><strong>One request, four views.</strong> Every view reads the same backend-written `index` doc
 * (`SamplePlugin.HighlightIndex`), plus one batched `ctx.feeds.displayMany` for the presentation half. A
 * browser cannot build that listing itself — the doc surface is addressed by scope and key, so "every
 * episode's highlight" would be one request per episode.
 *
 * <p><strong>An unknown subpath is a 404 now (SDK 0.9.1).</strong> {@link matchRoute} returning `null`
 * renders {@link NotFoundView}, and the backend's `PageRouteProvider` makes the host answer a real 404 for
 * the same paths (ARCHITECTURE §6.6). Before that, this page quietly rendered its index for anything it did
 * not recognise, under a `200 OK` — a soft-404 that put this plugin's typos in a crawler's index.
 */
export function HighlightPage({ ctx }: { ctx: PluginContext }) {
  // `locale` is not only a re-render trigger since 0.12.0: DetailView reads it to pick which translation of
  // a highlight to show, which is what makes this page's `?lang=de` URL answer in German — and therefore
  // what makes the backend's `hreflang` alternate for it true rather than a claim about a page that ignores
  // the parameter. See SamplePlugin.urls().
  const [locale, setLocale] = useState(ctx.locale.current());
  const i18n = useMemo(() => makeI18n(ctx.locale), [ctx]);
  useEffect(() => ctx.locale.onChange(setLocale), [ctx]);
  useEffect(() => () => i18n.dispose(), [i18n]);

  // The host updates the subpath in place when a menu entry or a tab is followed, without remounting us.
  const [, forceRerender] = useState(0);
  useEffect(() => ctx.route.onChange(() => forceRerender((n) => n + 1)), [ctx]);

  // First match wins, and the specific pattern is listed before the general one — see PAGE_PATTERNS.
  const match = matchRoute(ctx.route.path, PAGE_PATTERNS);

  // ctx.route.query (SDK 0.9.0). `navigate` always accepted a `?query` and there was no supported way to
  // read one back: the only route was `location.search`, which is exactly the "do not reach past this
  // handle" the contract forbids. Sort order is the textbook case — it is state a visitor should be able
  // to *share*, which means it belongs in the URL rather than in a useState nobody else can see.
  const sort = readSort(ctx.route.query.get('sort'));

  const [index, setIndex] = useState<HighlightIndex | null>(null);
  useEffect(() => {
    ctx.docs
      .get<HighlightIndex>('site', 'index')
      .then(setIndex)
      .catch(() => {
        setIndex(null);
        ctx.log('warn', 'highlight index unavailable');
      });
  }, [ctx]);

  const [settings, setSettings] = useState<SiteSettings>({});
  useEffect(() => {
    ctx.docs
      .get<SiteSettings>('site', 'settings')
      .then((loaded) => setSettings(loaded ?? {}))
      .catch(() => ctx.log('warn', 'site highlight settings unavailable; rendering defaults'));
  }, [ctx]);

  const canSeeDrafts = ctx.user?.role === 'podcaster' || ctx.user?.role === 'admin';
  const entries = index?.entries ?? [];

  // `ctx.episodes` is the host's own access-filtered list, so the difference is only ever episodes this
  // visitor may already see — the gate on the unwritten view is about relevance, not secrecy.
  const written = new Set(entries.map((e) => e.slug));
  const unwritten = ctx.episodes.filter((s) => !written.has(s));

  // One batched call covering every slug any view might draw. Deduplicated because an episode can appear
  // in both lists across a re-render, and `displayMany` charges by slug.
  const displays = useEpisodeDisplays(ctx, [...new Set([...entries.map((e) => e.slug), ...ctx.episodes])]);
  const title = (slug: string) => displays[slug]?.title ?? ctx.episodeLabels?.[slug] ?? slug;

  const sorted = sortEntries(entries, sort, displays);
  const moments = entries
    .filter((e) => e.momentSeconds != null)
    .sort((a, b) => a.momentSeconds! - b.momentSeconds!);
  const pictures = sortEntries(entries.filter((e) => e.imageRef), sort, displays);

  const tabs = PAGE_ENTRIES.filter((entry) => entry.visibleTo !== 'podcaster' || canSeeDrafts);
  const view: ViewProps = { ctx, i18n, entries: sorted, title, displays };

  return (
    <div className="page" style={{ fontFamily: FONT_STACKS[settings.fontFamily ?? 'system'] }}>
      <style>{`
        ${ICON_CSS}
        /* The host's page region is full-bleed — it hands a plugin the whole width and lets it decide.
           A measure and a gutter, then, rather than text running into the viewport edge. margin-inline
           auto only ever narrows, so this stays correct if the host adds a container of its own later. */
        .page {
          color: var(--mc-text);
          container-type: inline-size;
          max-width: 72rem;
          margin-inline: auto;
          padding: 1.25rem 1rem 2rem;
        }

        /* The hero is the one place this plugin paints with the accent rather than beside it. Two stops of
           the host's own accent pair, so it restyles with the site instead of pinning a brand of its own. */
        .hero {
          position: relative;
          overflow: hidden;
          border: 1px solid var(--mc-border);
          border-radius: 1rem;
          padding: 1.75rem 1.5rem;
          margin-bottom: 1rem;
          background:
            radial-gradient(120% 140% at 12% 0%, color-mix(in oklab, var(--mc-accent) 26%, transparent) 0%, transparent 60%),
            radial-gradient(120% 140% at 92% 10%, color-mix(in oklab, var(--mc-accent-2, var(--mc-accent)) 22%, transparent) 0%, transparent 55%),
            var(--mc-surface);
        }
        .hero h1 { margin: 0; font-size: 1.6rem; line-height: 1.15; letter-spacing: -0.02em; }
        .hero p { margin: 0.4rem 0 0; color: var(--mc-text-muted); font-size: 0.9rem; max-width: 48ch; }
        .heroStats { display: flex; flex-wrap: wrap; gap: 0.4rem; margin-top: 0.9rem; }
        .chip {
          display: inline-flex; align-items: center; gap: 0.3rem;
          padding: 0.2rem 0.55rem; border-radius: 999px; font-size: 0.75rem;
          border: 1px solid var(--mc-border);
          background: color-mix(in oklab, var(--mc-bg) 70%, transparent);
          color: var(--mc-text-muted);
        }
        .chip strong { color: var(--mc-text); font-weight: 600; }

        /* Tabs: the in-page half of the entry points the host also lists in its menu. */
        .tabs { display: flex; flex-wrap: wrap; gap: 0.3rem; margin-bottom: 1rem; }
        .tab {
          display: inline-flex; align-items: center; gap: 0.4rem;
          padding: 0.4rem 0.75rem; border-radius: 0.6rem; font-size: 0.85rem;
          border: 1px solid var(--mc-border); color: var(--mc-text);
          text-decoration: none; background: var(--mc-surface);
        }
        .tab:hover { border-color: var(--mc-accent); }
        .tab[aria-current="page"] {
          background: var(--mc-accent); color: var(--mc-accent-contrast); border-color: var(--mc-accent);
        }
        /* The role-gated entrance reads as different before it is clicked — it is not part of the public
           site, and a podcaster should be able to see that at a glance rather than by remembering. */
        .tab.staff { border-style: dashed; }

        /* The sort control sits with the list it orders, not with the tabs: the tabs choose *what* is
           shown and survive a reload as a path; this chooses the order and survives one as a query. */
        .sorter { display: flex; flex-wrap: wrap; align-items: center; gap: 0.3rem; margin-bottom: 0.75rem;
          font-size: 0.8rem; color: var(--mc-text-muted); }
        .sorter .sortLabel { display: inline-flex; align-items: center; gap: 0.25rem; }
        .sorter a { padding: 0.2rem 0.6rem; border-radius: 999px; border: 1px solid var(--mc-border);
          color: var(--mc-text); text-decoration: none; }
        .sorter a[aria-current="true"] { background: var(--mc-accent); color: var(--mc-accent-contrast);
          border-color: var(--mc-accent); }

        /* auto-fit, not auto-fill: with four cards on a wide screen auto-fill keeps an empty fifth track
           and leaves the row looking truncated, where auto-fit collapses it and the cards share the width.
           The 22rem ceiling is what 2.12.0 had to add, and it is a good illustration of a change in one
           place breaking a layout in another: until ctx.feeds landed, most cards had no picture and drew
           the blank placeholder, so a lone card stretching across a 72rem measure was barely noticeable.
           Now every card carries the host's own artwork at 16/9 — and with 1fr as the ceiling, a site with
           one highlight rendered a single thumbnail a metre wide. Cap the track and start the row.
           (No backticks in this comment, deliberately: this whole block is a template literal, and one
           would end the string and fail the build with a parse error pointing at the wrong place.) */
        .grid { display: grid; gap: 0.75rem; justify-content: start;
                grid-template-columns: repeat(auto-fit, minmax(15rem, 22rem)); }
        .card {
          display: flex; flex-direction: column; overflow: hidden;
          border: 1px solid var(--mc-border); border-radius: 0.75rem;
          background: var(--mc-surface); text-decoration: none; color: inherit;
          transition: transform 120ms ease, border-color 120ms ease;
        }
        .card:hover { transform: translateY(-2px); border-color: var(--mc-accent); }
        .card .thumb { display: block; width: 100%; aspect-ratio: 16 / 9; object-fit: cover; background: var(--mc-bg); }
        /* Every card gets a banner, image or not. Without this the titles of the ones carrying a picture
           sit a thumbnail's height below the ones that don't, and a row of four reads as broken rather
           than as varied. The placeholder is the host's accent at low strength, so it is clearly a blank
           and not a failed image. */
        .card .thumb.blank {
          display: flex; align-items: center; justify-content: center;
          color: color-mix(in oklab, var(--mc-accent) 55%, var(--mc-text-muted));
          background:
            linear-gradient(135deg,
              color-mix(in oklab, var(--mc-accent) 14%, transparent) 0%,
              color-mix(in oklab, var(--mc-accent-2, var(--mc-accent)) 10%, transparent) 100%),
            var(--mc-bg);
        }
        .card .thumb.blank .mc-icon { width: 1.6em; height: 1.6em; opacity: 0.7; }
        .card .body { padding: 0.7rem 0.8rem; display: flex; flex-direction: column; gap: 0.35rem; }
        .card .name { font-weight: 600; font-size: 0.9rem; line-height: 1.25; }
        .card .excerpt { margin: 0; font-size: 0.8rem; color: var(--mc-text-muted); line-height: 1.4; }
        .card .meta { display: flex; flex-wrap: wrap; gap: 0.35rem; margin-top: 0.15rem; }
        /* Feed-derived facts read quieter than the plugin's own: the date and the runtime come from the
           host and are not this plugin's claim to make (§4.2). */
        .card .feedMeta { font-size: 0.72rem; color: var(--mc-text-muted); display: flex; flex-wrap: wrap;
          gap: 0.3rem; }
        .card .feedMeta .dot { opacity: 0.5; }

        /* Moments read as a timeline, because their order is the point — a chronology of the show's best
           bits, not another grid of cards. */
        .timeline { list-style: none; margin: 0; padding: 0; }
        .timeline li { display: flex; gap: 0.75rem; padding: 0.55rem 0; border-top: 1px solid var(--mc-border); }
        .timeline li:first-child { border-top: none; }
        .stamp {
          flex: none; min-width: 4.2rem;
          display: inline-flex; align-items: center; gap: 0.3rem;
          font-variant-numeric: tabular-nums; font-size: 0.85rem; font-weight: 600; color: var(--mc-accent);
          text-decoration: none;
        }
        .timeline .what { min-width: 0; }
        /* The host styles a bare <a> for prose — underlined and in the link colour. That is right inside
           show notes and wrong in a list where the title *is* the row, so these are restyled to read as
           headings that happen to be clickable, matching the cards on the other views. */
        .timeline .name { font-size: 0.88rem; font-weight: 600; color: var(--mc-text); text-decoration: none; }
        .timeline .name:hover { color: var(--mc-accent); text-decoration: underline; }
        .timeline .excerpt { margin: 0.1rem 0 0; font-size: 0.8rem; color: var(--mc-text-muted); }

        .todo { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 0.4rem; }
        .todo li {
          display: flex; align-items: center; justify-content: space-between; gap: 0.75rem;
          border: 1px dashed var(--mc-border); border-radius: 0.6rem; padding: 0.5rem 0.7rem; font-size: 0.88rem;
        }
        .todo a { color: var(--mc-accent); display: inline-flex; align-items: center; gap: 0.3rem; font-size: 0.8rem; }

        .detail { border: 1px solid var(--mc-border); border-radius: 0.75rem; background: var(--mc-surface); padding: 1rem 1.1rem; }
        .detail .image { display: block; max-width: 100%; height: auto; border-radius: 0.5rem; margin-bottom: 0.75rem; }
        .detail h2 { margin: 0 0 0.5rem; font-size: 1.15rem; }
        .detail .published { margin: 0 0 0.5rem; font-size: 0.8rem; color: var(--mc-text-muted); }
        .detail .content :where(p) { margin: 0 0 0.5rem; }
        .detail .content :where(p:last-child) { margin-bottom: 0; }
        .listen {
          display: inline-flex; align-items: center; gap: 0.35rem; margin-top: 0.75rem;
          background: var(--mc-accent); color: var(--mc-accent-contrast);
          border-radius: 0.5rem; padding: 0.4rem 0.8rem; text-decoration: none; font-size: 0.85rem;
        }
        .back { display: inline-flex; align-items: center; gap: 0.3rem; margin-bottom: 0.6rem; color: var(--mc-accent); font-size: 0.85rem; }
        .empty { margin: 0; padding: 1.5rem; text-align: center; color: var(--mc-text-muted); font-style: italic;
                 border: 1px dashed var(--mc-border); border-radius: 0.75rem; }
        .notFound { text-align: center; padding: 2.5rem 1rem; }
        .notFound h1 { margin: 0 0 0.4rem; font-size: 1.3rem; }
        .notFound p { margin: 0 0 1rem; color: var(--mc-text-muted); font-size: 0.9rem; }

        /* One breakpoint, on the container rather than the viewport: this element's width is decided by the
           host's page region, which the plugin does not know and should not guess from the window. */
        @container (max-width: 30rem) {
          .hero { padding: 1.25rem 1rem; }
          .hero h1 { font-size: 1.3rem; }
          .grid { grid-template-columns: 1fr; }
        }
      `}</style>

      {match === null ? (
        <NotFoundView ctx={ctx} i18n={i18n} />
      ) : match.pattern === `${DETAIL_PREFIX}:slug` ? (
        <DetailView
          ctx={ctx}
          slug={match.params.slug}
          i18n={i18n}
          locale={locale}
          title={title(match.params.slug)}
          snapshot={displays[match.params.slug]}
        />
      ) : (
        <>
          <header className="hero">
            <h1>{settings.headingOverride || i18n.t('page.title')}</h1>
            <p>{i18n.t('page.tagline')}</p>
            <div className="heroStats">
              <span className="chip">
                <Icon name="star" />
                <strong>{i18n.n(entries.length)}</strong> {i18n.plural('page.stat.highlights', entries.length)}
              </span>
              <span className="chip">
                <Icon name="clock" />
                <strong>{i18n.n(moments.length)}</strong> {i18n.plural('page.stat.moments', moments.length)}
              </span>
              <span className="chip">
                <Icon name="image" />
                <strong>{i18n.n(pictures.length)}</strong> {i18n.plural('page.stat.pictures', pictures.length)}
              </span>
            </div>
            <Contributors ctx={ctx} i18n={i18n} entries={entries} />
          </header>

          {/* The same entrances the host lists in its navigation menu, offered again from inside the page:
              once someone is here, sending them back to the hamburger to change view would be worse. Both
              are generated from PAGE_ENTRIES, so they cannot disagree about where a view lives. */}
          <nav className="tabs" aria-label={i18n.t('page.nav.label')}>
            {tabs.map((entry) => (
              <a
                key={entry.path}
                className={`tab${entry.visibleTo === 'podcaster' ? ' staff' : ''}`}
                aria-current={match.pattern === entry.path ? 'page' : undefined}
                {...internalLink(ctx.route, entry.path)}
              >
                <Icon name={entry.icon} />
                {i18n.t(entry.labelKey)}
              </a>
            ))}
          </nav>

          {(match.pattern === '' || match.pattern === 'gallery') && (
            <Sorter route={ctx.route} path={match.pattern} sort={sort} i18n={i18n} />
          )}

          {match.pattern === '' && <IndexView {...view} />}
          {match.pattern === 'moments' && <MomentsView {...view} entries={moments} />}
          {match.pattern === 'gallery' && <GalleryView {...view} entries={pictures} />}
          {match.pattern === 'unwritten' &&
            (canSeeDrafts ? (
              <UnwrittenView ctx={ctx} slugs={unwritten} i18n={i18n} title={title} />
            ) : (
              // Reachable by typing the URL even though the entry was never offered. The host already
              // refuses the *data*; this is only about not rendering a staff view's chrome to a visitor.
              // Note this is deliberately **not** a 404: the route exists, this caller may not use it, and
              // `hasRoute` answers about existence rather than about permission.
              <p className="empty">{i18n.t('page.unwritten.denied')}</p>
            ))}
        </>
      )}
    </div>
  );
}

/** Narrows a raw `?sort=` value, falling back to the default rather than trusting the URL. */
function readSort(raw: string | null): Sort {
  return SORTS.includes(raw as Sort) ? (raw as Sort) : 'newest';
}

/**
 * Orders a list of highlights.
 *
 * `newest` reads the publication date off the **host's** snapshot rather than out of the plugin's own
 * index: the date belongs to the feed (§4.2) and this plugin has no business storing a second copy of it.
 * An episode with no snapshot — filtered out for this visitor, or beyond the batch limit — sorts last
 * rather than being dropped, since the highlight itself is still readable.
 */
function sortEntries(
  entries: IndexEntry[],
  sort: Sort,
  displays: Record<string, DisplaySnapshot>,
): IndexEntry[] {
  const copy = [...entries];
  if (sort === 'favourites') {
    return copy.sort((a, b) => b.favourites - a.favourites);
  }
  const at = (slug: string) => Date.parse(displays[slug]?.publishedAt ?? '') || -Infinity;
  return copy.sort((a, b) => at(b.slug) - at(a.slug));
}

/**
 * Who writes the highlights (SDK 0.13.0, `ctx.users`, ARCHITECTURE §8.8).
 *
 * **One call for the whole listing.** `resolve` takes an array precisely so a page like this costs a single
 * request no matter how long the feed is; a byline that resolved per row would be one request per card, and
 * the naive version of that is the reason a directory lookup and not a wider `ctx.user` is what §8.8 grants.
 * {@link useAuthors} de-duplicates and returns a `Map` keyed on `UserRef.id`.
 *
 * **The counts outlive their authors.** An id `resolve` did not return — erased, pseudonymised, or unknown
 * to this install — still has highlights to its name, so its tally is folded into one "former contributors"
 * row rather than dropped. That is the property this shape exists for: the aggregate stays true while the
 * person becomes a placeholder, and it works without this plugin ever having kept a copy of anybody's name.
 *
 * Renders nothing when the manifest declares no `identity` block, and nothing when no highlight carries an
 * `authorId` — every document written before 2.15.0.
 */
function Contributors({
  ctx,
  i18n,
  entries,
}: {
  ctx: PluginContext;
  i18n: PluginI18n;
  entries: IndexEntry[];
}) {
  const ids = entries.map((e) => e.authorId).filter((id): id is string => !!id);
  const authors = useAuthors(ctx, ids);
  if (!authors || ids.length === 0) return null;

  const tally = new Map<string, number>();
  for (const id of ids) tally.set(id, (tally.get(id) ?? 0) + 1);
  // Split on what came back, not on what was asked: `resolve` omits rather than redacts, so membership in
  // the map is the whole test. Matching on position instead would attribute one person's work to another
  // the moment a single author deleted their account.
  const known = [...tally].filter(([id]) => authors.has(id)).sort((a, b) => b[1] - a[1]);
  const gone = [...tally].filter(([id]) => !authors.has(id)).reduce((sum, [, n]) => sum + n, 0);

  return (
    <div className="contributors">
      <style>{`
        .contributors { margin-top: 0.75rem; display: flex; flex-wrap: wrap; align-items: center;
          gap: 0.5rem; font-size: 0.8rem; color: var(--mc-text-muted); }
        .contributors .who { display: inline-flex; align-items: center; gap: 0.3rem;
          padding: 0.15rem 0.5rem 0.15rem 0.15rem; border: 1px solid var(--mc-border);
          border-radius: 999px; }
        .contributors img { width: 1.3rem; height: 1.3rem; border-radius: 999px; object-fit: cover;
          background: var(--mc-surface-2); }
        .contributors .who .n { color: var(--mc-text-muted); }
        .contributors .who .n::before { content: '·'; margin-right: 0.3rem; }
        .contributors .gone { font-style: italic; }
      `}</style>
      <span>{i18n.t('page.authors')}</span>
      {known.map(([id, n]) => {
        // Non-null by construction: `known` was filtered on `authors.has(id)` one statement above.
        const who = authors.get(id)!;
        return (
          <span className="who" key={id}>
            {/* Host-served and always populated (§8.7) — generated from the UUID when there is no provider
                picture, and proxied rather than redirected so no provider id reaches the page source. */}
            <img src={who.avatarUrl} alt="" width={21} height={21} />
            {who.displayName}
            <span className="n">{i18n.plural('page.authors.count', n)}</span>
          </span>
        );
      })}
      {gone > 0 && (
        <span className="gone">
          {i18n.t('page.authors.former')} {i18n.plural('page.authors.count', gone)}
        </span>
      )}
    </div>
  );
}

/**
 * The shareable sort control (SDK 0.9.0, `ctx.route.query`).
 *
 * Real `href`s carrying the query, so the order is copy-linkable and survives a reload — which is the
 * entire argument for putting it in the URL rather than in component state. `replace: true` on the click:
 * changing a sort order is not a place a visitor wants the back button to return them to, and without it a
 * few taps buries the page they arrived from under a stack of orderings of the same list.
 */
function Sorter({
  route,
  path,
  sort,
  i18n,
}: {
  route: PluginRoute;
  path: string;
  sort: Sort;
  i18n: PluginI18n;
}) {
  return (
    <div className="sorter">
      <span className="sortLabel">
        <Icon name="sort" />
        {i18n.t('page.sort.label')}
      </span>
      {SORTS.map((option) => {
        const subpath = `${path}?sort=${option}`;
        return (
          <a
            key={option}
            href={`/p/sample/${subpath}`}
            aria-current={option === sort}
            onClick={(e) => {
              if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
              e.preventDefault();
              route.navigate(subpath, { replace: true });
            }}
          >
            {i18n.t(`page.sort.${option}`)}
          </a>
        );
      })}
    </div>
  );
}

type ViewProps = {
  ctx: PluginContext;
  entries: IndexEntry[];
  i18n: PluginI18n;
  title: (slug: string) => string;
  displays: Record<string, DisplaySnapshot>;
};

/** The feed's own date and runtime for an episode, or nothing when the host gave no snapshot. */
function FeedMeta({ snapshot, i18n }: { snapshot: DisplaySnapshot | undefined; i18n: PluginI18n }) {
  if (!snapshot) return null;
  const published = snapshot.publishedAt ? i18n.date(snapshot.publishedAt) : '';
  // `duration` is an ISO-8601 duration string in the contract, and i18n.duration takes one directly —
  // the parse this plugin would otherwise be hand-rolling for `PT1H2M3S`.
  const runtime = snapshot.duration ? i18n.duration(snapshot.duration) : '';
  if (!published && !runtime) return null;
  return (
    <p className="feedMeta">
      {published && <span>{published}</span>}
      {published && runtime && <span className="dot">·</span>}
      {runtime && <span>{runtime}</span>}
    </p>
  );
}

/** The root view: every highlighted episode as a card, in the order `?sort=` asked for. */
function IndexView({ ctx, entries, i18n, title, displays }: ViewProps) {
  if (entries.length === 0) return <p className="empty">{i18n.t('page.index.empty')}</p>;
  return (
    <div className="grid">
      {entries.map((entry) => {
        const snapshot = displays[entry.slug];
        // The podcaster's own uploaded picture wins; failing that the host's artwork for the episode, which
        // resolveArtwork resolves episode-image-then-feed-cover exactly as the core UI does. A card with a
        // real cover on it is the visible half of what ctx.feeds bought.
        const artwork = entry.imageRef && ctx.blobs ? ctx.blobs.urlFor(entry.imageRef) : snapshot && resolveArtwork(snapshot);
        return (
          <a
            key={entry.slug}
            className="card"
            {...internalLink(ctx.route, `${DETAIL_PREFIX}${encodeURIComponent(entry.slug)}`)}
          >
            {artwork ? (
              // alt="" on purpose: the card's own title names the episode, so describing the picture again
              // makes a screen reader read the row twice. The image is decoration *here*; the detail view
              // renders the podcaster's real alt text.
              <img className="thumb" src={artwork} alt="" loading="lazy" />
            ) : (
              <span className="thumb blank" aria-hidden="true">
                <Icon name="star" />
              </span>
            )}
            <div className="body">
              <span className="name">{title(entry.slug)}</span>
              <FeedMeta snapshot={snapshot} i18n={i18n} />
              <p className="excerpt">{entry.excerpt}</p>
              <div className="meta">
                {entry.momentSeconds != null && (
                  <span className="chip">
                    <Icon name="clock" />
                    {i18n.duration(entry.momentSeconds)}
                  </span>
                )}
                {entry.favourites > 0 && (
                  <span className="chip">
                    <Icon name="star-on" />
                    {i18n.n(entry.favourites)}
                  </span>
                )}
              </div>
            </div>
          </a>
        );
      })}
    </div>
  );
}

/**
 * Key moments as a timeline.
 *
 * The timestamp links **out** to core's episode page with `?t=` — `ctx.links.episode(slug, { t })`, which
 * seeks the player on arrival. That is the whole point of this view: the plugin knows where the good bit
 * is, and core owns the player, so the interesting thing to offer is the handoff.
 */
function MomentsView({ ctx, entries, i18n, title, displays }: ViewProps) {
  if (entries.length === 0) return <p className="empty">{i18n.t('page.moments.empty')}</p>;
  return (
    <ul className="timeline">
      {entries.map((entry) => (
        <li key={entry.slug}>
          <a className="stamp" href={ctx.links.episode(entry.slug, { t: entry.momentSeconds! })}>
            <Icon name="play" />
            {i18n.duration(entry.momentSeconds!)}
          </a>
          <div className="what">
            <a className="name" {...internalLink(ctx.route, `${DETAIL_PREFIX}${encodeURIComponent(entry.slug)}`)}>
              {title(entry.slug)}
            </a>
            <FeedMeta snapshot={displays[entry.slug]} i18n={i18n} />
            <p className="excerpt">{entry.excerpt}</p>
          </div>
        </li>
      ))}
    </ul>
  );
}

/** Only the highlights carrying an uploaded image — the `blobs` surface, at listing scale. */
function GalleryView({ ctx, entries, i18n, title }: ViewProps) {
  // `ctx.blobs` is null when the operator refused the manifest's block, and then there is nothing to show
  // rather than a grid of broken thumbnails.
  if (!ctx.blobs) return <p className="empty">{i18n.t('page.gallery.disabled')}</p>;
  if (entries.length === 0) return <p className="empty">{i18n.t('page.gallery.empty')}</p>;
  const blobs = ctx.blobs;
  return (
    <div className="grid">
      {entries.map((entry) => (
        <a key={entry.slug} className="card" {...internalLink(ctx.route, `${DETAIL_PREFIX}${encodeURIComponent(entry.slug)}`)}>
          <img className="thumb" src={blobs.urlFor(entry.imageRef!)} alt="" loading="lazy" />
          <div className="body">
            <span className="name">{title(entry.slug)}</span>
          </div>
        </a>
      ))}
    </div>
  );
}

/**
 * The podcaster-only entrance: episodes with no highlight yet.
 *
 * This is the entry point that justifies `visibleTo` on a nav entry. It is not secret — every episode
 * listed is one the visitor could already see — it is simply **work**, and showing a to-do list to an
 * audience is noise. The host filters the menu entry server-side; this filters the view. The backend's
 * `SearchProvider` gates the matching search hit the same way, and for the same reason.
 */
function UnwrittenView({
  ctx,
  slugs,
  i18n,
  title,
}: {
  ctx: PluginContext;
  slugs: string[];
  i18n: PluginI18n;
  title: (slug: string) => string;
}) {
  if (slugs.length === 0) return <p className="empty">{i18n.t('page.unwritten.empty')}</p>;
  return (
    <ul className="todo">
      {slugs.map((slug) => (
        <li key={slug}>
          <span>{title(slug)}</span>
          {/* Out to core's episode page, where this plugin's own episode/main tile carries the editor. */}
          <a href={ctx.links.episode(slug)}>
            <Icon name="compose" />
            {i18n.t('page.unwritten.write')}
          </a>
        </li>
      ))}
    </ul>
  );
}

/**
 * What a subpath this plugin does not serve looks like (SDK 0.9.1, ARCHITECTURE §6.6).
 *
 * The backend's `PageRouteProvider` makes the host answer this URL with a real **404**, and the shell
 * renders its own not-found view around whatever a plugin produces — so this body exists to *agree* with
 * that status line rather than to replace it. Rendering the index here instead, which is what this page did
 * until 2.12.0, is a soft-404: it tells a person they found something and tells a crawler the same.
 */
function NotFoundView({ ctx, i18n }: { ctx: PluginContext; i18n: PluginI18n }) {
  return (
    <div className="notFound">
      <h1>{i18n.t('page.notFound.title')}</h1>
      <p>{i18n.t('page.notFound.body')}</p>
      <a className="listen" {...internalLink(ctx.route, '')}>
        <Icon name="arrow-left" />
        {i18n.t('page.back')}
      </a>
    </div>
  );
}

/**
 * One episode's highlight, in full — the destination the cards and the timeline link to.
 *
 * **This is the URL that goes into `sitemap.xml`**, which is why it resolves the reader's language here and
 * not only in the episode slot. Core can serve it as `?lang=de` (§12.7) and the backend declares an
 * `hreflang` alternate saying a German version exists (`SamplePlugin.urls()`, SDK 0.12.0); a page that
 * rendered `doc.markdown` regardless — which this one did until 2.14.0 — would answer that alternate with
 * the English original. The claim in the sitemap and what the URL actually serves have to be the same fact.
 */
function DetailView({
  ctx,
  slug,
  i18n,
  locale,
  title,
  snapshot,
}: {
  ctx: PluginContext;
  slug: string;
  i18n: PluginI18n;
  /** `ctx.locale.current()`, lifted to the page so a language switch re-renders this view. */
  locale: string;
  title: string;
  snapshot: DisplaySnapshot | undefined;
}) {
  const [doc, setDoc] = useState<HighlightDoc | null>(null);
  const [loaded, setLoaded] = useState(false);
  useEffect(() => {
    // The slug came out of a visitor-controlled URL, and `ctx.docs` is what makes that safe to pass along:
    // it encodes the scope id and validates the key against the host's pattern before spending a request.
    ctx.docs
      .get<HighlightDoc>(episodeTarget(slug), HIGHLIGHT_KEY)
      .then(setDoc)
      .catch(() => {
        setDoc(null);
        ctx.log('warn', `highlight unavailable for ${slug}`);
      })
      .finally(() => setLoaded(true));
  }, [ctx, slug]);

  // Built from `content()`, never `available()`: the site default is the last fallback for anything stored
  // per language, and which languages the *shell* renders in says nothing about which one this prose is in.
  const shown = doc ? resolveHighlightText(doc, locale, defaultLocaleOf(ctx.locale.content())) : null;

  return (
    <>
      <a className="back" {...internalLink(ctx.route, '')}>
        <Icon name="arrow-left" />
        {i18n.t('page.back')}
      </a>
      {!loaded ? null : shown?.markdown ? (
        <article className="detail">
          {doc?.image && ctx.blobs && (
            <img className="image" src={ctx.blobs.urlFor(doc.image.ref)} alt={doc.image.alt} />
          )}
          <h2>{title}</h2>
          {snapshot?.publishedAt && <p className="published">{i18n.date(snapshot.publishedAt)}</p>}
          {/* `lang` on the element and not only in the copy: it is what tells a screen reader to switch
              voice and a browser which hyphenation rules to use. The page chrome around it stays in the
              shell's language, which is why this sits on the content div rather than on the article. */}
          <div
            className="content"
            lang={shown.locale}
            dangerouslySetInnerHTML={{ __html: renderMarkdown(shown.markdown) }}
          />
          {/* The same two provenance notes the episode slot shows, and for the same reason: a reader who
              cannot tell machine output from the podcaster's own words is the one actually harmed. They
              matter more here — this is the page a search engine sends somebody to. */}
          {shown.machineTranslated && (
            <p className="provenance">
              <Icon name="translate" />
              {i18n.t('i18n.machineNote')}
            </p>
          )}
          {shown.fallback && (
            <p className="provenance">
              <Icon name="info" />
              {i18n.t('i18n.fallbackNote', { language: nativeNameOf(ctx, shown.locale) })}
            </p>
          )}
          <a
            className="listen"
            href={ctx.links.episode(slug, doc?.momentSeconds != null ? { t: doc.momentSeconds } : undefined)}
          >
            <Icon name="play" />
            {doc?.momentSeconds != null
              ? i18n.t('listen.at', { time: i18n.duration(doc.momentSeconds) })
              : i18n.t('listen')}
          </a>
          {/* The vocabulary the backend mirrored onto this highlight's subject, plus what else on the site
              is about the same thing. Related tags are worth the extra request here and not on a list. */}
          <HighlightTags ctx={ctx} i18n={i18n} slug={slug} showRelated />
        </article>
      ) : (
        // Distinct from NotFoundView: `hasRoute` answers `false` for a slug with no publishable highlight,
        // so this is what a *race* looks like — the highlight was removed between the index being published
        // and this view loading. The host will 404 the same URL on the next request.
        <p className="empty">{i18n.t('page.detail.missing')}</p>
      )}
    </>
  );
}
