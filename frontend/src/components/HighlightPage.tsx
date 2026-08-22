// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 The Mosaicast Authors

import { useEffect, useMemo, useState } from 'react';
import type { MouseEvent } from 'react';
import type { PluginContext, PluginRoute } from '@mosaicast/plugin-sdk';
import { marked } from 'marked';
import DOMPurify from 'dompurify';
import { makeI18n } from '../i18n';
import { ICON_CSS, Icon } from '../icons';
import { DETAIL_PREFIX, PAGE_ENTRIES, viewFor } from '../page-entries';
import { FONT_STACKS, SETTINGS_PATH, type SiteSettings } from './AdminSettings';
import { formatTime, highlightDocPath, type HighlightDoc } from '../highlight-doc';

/** One highlighted episode as the backend's `index` doc lists it — mirrors `SamplePlugin.IndexEntry`. */
interface IndexEntry {
  slug: string;
  excerpt: string;
  momentSeconds: number | null;
  imageRef: string | null;
  favourites: number;
}

/** The backend-written listing at `data/site/main/index` — see `SamplePlugin.HighlightIndex` for why. */
interface HighlightIndex {
  entries: IndexEntry[];
}

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
 * The plugin's **page** element, mounted at the `site`/`page` placement and owning `/p/sample/*`.
 *
 * <p>This is a separate Web Component from {@link Highlight}, and the split is the lesson. A slot tile is
 * a guest in someone else's layout: it is narrow, it sits below an episode's show notes, and it should say
 * one thing. A page is the whole canvas — the plugin decides the layout, and nothing else is competing for
 * the space. Reusing one component for both means either a tile that is too loud or a page that is a
 * lonely card in an ocean of white, which is what this plugin's page was before 2.11.0.
 *
 * <p><strong>Multiple entrances (core 0.6.15).</strong> `plugin.json` declares four `nav[]` entries and the
 * host offers them in its navigation menu; the tab bar below offers the same four from inside the page.
 * Both come from {@link PAGE_ENTRIES}, and a test pins the manifest to it. One of the four is
 * `visibleTo: "podcaster"` — the host filters it server-side, so an anonymous visitor is never sent it,
 * and this component filters again from `ctx.user` because the tab bar is drawn client-side.
 *
 * <p><strong>One request, four views.</strong> Every view reads the same backend-written `index` doc
 * (`SamplePlugin.HighlightIndex`). A browser cannot build that listing itself — the doc surface is
 * addressed by scope and key, so "every episode's highlight" would be one request per episode. The
 * backend already walks that set on its schedule, so it publishes the answer.
 */
export function HighlightPage({ ctx }: { ctx: PluginContext }) {
  const [locale, setLocale] = useState(ctx.locale.current());
  const i18n = useMemo(() => makeI18n(ctx.locale), [ctx]);
  useEffect(() => ctx.locale.onChange(setLocale), [ctx]);
  useEffect(() => () => i18n.dispose(), [i18n]);
  void locale;

  // The host updates the subpath in place when a menu entry or a tab is followed, without remounting us.
  const [, forceRerender] = useState(0);
  useEffect(() => ctx.route.onChange(() => forceRerender((n) => n + 1)), [ctx]);
  const { view, slug } = viewFor(ctx.route.path);

  const [index, setIndex] = useState<HighlightIndex | undefined>(undefined);
  useEffect(() => {
    ctx.api
      .get<HighlightIndex>('data/site/main/index')
      .then(setIndex)
      .catch(() => setIndex(undefined));
  }, [ctx]);

  const [settings, setSettings] = useState<SiteSettings>({});
  useEffect(() => {
    ctx.api
      .get<SiteSettings>(SETTINGS_PATH)
      .then((loaded) => setSettings(loaded ?? {}))
      .catch(() => setSettings({}));
  }, [ctx]);

  const canSeeDrafts = ctx.user?.role === 'podcaster' || ctx.user?.role === 'admin';
  const entries = index?.entries ?? [];
  const title = (slugToName: string) => ctx.episodeLabels?.[slugToName] ?? slugToName;

  const tabs = PAGE_ENTRIES.filter((entry) => entry.visibleTo !== 'podcaster' || canSeeDrafts);
  const moments = entries.filter((e) => e.momentSeconds != null).sort((a, b) => a.momentSeconds! - b.momentSeconds!);
  const pictures = entries.filter((e) => e.imageRef);
  // `ctx.episodes` is the host's own access-filtered list, so the difference is only ever episodes this
  // visitor may already see — the gate on this view is about relevance, not secrecy.
  const written = new Set(entries.map((e) => e.slug));
  const unwritten = ctx.episodes.filter((s) => !written.has(s));

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

        /* auto-fit, not auto-fill: with four cards on a wide screen auto-fill keeps an empty fifth track
           and leaves the row looking truncated, where auto-fit collapses it and the cards share the width. */
        .grid { display: grid; gap: 0.75rem; grid-template-columns: repeat(auto-fit, minmax(15rem, 1fr)); }
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
        .card .thumb.blank .mcIcon { width: 1.6em; height: 1.6em; opacity: 0.7; }
        .card .body { padding: 0.7rem 0.8rem; display: flex; flex-direction: column; gap: 0.35rem; }
        .card .name { font-weight: 600; font-size: 0.9rem; line-height: 1.25; }
        .card .excerpt { margin: 0; font-size: 0.8rem; color: var(--mc-text-muted); line-height: 1.4; }
        .card .meta { display: flex; flex-wrap: wrap; gap: 0.35rem; margin-top: 0.15rem; }

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

        /* One breakpoint, on the container rather than the viewport: this element's width is decided by the
           host's page region, which the plugin does not know and should not guess from the window. */
        @container (max-width: 30rem) {
          .hero { padding: 1.25rem 1rem; }
          .hero h1 { font-size: 1.3rem; }
          .grid { grid-template-columns: 1fr; }
        }
      `}</style>

      {view === 'detail' ? (
        <DetailView ctx={ctx} slug={slug} i18n={i18n} title={title(slug)} />
      ) : (
        <>
          <header className="hero">
            <h1>{settings.headingOverride || i18n.t('page.title')}</h1>
            <p>{i18n.t('page.tagline')}</p>
            <div className="heroStats">
              <span className="chip">
                <Icon name="star" />
                <strong>{entries.length}</strong> {i18n.t('page.stat.highlights')}
              </span>
              <span className="chip">
                <Icon name="clock" />
                <strong>{moments.length}</strong> {i18n.t('page.stat.moments')}
              </span>
              <span className="chip">
                <Icon name="image" />
                <strong>{pictures.length}</strong> {i18n.t('page.stat.pictures')}
              </span>
            </div>
          </header>

          {/* The same entrances the host lists in its navigation menu, offered again from inside the page:
              once someone is here, sending them back to the hamburger to change view would be worse. Both
              are generated from PAGE_ENTRIES, so they cannot disagree about where a view lives. */}
          <nav className="tabs" aria-label={i18n.t('page.nav.label')}>
            {tabs.map((entry) => (
              <a
                key={entry.path}
                className={`tab${entry.visibleTo === 'podcaster' ? ' staff' : ''}`}
                aria-current={view === (entry.path || 'index') ? 'page' : undefined}
                {...internalLink(ctx.route, entry.path)}
              >
                <Icon name={entry.icon} />
                {i18n.t(entry.labelKey)}
              </a>
            ))}
          </nav>

          {view === 'index' && (
            <IndexView ctx={ctx} entries={entries} i18n={i18n} title={title} />
          )}
          {view === 'moments' && <MomentsView ctx={ctx} entries={moments} i18n={i18n} title={title} />}
          {view === 'gallery' && <GalleryView ctx={ctx} entries={pictures} i18n={i18n} title={title} />}
          {view === 'unwritten' &&
            (canSeeDrafts ? (
              <UnwrittenView ctx={ctx} slugs={unwritten} i18n={i18n} title={title} />
            ) : (
              // Reachable by typing the URL even though the entry was never offered. The host already
              // refuses the *data*; this is only about not rendering a staff view's chrome to a visitor.
              <p className="empty">{i18n.t('page.unwritten.denied')}</p>
            ))}
        </>
      )}
    </div>
  );
}

type I18n = ReturnType<typeof makeI18n>;
type ViewProps = {
  ctx: PluginContext;
  entries: IndexEntry[];
  i18n: I18n;
  title: (slug: string) => string;
};

/** The root view: every highlighted episode as a card, newest-first as the backend listed them. */
function IndexView({ ctx, entries, i18n, title }: ViewProps) {
  if (entries.length === 0) return <p className="empty">{i18n.t('page.index.empty')}</p>;
  return (
    <div className="grid">
      {entries.map((entry) => (
        <a key={entry.slug} className="card" {...internalLink(ctx.route, `${DETAIL_PREFIX}${encodeURIComponent(entry.slug)}`)}>
          {entry.imageRef && ctx.blobs ? (
            // alt="" on purpose: the card's own title names the episode, so describing the picture again
            // makes a screen reader read the row twice. The image is decoration *here*; the detail view
            // renders the podcaster's real alt text.
            <img className="thumb" src={ctx.blobs.urlFor(entry.imageRef)} alt="" loading="lazy" />
          ) : (
            <span className="thumb blank" aria-hidden="true">
              <Icon name="star" />
            </span>
          )}
          <div className="body">
            <span className="name">{title(entry.slug)}</span>
            <p className="excerpt">{entry.excerpt}</p>
            <div className="meta">
              {entry.momentSeconds != null && (
                <span className="chip">
                  <Icon name="clock" />
                  {formatTime(entry.momentSeconds)}
                </span>
              )}
              {entry.favourites > 0 && (
                <span className="chip">
                  <Icon name="star-on" />
                  {entry.favourites}
                </span>
              )}
            </div>
          </div>
        </a>
      ))}
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
function MomentsView({ ctx, entries, i18n, title }: ViewProps) {
  if (entries.length === 0) return <p className="empty">{i18n.t('page.moments.empty')}</p>;
  return (
    <ul className="timeline">
      {entries.map((entry) => (
        <li key={entry.slug}>
          <a className="stamp" href={ctx.links.episode(entry.slug, { t: entry.momentSeconds! })}>
            <Icon name="play" />
            {formatTime(entry.momentSeconds!)}
          </a>
          <div className="what">
            <a className="name" {...internalLink(ctx.route, `${DETAIL_PREFIX}${encodeURIComponent(entry.slug)}`)}>
              {title(entry.slug)}
            </a>
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
 * audience is noise. The host filters the menu entry server-side; this filters the view.
 */
function UnwrittenView({
  ctx,
  slugs,
  i18n,
  title,
}: {
  ctx: PluginContext;
  slugs: string[];
  i18n: I18n;
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

/** One episode's highlight, in full — the destination the cards and the timeline link to. */
function DetailView({
  ctx,
  slug,
  i18n,
  title,
}: {
  ctx: PluginContext;
  slug: string;
  i18n: I18n;
  title: string;
}) {
  const [doc, setDoc] = useState<HighlightDoc | undefined>(undefined);
  const [loaded, setLoaded] = useState(false);
  useEffect(() => {
    // highlightDocPath percent-encodes the id, which matters here: the slug came straight out of a
    // visitor-controlled URL.
    ctx.api
      .get<HighlightDoc>(highlightDocPath('episode', slug))
      .then(setDoc)
      .catch(() => setDoc(undefined))
      .finally(() => setLoaded(true));
  }, [ctx, slug]);

  return (
    <>
      <a className="back" {...internalLink(ctx.route, '')}>
        <Icon name="arrow-left" />
        {i18n.t('page.back')}
      </a>
      {!loaded ? null : doc?.markdown ? (
        <article className="detail">
          {doc.image && ctx.blobs && (
            <img className="image" src={ctx.blobs.urlFor(doc.image.ref)} alt={doc.image.alt} />
          )}
          <h2>{title}</h2>
          <div className="content" dangerouslySetInnerHTML={{ __html: renderMarkdown(doc.markdown) }} />
          <a
            className="listen"
            href={ctx.links.episode(slug, doc.momentSeconds != null ? { t: doc.momentSeconds } : undefined)}
          >
            <Icon name="play" />
            {doc.momentSeconds != null
              ? i18n.t('listen.at', { time: formatTime(doc.momentSeconds) })
              : i18n.t('listen')}
          </a>
        </article>
      ) : (
        <p className="empty">{i18n.t('page.detail.missing')}</p>
      )}
    </>
  );
}
