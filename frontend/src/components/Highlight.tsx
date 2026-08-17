// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 The Mosaicast Authors

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { MouseEvent } from 'react';
import type { PluginContext, PluginRoute } from '@mosaicast/plugin-sdk';
import { marked } from 'marked';
import DOMPurify from 'dompurify';
import { makeI18n } from '../i18n';
import { HighlightModal } from './HighlightModal';
import { ConsentExtras } from './ConsentExtras';
import { FONT_STACKS, SETTINGS_PATH, type SiteSettings } from './AdminSettings';
import {
  favouriteCountPath,
  favouriteDocPath,
  formatTime,
  highlightDocPath,
  type FavouriteCount,
  type HighlightDoc,
} from '../highlight-doc';

interface HighlightStats {
  totalEpisodes: number;
  highlightedEpisodes: number;
  episodesWithMoment: number;
  totalFavourites: number;
}

/** The subpath prefix this plugin's deep links use under `/p/sample/` (ARCHITECTURE §6.4). */
const DEEP_LINK_PREFIX = 'highlight/';

/**
 * Props for a link that stays inside this plugin's own page subtree: a real `href` **and** an `onClick`
 * that routes a plain left-click through `ctx.route.navigate` instead (SDK 0.7.0).
 *
 * Both halves matter, which is why this is a helper rather than one or the other:
 *
 * - The `href` is what makes the link a link — middle-click, "open in new tab", copy-link, a crawler
 *   following it, and the status bar on hover all read the attribute, not the handler.
 * - `navigate` makes the plain click *SPA* navigation: a history entry and a working back button with no
 *   reload of the shell or of this bundle, where the bare `href` costs a full document load.
 *
 * The modifier guard is the point of keeping both. A ctrl/cmd/shift/alt-click or a non-primary button has
 * to fall through to the browser untouched, or "open in new tab" silently navigates the current tab.
 *
 * @param route   `ctx.route` — the host handle; never `history.pushState`, which the SDK calls out as
 *                explicitly outside the contract
 * @param subpath the target below `/p/sample/`, already percent-encoded; `''` is the plugin's page root
 * @returns `href`/`onClick` props to spread onto an `<a>`
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

/** Renders markdown to sanitized HTML — never trust a podcaster-authored string verbatim (ARCHITECTURE §12.6). */
function renderMarkdown(markdown: string): string {
  return DOMPurify.sanitize(marked.parse(markdown, { async: false }) as string);
}

/**
 * The one Web Component behind three of this plugin's slots (episode/main, feed/feed, site/site) — plus,
 * at the site scope, its own deep-link "single highlight" view under `/p/sample/highlight/<episodeSlug>`.
 *
 * This is the **reference** instance of the plugin, so it deliberately touches every field of `ctx`
 * (ARCHITECTURE §7.5) rather than only what the "highlight" feature strictly needs:
 *
 * - `scope`, `user`, `api`, `locale`, `theme` — the original highlight read/write/i18n/theming.
 * - `consent` — {@link ConsentExtras}, one widget per declared service, driven by `request()`/`granted()`.
 * - `filter` — a read-only "filtered to season N" note at feed/site scope.
 * - `player` — a key-moment jump button + "played" indicator at episode scope.
 * - `route` — the site-scope element doubles as a shareable single-highlight page when `ctx.route.path`
 *   matches `highlight/<slug>`, and every link *back into* that subtree goes through `route.navigate`
 *   (SDK 0.7.0) rather than costing a document load — see {@link internalLink}.
 * - `progress` — an opt-in (`highlight.spoiler`) reveal gate at episode scope.
 * - the **`user` storage scope** (SDK 0.5.0) — a signed-in visitor's own "favourite" mark, written to
 *   `data/user/me/fav:<episodeSlug>` and readable only by them. Its public tally comes back from a
 *   *different* doc the backend computes with `queryAcrossUsers` — see {@link favouriteDocPath}.
 * - `episode.status` — an "upcoming episode" badge while `PLANNED`.
 * - `log` — sent on a saved/failed highlight edit, a manual spoiler reveal, a key-moment jump, and every
 *   consent request/grant/deny (inside {@link ConsentExtras}) — real signal from real user actions, not
 *   a demo-only call site.
 *
 * The one field it does not touch is `ctx.schema` (0.7.0), which is `null` for any plugin whose manifest
 * declares `"storage": "doc"` — as this one's does, the doc store being the default.
 *
 * Reads/writes go through `ctx.api`'s generic doc-store surface, never through a plugin-authored route.
 */
export function Highlight({ ctx }: { ctx: PluginContext }) {
  const scopeType = ctx.scope.type;
  const isSite = scopeType === 'site';
  const isEpisode = scopeType === 'episode';

  const [locale, setLocale] = useState(ctx.locale.current());
  const i18n = useMemo(() => makeI18n(ctx.locale), [ctx]);
  useEffect(() => ctx.locale.onChange(setLocale), [ctx]);
  useEffect(() => () => i18n.dispose(), [i18n]);
  void locale; // re-render on locale change; i18n.t reads the current catalog internally

  // ctx.route: the site-scope instance is also the target of this plugin's deep links. `onChange` forces
  // a re-render when the host updates the subpath (e.g. following a link) without remounting us.
  const [, forceRouteRerender] = useState(0);
  useEffect(() => ctx.route.onChange(() => forceRouteRerender((n) => n + 1)), [ctx]);
  const routePath = ctx.route.path;
  const deepLinkSlug =
    isSite && routePath.startsWith(DEEP_LINK_PREFIX) ? routePath.slice(DEEP_LINK_PREFIX.length) : '';
  const inDeepLink = deepLinkSlug !== '';

  // highlightDocPath percent-encodes the id — required here because `deepLinkSlug` comes straight out of
  // the visitor-controlled URL (see its doc comment).
  const dataPath = inDeepLink
    ? highlightDocPath('episode', deepLinkSlug)
    : highlightDocPath(scopeType, ctx.scope.id);
  const canEdit = !inDeepLink && (ctx.user?.role === 'podcaster' || ctx.user?.role === 'admin');

  // ctx.filter: read-only — plugins consume filter axes, never define them (ARCHITECTURE §6.1).
  const [, forceFilterRerender] = useState(0);
  useEffect(() => ctx.filter.onChange(() => forceFilterRerender((n) => n + 1)), [ctx]);
  const season = ctx.filter.current().season;

  // The site-wide look this plugin's own admin settings panel controls (see AdminSettings.tsx) — read
  // here so every scope (and the deep-link view) reflects it, since core has no generic config-admin UI
  // yet to do this for us (ARCHITECTURE §7.2 vs. what's actually implemented today).
  const [settings, setSettings] = useState<SiteSettings>({});
  useEffect(() => {
    ctx.api
      .get<SiteSettings>(SETTINGS_PATH)
      .then((loaded) => setSettings(loaded ?? {}))
      .catch(() => setSettings({}));
  }, [ctx]);
  const fontFamily = FONT_STACKS[settings.fontFamily ?? 'system'];
  const heading = inDeepLink
    ? (ctx.episodeLabels?.[deepLinkSlug] ?? deepLinkSlug)
    : settings.headingOverride || i18n.t(`title.${scopeType}`);

  const [highlight, setHighlight] = useState<HighlightDoc | undefined>(undefined);
  const [stats, setStats] = useState<HighlightStats | undefined>(undefined);
  const [modalOpen, setModalOpen] = useState(false);
  const [draft, setDraft] = useState('');
  const [draftMoment, setDraftMoment] = useState('');
  const [draftSpoiler, setDraftSpoiler] = useState(false);
  const [saving, setSaving] = useState(false);
  const [confirmingRemove, setConfirmingRemove] = useState(false);
  const [removing, setRemoving] = useState(false);

  const loadHighlight = useCallback(() => {
    ctx.api
      .get<HighlightDoc>(dataPath)
      .then(setHighlight)
      .catch(() => setHighlight(undefined));
  }, [ctx, dataPath]);

  useEffect(loadHighlight, [loadHighlight]);

  useEffect(() => {
    if (!isSite || inDeepLink) return;
    ctx.api
      .get<HighlightStats>('data/site/main/stats')
      .then(setStats)
      .catch(() => setStats(undefined));
  }, [ctx, isSite, inDeepLink]);

  // ctx.player: a key moment (if the podcaster set one) can seek the real player and tracks whether
  // playback has already passed it, purely by re-reading `currentTime()` on each `timeupdate` tick.
  // `on` returns an Unsubscribe since 0.4.0 — returning it here detaches the listener on unmount/re-render
  // instead of leaking it into a detached shadow root (ARCHITECTURE §6.5).
  const [playerTime, setPlayerTime] = useState(0);
  useEffect(() => {
    if (!isEpisode) return;
    return ctx.player.on('timeupdate', () => setPlayerTime(ctx.player.currentTime()));
  }, [ctx, isEpisode]);

  // ctx.progress: an opt-in spoiler gate. Only content the podcaster explicitly marked `spoiler: true` is
  // held back, and only until this visitor has actually started the episode (progress > 0s) — a courtesy,
  // not access control, so a manual "show anyway" is always available (ARCHITECTURE §6.5, bingo's pattern).
  const [revealed, setRevealed] = useState(false);
  useEffect(() => {
    if (!isEpisode || ctx.episode?.status === 'PLANNED') return;
    ctx.progress.get(ctx.scope.id).then((seconds) => setRevealed((seconds ?? 0) > 0));
  }, [ctx, isEpisode]);
  const spoilerHidden = isEpisode && highlight?.spoiler === true && !revealed;

  // The `user` storage scope (SDK 0.5.0). Two docs, deliberately: `data/user/me/fav:<slug>` is this
  // visitor's own mark — the host resolves `me` from the session, so the request cannot be aimed at
  // anyone else — and `data/episode/<slug>/favourites` is the shared tally, which only the backend can
  // produce (`queryAcrossUsers`). A browser summing other people's marks is not possible any more, and
  // was never trustworthy: it would have been a count of whatever each client chose to report.
  const [favourite, setFavourite] = useState(false);
  const [favouriteCount, setFavouriteCount] = useState<number | undefined>(undefined);

  useEffect(() => {
    if (!isEpisode) return;
    ctx.api
      .get<FavouriteCount>(favouriteCountPath(ctx.scope.id))
      .then((doc) => setFavouriteCount(doc?.count))
      .catch(() => setFavouriteCount(undefined));
  }, [ctx, isEpisode]);

  useEffect(() => {
    // An anonymous visitor has no partition at all — the host answers 401, so don't ask. This is the one
    // place `ctx.user` gates a *request* rather than a control: `visibleTo`/`readableBy` govern the
    // shared surface and say nothing about `user/me`, which needs a session and nothing else.
    if (!isEpisode || !ctx.user) return;
    ctx.api
      .get<boolean>(favouriteDocPath(ctx.scope.id))
      .then((mark) => setFavourite(mark === true))
      .catch(() => setFavourite(false));
  }, [ctx, isEpisode]);

  /**
   * Toggles this visitor's own mark: `put` to set it, `delete` to withdraw it.
   *
   * Optimistic, and the displayed tally deliberately does **not** move with it — that number is
   * recomputed on the backend's schedule, and faking it here would show a count the server would
   * contradict on the next load. The pressed state is this visitor's truth; the tally is everyone's.
   */
  async function toggleFavourite() {
    const next = !favourite;
    const path = favouriteDocPath(ctx.scope.id);
    setFavourite(next);
    try {
      if (next) {
        await ctx.api.put(path, true);
      } else {
        await ctx.api.delete(path);
      }
      ctx.log('info', `favourite ${next ? 'set' : 'cleared'} at ${path}`);
    } catch (e) {
      setFavourite(!next); // nothing awaits this handler, so a rollback + log is the error story
      ctx.log('warn', `favourite toggle at ${path} failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  // Modal keyboard/focus handling. Escape closes it, and closing hands focus back to the Edit button
  // that opened it — without that, a keyboard or screen-reader user is dropped at the top of the
  // document every time they cancel. The cleanup also covers unmount, where focusing a detached button
  // is a harmless no-op.
  const editButtonRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (!modalOpen) return;
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === 'Escape') setModalOpen(false);
    }
    window.addEventListener('keydown', onKeyDown);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
      editButtonRef.current?.focus();
    };
  }, [modalOpen]);

  // Stable callback ref, so it fires once when the textarea mounts rather than stealing focus back on
  // every keystroke the way an inline `ref={(el) => el?.focus()}` would.
  const focusOnMount = useCallback((el: HTMLTextAreaElement | null) => el?.focus(), []);

  function openEditor() {
    setDraft(highlight?.markdown ?? '');
    setDraftMoment(highlight?.momentSeconds != null ? String(highlight.momentSeconds) : '');
    setDraftSpoiler(highlight?.spoiler === true);
    setConfirmingRemove(false);
    setModalOpen(true);
  }

  async function handleSave() {
    setSaving(true);
    try {
      // `min={0}` on the input only guards typing — a pasted or autofilled negative still arrives here,
      // and would make `player.seekTo()` jump to a negative offset. Clamp, matching formatTime's own floor.
      const parsedMoment = draftMoment.trim() === '' ? NaN : Number(draftMoment);
      const momentSeconds = Math.max(0, parsedMoment);
      const body: HighlightDoc = {
        markdown: draft,
        ...(Number.isFinite(momentSeconds) ? { momentSeconds } : {}),
        ...(draftSpoiler ? { spoiler: true } : {}),
      };
      await ctx.api.put(dataPath, body);
      setHighlight(body);
      setModalOpen(false);
      ctx.log('info', `highlight saved at ${dataPath}`);
    } catch (e) {
      // Not rethrown: nothing awaits this handler's promise (it's a bare onClick), so a rethrow here would
      // only become an unhandled rejection. Logging is the whole error-reporting story for this action.
      ctx.log('warn', `highlight save at ${dataPath} failed: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setSaving(false);
    }
  }

  /**
   * `ctx.api.delete` — the fourth verb of the host's generic doc-store surface, and the counterpart of the
   * backend's `DocStore.delete(scope, key)`. Removing the doc is genuinely different from saving an empty
   * one: a doc with blank markdown still reads as "present" to `SitemapProvider`/`ShareMetadataProvider`,
   * which is how contentless episodes used to end up in `sitemap.xml` with an empty OG description before
   * this button existed. The backend's scheduled recompute prunes such leftovers; this removes them at the
   * source. Idempotent server-side, so a double click is harmless.
   */
  async function handleRemove() {
    setRemoving(true);
    try {
      await ctx.api.delete(dataPath);
      setHighlight(undefined);
      setModalOpen(false);
      ctx.log('info', `highlight removed at ${dataPath}`);
    } catch (e) {
      // Same reasoning as handleSave: nothing awaits this handler, so logging is the error story. The
      // modal stays open with the confirm step still showing, so the podcaster can retry or back out.
      ctx.log('warn', `highlight removal at ${dataPath} failed: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setRemoving(false);
    }
  }

  return (
    <div className="highlight" style={{ fontFamily }}>
      <style>{`
        .highlight {
          background: var(--mc-surface);
          color: var(--mc-text);
          border: 1px solid var(--mc-border);
          border-radius: 0.5rem;
          padding: 0.75rem 1rem;
        }
        .header {
          display: flex;
          align-items: center;
          justify-content: space-between;
          gap: 0.5rem;
          margin-bottom: 0.5rem;
        }
        .title {
          font-size: 0.85rem;
          font-weight: 600;
          color: var(--mc-accent);
        }
        .content :where(p) { margin: 0 0 0.5rem; }
        .content :where(p:last-child) { margin-bottom: 0; }
        .empty {
          margin: 0;
          color: var(--mc-text-muted);
          font-style: italic;
        }
        .stat, .filterNote, .planned {
          margin: 0.5rem 0 0;
          font-size: 0.8rem;
          color: var(--mc-text-muted);
        }
        .planned { font-weight: 600; }
        .spoiler { display: flex; flex-direction: column; gap: 0.4rem; }
        .spoiler p { margin: 0; font-style: italic; color: var(--mc-text-muted); }
        .moment { margin-top: 0.5rem; display: flex; align-items: center; gap: 0.4rem; font-size: 0.8rem; }
        .moment .passed { color: var(--mc-text-muted); }
        .fav { margin-top: 0.5rem; display: flex; align-items: center; gap: 0.4rem; font-size: 0.8rem; }
        .fav .favCount, .fav .favHint { color: var(--mc-text-muted); }
        /* The pressed state uses accent-on-accent rather than a second literal colour — this is the one
           control whose state is per-visitor, so it has to read as "on" at a glance in any host theme. */
        button.favOn { background: var(--mc-accent-2); color: var(--mc-accent-contrast); }
        .browse { margin-top: 0.75rem; }
        .browse .browseTitle { margin: 0 0 0.25rem; font-size: 0.8rem; font-weight: 600; color: var(--mc-text); }
        .browse ul { margin: 0; padding-left: 1.1rem; }
        .browse a, .back { color: var(--mc-accent); }
        .back { display: inline-block; margin-bottom: 0.5rem; font-size: 0.8rem; }
        button {
          background: var(--mc-accent);
          color: var(--mc-accent-contrast);
          border: none;
          border-radius: 0.25rem;
          padding: 0.3rem 0.7rem;
          cursor: pointer;
          font: inherit;
        }
        button.secondary {
          background: transparent;
          color: var(--mc-text);
          border: 1px solid var(--mc-border);
        }
      `}</style>

      {inDeepLink && (
        <a className="back" {...internalLink(ctx.route, '')}>
          {i18n.t('browse.back')}
        </a>
      )}

      <div className="header">
        <span className="title">{heading}</span>
        {canEdit && (
          <button type="button" ref={editButtonRef} onClick={openEditor}>
            {i18n.t('edit')}
          </button>
        )}
      </div>

      {isEpisode && ctx.episode?.status === 'PLANNED' && <p className="planned">{i18n.t('planned.badge')}</p>}

      {spoilerHidden ? (
        <div className="spoiler">
          <p>{i18n.t('spoiler.hidden')}</p>
          <button
            type="button"
            className="secondary"
            onClick={() => {
              ctx.log('debug', `spoiler manually revealed for ${ctx.scope.id}`);
              setRevealed(true);
            }}
          >
            {i18n.t('spoiler.reveal')}
          </button>
        </div>
      ) : highlight?.markdown ? (
        <div className="content" dangerouslySetInnerHTML={{ __html: renderMarkdown(highlight.markdown) }} />
      ) : (
        <p className="empty">{i18n.t('noHighlight')}</p>
      )}

      {isEpisode && !spoilerHidden && highlight?.momentSeconds != null && (
        <div className="moment">
          <button
            type="button"
            className="secondary"
            onClick={() => {
              ctx.log('debug', `jumped to key moment ${highlight.momentSeconds}s for ${ctx.scope.id}`);
              ctx.player.seekTo(highlight.momentSeconds!);
            }}
          >
            {i18n.t('moment.jump', { time: formatTime(highlight.momentSeconds) })}
          </button>
          {playerTime >= highlight.momentSeconds && <span className="passed">{i18n.t('moment.passed')}</span>}
        </div>
      )}

      {isEpisode && !spoilerHidden && highlight?.markdown && (
        <div className="fav">
          {ctx.user ? (
            <button
              type="button"
              className={favourite ? 'favOn' : 'secondary'}
              aria-pressed={favourite}
              onClick={toggleFavourite}
            >
              {favourite ? i18n.t('fav.on') : i18n.t('fav.off')}
            </button>
          ) : (
            <span className="favHint">{i18n.t('fav.anonymous')}</span>
          )}
          {favouriteCount != null && favouriteCount > 0 && (
            <span className="favCount">{i18n.t('fav.count', { count: favouriteCount })}</span>
          )}
        </div>
      )}

      {(scopeType === 'feed' || (isSite && !inDeepLink)) && season != null && (
        <p className="filterNote">{i18n.t('filter.season', { season })}</p>
      )}

      {isSite && !inDeepLink && stats && (
        <p className="stat">
          {i18n.t('stat', { highlighted: stats.highlightedEpisodes, total: stats.totalEpisodes })}
          {stats.episodesWithMoment > 0 && ` ${i18n.t('stat.withMoment', { count: stats.episodesWithMoment })}`}
          {stats.totalFavourites > 0 && ` ${i18n.t('stat.favourites', { count: stats.totalFavourites })}`}
        </p>
      )}

      {isSite && !inDeepLink && ctx.episodes.length > 0 && (
        <div className="browse">
          <p className="browseTitle">{i18n.t('browse.title')}</p>
          <ul>
            {ctx.episodes.map((slug) => (
              <li key={slug}>
                <a {...internalLink(ctx.route, `${DEEP_LINK_PREFIX}${encodeURIComponent(slug)}`)}>
                  {ctx.episodeLabels?.[slug] ?? slug}
                </a>
              </li>
            ))}
          </ul>
        </div>
      )}

      {!inDeepLink && <ConsentExtras consent={ctx.consent} log={ctx.log} i18n={i18n} />}

      {modalOpen && (
        <HighlightModal theme={ctx.theme}>
          <style>{`
            .overlay {
              position: fixed;
              inset: 0;
              background: rgba(0, 0, 0, 0.5);
              display: flex;
              align-items: center;
              justify-content: center;
              z-index: 1000;
              font-family: system-ui, sans-serif;
            }
            .modal {
              background: var(--mc-surface);
              color: var(--mc-text);
              border: 1px solid var(--mc-border);
              border-radius: 0.5rem;
              padding: 1rem;
              width: min(32rem, 90vw);
              display: flex;
              flex-direction: column;
              gap: 0.5rem;
            }
            .modal h3 {
              margin: 0;
              font-size: 1rem;
              color: var(--mc-text);
            }
            .modal textarea {
              background: var(--mc-bg);
              color: var(--mc-text);
              border: 1px solid var(--mc-border);
              border-radius: 0.25rem;
              padding: 0.5rem;
              font: inherit;
              min-height: 8rem;
              resize: vertical;
            }
            .modal label.field {
              display: flex;
              align-items: center;
              gap: 0.4rem;
              font-size: 0.8rem;
            }
            .modal input[type="number"] {
              background: var(--mc-bg);
              color: var(--mc-text);
              border: 1px solid var(--mc-border);
              border-radius: 0.25rem;
              padding: 0.3rem;
              font: inherit;
              width: 6rem;
            }
            .modal .actions {
              display: flex;
              align-items: center;
              justify-content: flex-end;
              gap: 0.5rem;
            }
            .modal .actions .spacer { flex: 1; }
            .modal .actions .confirm { flex: 1; font-size: 0.8rem; }
            /* ThemeTokens has no danger colour (bg/surface/text/textMuted/accent/accentContrast/accent2/
               border only), so this is the one literal in the component. Chosen to clear 4.5:1 on both a
               light and a dark --mc-surface rather than tinting with the host's accent, which could be
               red itself and make "Remove" indistinguishable from "Save". */
            button.danger {
              background: transparent;
              color: #d33c3c;
              border: 1px solid currentColor;
            }
            button {
              background: var(--mc-accent);
              color: var(--mc-accent-contrast);
              border: none;
              border-radius: 0.25rem;
              padding: 0.3rem 0.7rem;
              cursor: pointer;
              font: inherit;
            }
            button.secondary {
              background: transparent;
              color: var(--mc-text);
              border: 1px solid var(--mc-border);
            }
          `}</style>
          <div
            className="overlay"
            role="presentation"
            onClick={(e) => {
              if (e.target === e.currentTarget) setModalOpen(false);
            }}
          >
            {/* aria-labelledby gives the dialog an accessible name — a role="dialog" without one is
                announced as just "dialog". The id is collision-free: this subtree is a shadow root. */}
            <div className="modal" role="dialog" aria-modal="true" aria-labelledby="highlight-modal-title">
              <h3 id="highlight-modal-title">{i18n.t(`editTitle.${scopeType}`)}</h3>
              <textarea
                ref={focusOnMount}
                value={draft}
                placeholder={i18n.t('markdownPlaceholder')}
                onChange={(e) => setDraft(e.target.value)}
              />
              {isEpisode && (
                <>
                  <label className="field">
                    {i18n.t('moment.label')}
                    <input
                      type="number"
                      min={0}
                      value={draftMoment}
                      onChange={(e) => setDraftMoment(e.target.value)}
                    />
                  </label>
                  <label className="field">
                    <input
                      type="checkbox"
                      checked={draftSpoiler}
                      onChange={(e) => setDraftSpoiler(e.target.checked)}
                    />
                    {i18n.t('spoiler.markLabel')}
                  </label>
                </>
              )}
              {/* Two-step confirm rather than a nested dialog: removal is destructive, but a second
                  modal inside a portalled modal is more machinery than one irreversible click warrants. */}
              <div className="actions">
                {confirmingRemove ? (
                  <>
                    <span className="confirm">{i18n.t('remove.confirm')}</span>
                    <button
                      type="button"
                      className="secondary"
                      onClick={() => setConfirmingRemove(false)}
                      disabled={removing}
                    >
                      {i18n.t('cancel')}
                    </button>
                    <button type="button" className="danger" onClick={handleRemove} disabled={removing}>
                      {removing ? i18n.t('removing') : i18n.t('remove.yes')}
                    </button>
                  </>
                ) : (
                  <>
                    {highlight && (
                      <button
                        type="button"
                        className="danger"
                        onClick={() => setConfirmingRemove(true)}
                        disabled={saving}
                      >
                        {i18n.t('remove')}
                      </button>
                    )}
                    <span className="spacer" />
                    <button type="button" className="secondary" onClick={() => setModalOpen(false)} disabled={saving}>
                      {i18n.t('cancel')}
                    </button>
                    <button type="button" onClick={handleSave} disabled={saving}>
                      {saving ? i18n.t('saving') : i18n.t('save')}
                    </button>
                  </>
                )}
              </div>
            </div>
          </div>
        </HighlightModal>
      )}
    </div>
  );
}
