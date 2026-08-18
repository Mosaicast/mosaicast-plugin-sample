// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 The Mosaicast Authors

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { MouseEvent } from 'react';
import type { BlobQuota, PluginContext, PluginRoute } from '@mosaicast/plugin-sdk';
import { marked } from 'marked';
import DOMPurify from 'dompurify';
import { makeI18n } from '../i18n';
import { HighlightModal } from './HighlightModal';
import { ConsentExtras } from './ConsentExtras';
import { FONT_STACKS, SETTINGS_PATH, type SiteSettings } from './AdminSettings';
import {
  favouriteCountPath,
  favouriteDocPath,
  formatBytes,
  formatTime,
  highlightDocPath,
  type FavouriteCount,
  type HighlightDoc,
  type HighlightImage,
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
 * - `blobs` (0.8.0) — an optional podcaster-uploaded image per highlight: `upload` from the edit modal,
 *   `quota` shown *before* a file is picked, `remove` when one is replaced or dropped, and `urlFor` at
 *   render time. Opt-in through the manifest's `blobs` block, and still guarded for `null` because an
 *   operator can refuse it.
 * - `links` (0.8.0) — `episode(slug, { t })` from the deep-link view and the browse index, and
 *   `feed(slug, { season })` from the filter note. Strings for real `href`s, never navigation.
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

  // ctx.blobs (SDK 0.8.0): `null` unless the manifest declares a `blobs` block — and an operator can
  // refuse the block on their install, so a *declared* plugin still has to survive `null`. Everything
  // below treats file storage as an enhancement, never a requirement: no upload UI appears, and a
  // highlight that already names an image renders its alt text instead of a broken <img>.
  const blobs = ctx.blobs;
  // Uploading is offered at episode and site scope only — *rendering* is not restricted, since a doc
  // that already names an image should always display it. The reason is a backend constraint rather than
  // a design preference: the scheduled sweep may only delete a blob it can prove nothing points at, so it
  // may only run over scopes the backend can *enumerate*. `Scope.site()` is a singleton and
  // `FeedAccess.episodesIn` lists every episode — but nothing in the contract lists feeds, so a
  // feed-scope highlight is invisible from there. Accepting an image here would mean either leaking it
  // forever or having the next sweep delete a live one. See SamplePlugin.sweepOrphanedImages.
  const canAttachImage = blobs !== null && scopeType !== 'feed';
  const [draftImage, setDraftImage] = useState<HighlightImage | undefined>(undefined);
  const [quota, setQuota] = useState<BlobQuota | undefined>(undefined);
  const [uploading, setUploading] = useState(false);
  const [uploadError, setUploadError] = useState('');

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
    setDraftImage(highlight?.image);
    setUploadError('');
    setConfirmingRemove(false);
    setModalOpen(true);
    // Read the *effective* room before a file is picked, not after one is refused. The manifest states
    // what this plugin asked for; the operator caps it and intersects the type list, so `quota()` is the
    // only honest source — and the podcaster deserves to know the ceiling while choosing, not once the
    // upload has already failed. Best-effort: a failure here costs a hint, not the ability to upload.
    if (canAttachImage) blobs?.quota().then(setQuota).catch(() => setQuota(undefined));
  }

  /**
   * `ctx.blobs.upload` — the one place in this component where an error must reach the **person**, not
   * just `ctx.log`.
   *
   * Everywhere else here a failure is logged and swallowed (see {@link handleSave}), because nothing the
   * visitor does can change the outcome. An upload refusal is the opposite: the host rejects on size,
   * then on the declared type against the allow-list, then on the *actual* type read from the leading
   * bytes — and the only person who can supply a different file is the one standing at the file picker.
   * Swallowing it would leave them clicking Save on an image that was never stored.
   *
   * Replacing an image drops the previous one immediately: nothing else will ever point at it, and
   * nothing collects orphans on this platform (the backend's scheduled sweep is the safety net for what
   * this path misses, not a substitute for it — see SamplePlugin.sweepOrphanedImages).
   */
  async function handlePickImage(file: File) {
    if (!blobs) return;
    setUploading(true);
    setUploadError('');
    const replaced = draftImage?.ref;
    try {
      const stored = await blobs.upload(file);
      // Keep the ref, never `urlFor(ref)` — see HighlightImage. Alt text carries over on replacement:
      // swapping the picture rarely changes what it depicts, and losing it silently is an a11y regression.
      setDraftImage({ ref: stored.ref, alt: draftImage?.alt ?? '' });
      ctx.log('info', `highlight image uploaded (${stored.mime}, ${stored.size} bytes)`);
      if (replaced && replaced !== stored.ref) await dropImage(replaced);
      blobs.quota().then(setQuota).catch(() => undefined);
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      setUploadError(message);
      ctx.log('warn', `highlight image upload refused: ${message}`);
    } finally {
      setUploading(false);
    }
  }

  /** Deletes a blob this plugin no longer points at. Idempotent host-side, so a lost race is harmless. */
  async function dropImage(ref: string) {
    try {
      await blobs?.remove(ref);
    } catch (e) {
      // Logged, not surfaced: the podcaster's edit succeeded and there is nothing for them to do about a
      // failed cleanup. The backend sweep collects whatever this misses.
      ctx.log('warn', `dropping blob ${ref} failed: ${e instanceof Error ? e.message : String(e)}`);
    }
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
        ...(draftImage ? { image: draftImage } : {}),
      };
      await ctx.api.put(dataPath, body);
      setHighlight(body);
      setModalOpen(false);
      ctx.log('info', `highlight saved at ${dataPath}`);
      // The doc is what decides an image is orphaned, so this waits until the write succeeded: dropping
      // the blob first would leave a saved highlight pointing at nothing if the put then failed.
      const dropped = highlight?.image?.ref;
      if (dropped && dropped !== draftImage?.ref) await dropImage(dropped);
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
      // Same ordering as handleSave: the doc goes first, so a failed delete never strands a live
      // highlight pointing at a blob that is already gone.
      if (highlight?.image?.ref) await dropImage(highlight.image.ref);
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
        /* max-width, not width: a podcaster's upload is whatever their camera produced, and the slot it
           lands in is a host region of unknown width. height:auto keeps the aspect ratio the host's own
           reset would otherwise let the width override. */
        .image {
          display: block;
          max-width: 100%;
          height: auto;
          margin: 0 0 0.5rem;
          border-radius: 0.25rem;
        }
        .imageAlt { margin: 0 0 0.5rem; font-style: italic; color: var(--mc-text-muted); font-size: 0.85rem; }
        .listen { margin: 0.5rem 0 0; font-size: 0.85rem; }
        .listen a { color: var(--mc-accent); }
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
        .browse .episodeLink { margin-left: 0.4rem; font-size: 0.75rem; color: var(--mc-text-muted); }
        .back { display: inline-block; margin-bottom: 0.5rem; font-size: 0.8rem; }
        .filterNote a { color: var(--mc-accent); }
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
        <>
          {/* ctx.blobs (0.8.0). `urlFor` is derived here, at render time, from the stored ref — never
              persisted. Served same-origin under /api/plugins/sample/blob/<ref>, so unlike the external
              <img> in ConsentExtras this needs no declared CSP host and makes no consent decision.
              `blobs` is null when the operator refused the block: the alt text still carries the meaning,
              which is the whole reason it is stored beside the ref rather than derived from a filename. */}
          {highlight.image &&
            (blobs ? (
              <img className="image" src={blobs.urlFor(highlight.image.ref)} alt={highlight.image.alt} />
            ) : (
              highlight.image.alt && <p className="imageAlt">{highlight.image.alt}</p>
            ))}
          <div className="content" dangerouslySetInnerHTML={{ __html: renderMarkdown(highlight.markdown) }} />
        </>
      ) : (
        <p className="empty">{i18n.t('noHighlight')}</p>
      )}

      {/* ctx.links.episode (0.8.0). The deep-link view renders an episode's highlight on *this plugin's*
          page, where there is no player and `ctx.player.seekTo` would have nothing to seek — so the way
          out is a link to core's own episode page. `?t=` is the host's timestamp deep link: it seeks the
          player on arrival and beats the listener's stored position for that navigation without
          overwriting it, which turns the podcaster's key moment into a shareable entry point.

          A plain `href`, deliberately: `route.navigate` is namespace-confined and *cannot* name a core
          route, and producing a link is not navigating — the visitor still clicks. Before 0.8.0 this
          meant hardcoding `/episodes/${slug}` and breaking whenever the host changed a route. */}
      {inDeepLink && highlight?.markdown && (
        <p className="listen">
          <a
            href={ctx.links.episode(
              deepLinkSlug,
              highlight.momentSeconds != null ? { t: highlight.momentSeconds } : undefined,
            )}
          >
            {highlight.momentSeconds != null
              ? i18n.t('listen.at', { time: formatTime(highlight.momentSeconds) })
              : i18n.t('listen')}
          </a>
        </p>
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
        <p className="filterNote">
          {scopeType === 'feed' ? (
            // ctx.links.feed (0.8.0): the host's own filtered feed URL. This plugin consumes filter axes
            // and never defines them (§6.1) — linking to core's rendering of the same axis is consuming.
            // `String(season)`: the filter axis is numeric, the URL builder takes the axis *value* as a
            // string, and the host owns the conversion in between rather than this plugin guessing a format.
            <a href={ctx.links.feed(ctx.scope.id, { season: String(season) })}>
              {i18n.t('filter.season', { season })}
            </a>
          ) : (
            i18n.t('filter.season', { season })
          )}
        </p>
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
                {/* Two links per row, and the pair is the lesson: the one above stays inside this
                    plugin's own subtree and so goes through `route.navigate`; this one leaves for a core
                    page and so can only ever be an `href` built by `ctx.links`. No `?t=` here — the
                    index knows slugs, not each episode's key moment, and fetching every highlight to
                    decorate a list would be a request per row. The deep-link view has the doc, so that
                    is where the timestamp link lives. */}
                <a className="episodeLink" href={ctx.links.episode(slug)}>
                  {i18n.t('browse.episode')}
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
            .modal input[type="text"] {
              background: var(--mc-bg);
              color: var(--mc-text);
              border: 1px solid var(--mc-border);
              border-radius: 0.25rem;
              padding: 0.3rem;
              font: inherit;
              flex: 1;
              min-width: 0;
            }
            .modal .imageField {
              display: flex;
              flex-direction: column;
              gap: 0.4rem;
              padding: 0.5rem;
              border: 1px solid var(--mc-border);
              border-radius: 0.25rem;
            }
            .modal .imageField .quota { margin: 0; font-size: 0.75rem; color: var(--mc-text-muted); }
            /* Not muted, and not the accent either: a refusal is the one message in this dialog the
               podcaster has to act on, so it gets the host's own error-ish weight rather than blending
               into the hints above it. */
            .modal .imageField .uploadError {
              margin: 0;
              font-size: 0.8rem;
              font-weight: 600;
              color: var(--mc-accent-2);
            }
            .modal .imageField .preview {
              max-width: 100%;
              height: auto;
              max-height: 8rem;
              object-fit: contain;
              border-radius: 0.25rem;
              align-self: flex-start;
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
              {/* ctx.blobs upload. Absent entirely when the operator refused the manifest block, and at
                  feed scope — see `canAttachImage`. Either way a text-only editor beats a control that
                  cannot work or whose result the backend would later delete. */}
              {canAttachImage && blobs && (
                <div className="imageField">
                  <label className="field">
                    {i18n.t('image.label')}
                    <input
                      type="file"
                      accept="image/png,image/jpeg,image/webp"
                      disabled={uploading}
                      onChange={(e) => {
                        const file = e.target.files?.[0];
                        // Clear the input so re-picking the *same* file after a refusal still fires
                        // `change` — otherwise a podcaster who fixes the file outside the browser and
                        // picks it again gets silence.
                        e.target.value = '';
                        if (file) void handlePickImage(file);
                      }}
                    />
                  </label>
                  {/* `accept` above is a filter in the picker, not a guarantee: the host re-checks the
                      declared type against the allow-list and then the real type from the leading bytes.
                      SVG is never accepted at all — a script container wearing an image's extension. */}
                  {quota && (
                    <p className="quota">
                      {i18n.t('image.quota', {
                        remaining: formatBytes(quota.quotaBytes - quota.usedBytes),
                        max: formatBytes(quota.maxFileBytes),
                      })}
                    </p>
                  )}
                  {uploading && <p className="quota">{i18n.t('image.uploading')}</p>}
                  {/* The refusal reaches the person, not only ctx.log — see handlePickImage. */}
                  {uploadError && (
                    <p className="uploadError" role="alert">
                      {i18n.t('image.refused', { reason: uploadError })}
                    </p>
                  )}
                  {draftImage && (
                    <>
                      <img className="preview" src={blobs.urlFor(draftImage.ref)} alt={draftImage.alt} />
                      <label className="field">
                        {i18n.t('image.alt')}
                        <input
                          type="text"
                          value={draftImage.alt}
                          onChange={(e) => setDraftImage({ ...draftImage, alt: e.target.value })}
                        />
                      </label>
                      <button
                        type="button"
                        className="secondary"
                        onClick={() => {
                          // Only detaches it from the draft. The blob itself is dropped by handleSave,
                          // once the doc that stopped pointing at it has actually been written.
                          setDraftImage(undefined);
                          setUploadError('');
                        }}
                      >
                        {i18n.t('image.clear')}
                      </button>
                    </>
                  )}
                </div>
              )}
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
