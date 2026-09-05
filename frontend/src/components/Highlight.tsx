// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 The Mosaicast Authors

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { MouseEvent } from 'react';
import { matchRoute, type BlobQuota, type PluginContext, type PluginRoute, type Scope } from '@mosaicast/plugin-sdk';
import { marked } from 'marked';
import DOMPurify from 'dompurify';
import { makeI18n, nativeNameOf } from '../i18n';
import { ICON_CSS, Icon } from '../icons';
import { HighlightModal } from './HighlightModal';
import { ConsentExtras } from './ConsentExtras';
import { HighlightTags } from './HighlightTags';
import { Byline, useAuthors } from './Byline';
import { TranslationEditor } from './TranslationEditor';
import { FONT_STACKS, type SiteSettings } from './AdminSettings';
import { describeApiError } from '../api-error';
import {
  FAVOURITE_COUNT_KEY,
  HIGHLIGHT_KEY,
  defaultLocaleOf,
  episodeTarget,
  favouriteKey,
  resolveHighlightText,
  type FavouriteCount,
  type HighlightDoc,
  type HighlightImage,
  type HighlightTranslation,
} from '../highlight-doc';

interface HighlightStats {
  totalEpisodes: number;
  highlightedEpisodes: number;
  episodesWithMoment: number;
  totalFavourites: number;
  /** How many highlights exist in every language the site authors content in (2.13.0). */
  fullyTranslated: number;
  /**
   * Text stored under a locale this site does not author content in.
   *
   * Counted and reported rather than deleted — see `SamplePlugin.recomputeHighlightStats` for why. A
   * non-zero value here usually means an admin disabled a language somebody had already written in, so it
   * is shown to a podcaster, who can act on it, and never to a visitor, who cannot.
   */
  strandedTranslations: number;
}

/** The subpath prefix this plugin's deep links use under `/p/sample/` (ARCHITECTURE §6.4). */
const DEEP_LINK_PREFIX = 'highlight/';

/**
 * The one subpath this tile answers to, for {@link matchRoute}.
 *
 * A single pattern still beats the `routePath.startsWith(DEEP_LINK_PREFIX)` this used to be: `startsWith`
 * matches `highlight/` with nothing after it and hands the rest of this component an empty slug, and it
 * would match `highlights-archive` too if the prefix ever lost its trailing slash. `matchRoute` consumes
 * the whole path and captures a **non-empty** segment or nothing at all.
 */
const DEEP_LINK_PATTERNS = [`${DEEP_LINK_PREFIX}:slug`] as const;

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
 * The host's `--mc-icon-*` set (§12.3, core 0.6.15) is the one surface here that reaches *past* `ctx`:
 * CSS custom properties inherit through the shadow boundary, so {@link Icon} draws the shell's own
 * artwork without an SDK import. See `../icons.tsx` for why that matters and what a missing token does.
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

  // `locale` drives two different things, and it is worth keeping them apart. The plugin's **own** UI text
  // comes from `i18n.t`, which reads the active catalog internally and needs this state only to force a
  // re-render. The **highlight's** text is picked below by `resolveHighlightText`, which genuinely reads
  // the value — since 2.13.0 a highlight can exist in several languages and this is the one that decides
  // which a visitor sees. The two are independent: a site can author content in a language whose UI
  // catalog this plugin does not ship, so the tile can be German prose framed in English chrome.
  const [locale, setLocale] = useState(ctx.locale.current());
  const i18n = useMemo(() => makeI18n(ctx.locale), [ctx]);
  useEffect(() => ctx.locale.onChange(setLocale), [ctx]);
  useEffect(() => () => i18n.dispose(), [i18n]);

  // ctx.route: the site-scope instance is also the target of this plugin's deep links. `onChange` forces
  // a re-render when the host updates the subpath (e.g. following a link) without remounting us.
  const [, forceRouteRerender] = useState(0);
  useEffect(() => ctx.route.onChange(() => forceRouteRerender((n) => n + 1)), [ctx]);
  // matchRoute (SDK 0.9.0): the `:slug` capture arrives already decodeURIComponent-ed, which is the other
  // half of what the hand-rolled prefix check got wrong — a slug is a URL segment and the plugin used to
  // have to remember to encode it back on the way into a doc path.
  const deepLink = isSite ? matchRoute(ctx.route.path, DEEP_LINK_PATTERNS) : null;
  const deepLinkSlug = deepLink?.params.slug ?? '';
  const inDeepLink = deepLinkSlug !== '';

  // A doc-store target, not a path string (SDK 0.9.0). `ctx.docs` builds the four-segment path, encodes the
  // id and validates the key against the host's own pattern *before* spending a 400 round-trip on it — the
  // three things this plugin used to own and had to keep right in three components. Typed as `Scope` rather
  // than the wider `DocTarget` because this one is always a partition with an id: the `'self'` and `'site'`
  // shorthands are for the singletons, and the code below reads `.type`/`.id` for its log lines.
  const docTarget: Scope = inDeepLink ? episodeTarget(deepLinkSlug) : ctx.scope;
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
    // The same document AdminSettings writes through the raw `ctx.api`, read here through the typed client
    // — `'site'` is the shorthand for `data/site/main`, whose id the contract fixes. The pair is deliberate:
    // both reach one document, and neither is the "real" way.
    ctx.docs
      .get<SiteSettings>('site', 'settings')
      .then((loaded) => setSettings(loaded ?? {}))
      .catch(() => {
        // Cosmetics. A failure costs the site's heading override and font, so it logs and the tile renders
        // with its defaults rather than showing a visitor an error about somebody else's settings.
        ctx.log('warn', 'site highlight settings unavailable; rendering defaults');
      });
  }, [ctx]);
  const fontFamily = FONT_STACKS[settings.fontFamily ?? 'system'];
  const heading = inDeepLink
    ? (ctx.episodeLabels?.[deepLinkSlug] ?? deepLinkSlug)
    : settings.headingOverride || i18n.t(`title.${scopeType}`);

  const [highlight, setHighlight] = useState<HighlightDoc | null>(null);
  const [stats, setStats] = useState<HighlightStats | null>(null);
  /** A *failure* to read the highlight, as opposed to there not being one. See {@link loadHighlight}. */
  const [loadError, setLoadError] = useState<{ key: string; detail?: string } | undefined>(undefined);
  /** A failed write, shown in the editor beside the Save button that appeared to work before 2.12.0. */
  const [writeError, setWriteError] = useState<{ key: string; detail?: string } | undefined>(undefined);
  const [modalOpen, setModalOpen] = useState(false);
  const [draft, setDraft] = useState('');
  /** The draft's other content locales, edited by {@link TranslationEditor}. */
  const [draftTranslations, setDraftTranslations] = useState<Record<string, HighlightTranslation>>({});
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
    // Absence is an answer now: `ctx.docs.get` resolves **null** for a key nothing has written, so the
    // remaining catch is a real failure — a 403 from the read floor, a 500, a dropped connection — and the
    // tile says so instead of rendering the same empty state it shows for "no highlight yet". Those two
    // were indistinguishable to a visitor for every release before 2.12.0.
    ctx.docs
      .get<HighlightDoc>(docTarget, HIGHLIGHT_KEY)
      .then((doc) => {
        setHighlight(doc);
        setLoadError(undefined);
      })
      .catch((e: unknown) => {
        setHighlight(null);
        setLoadError(describeApiError(e));
      });
  }, [ctx, docTarget.type, docTarget.id]);

  useEffect(loadHighlight, [loadHighlight]);

  useEffect(() => {
    if (!isSite || inDeepLink) return;
    ctx.docs
      .get<HighlightStats>('site', 'stats')
      .then(setStats)
      .catch(() => {
        // A derived figure. Losing it costs one line of copy, so it stays quiet rather than turning the
        // whole site tile into an error over a statistic.
        setStats(null);
        ctx.log('warn', 'highlight stats unavailable');
      });
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

  // SDK 0.10.0 — which language this visitor actually gets, and what to tell them about it. Exact match on
  // the shell's locale, else the site default; a plugin does not negotiate language codes, because the host
  // that owns the registry and the `Accept-Language` handling is already doing it on the same page.
  const siteDefaultLocale = defaultLocaleOf(ctx.locale.content());
  const shown = highlight ? resolveHighlightText(highlight, locale, siteDefaultLocale) : null;
  /** Whether there is a highlight with text in it — the condition four sections below used to spell out. */
  const hasText = (shown?.markdown ?? '') !== '';

  // ctx.users (SDK 0.13.0, §8.8). One id here; `HighlightPage` passes a whole listing to the same hook and
  // pays for one call either way. `null` when the manifest declares no `identity` block, which is the same
  // shape `ctx.tags`, `ctx.schema` and `ctx.blobs` have.
  const authors = useAuthors(ctx, highlight?.authorId ? [highlight.authorId] : []);

  // The `user` storage scope (SDK 0.5.0). Two docs, deliberately: `data/user/me/fav:<slug>` is this
  // visitor's own mark — the host resolves `me` from the session, so the request cannot be aimed at
  // anyone else — and `data/episode/<slug>/favourites` is the shared tally, which only the backend can
  // produce (`queryAcrossUsers`). A browser summing other people's marks is not possible any more, and
  // was never trustworthy: it would have been a count of whatever each client chose to report.
  const [favourite, setFavourite] = useState(false);
  const [favouriteCount, setFavouriteCount] = useState<number | undefined>(undefined);

  useEffect(() => {
    if (!isEpisode) return;
    ctx.docs
      .get<FavouriteCount>(episodeTarget(ctx.scope.id), FAVOURITE_COUNT_KEY)
      .then((doc) => setFavouriteCount(doc?.count))
      .catch(() => {
        setFavouriteCount(undefined);
        ctx.log('warn', 'favourite tally unavailable');
      });
  }, [ctx, isEpisode]);

  useEffect(() => {
    // An anonymous visitor has no partition at all — the host answers 401, so don't ask. This is the one
    // place `ctx.user` gates a *request* rather than a control: `visibleTo`/`readableBy` govern the
    // shared surface and say nothing about `user/me`, which needs a session and nothing else.
    if (!isEpisode || !ctx.user) return;
    // `'self'` resolves to `data/user/me`, and being the *shortest* thing to write is the point: the
    // convention it encodes — per-user data lives in the USER scope, never in a key — is the most
    // security-relevant one in the contract, and a convention only sticks if the safe call is the easy one.
    ctx.docs
      .get<boolean>('self', favouriteKey(ctx.scope.id))
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
    const key = favouriteKey(ctx.scope.id);
    setFavourite(next);
    try {
      if (next) {
        await ctx.docs.put('self', key, true);
      } else {
        // `remove`, the typed client's fourth verb — idempotent host-side, so a double click is harmless.
        await ctx.docs.remove('self', key);
      }
      ctx.log('info', `favourite ${next ? 'set' : 'cleared'} for ${ctx.scope.id}`);
    } catch (e) {
      setFavourite(!next); // nothing awaits this handler, so a rollback + log is the error story
      const { key: messageKey } = describeApiError(e);
      ctx.log('warn', `favourite toggle for ${ctx.scope.id} failed (${messageKey})`);
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
    // The *default-locale* text, deliberately — not `shown.markdown`. Opening the editor while the shell is
    // in German must not load the German translation into the field that holds the original and then
    // overwrite the original with it on save.
    setDraft(highlight?.markdown ?? '');
    setDraftTranslations(highlight?.translations ?? {});
    setDraftMoment(highlight?.momentSeconds != null ? String(highlight.momentSeconds) : '');
    setDraftSpoiler(highlight?.spoiler === true);
    setDraftImage(highlight?.image);
    setUploadError('');
    setWriteError(undefined);
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
      // Just the file. Until SDK 0.9.0 this plugin wrapped it in its own `declaredType(file)` helper,
      // because a browser that cannot name a file's type hands over `''` — which reaches the host as
      // `application/octet-stream` and is refused on the *declared* type before the bytes are ever read
      // (ARCHITECTURE §11.1), so a valid PNG failed in Firefox and worked in Chromium. `blobs.upload`
      // normalises by default now. `{ declaredType: 'preserve' }` opts back out, and nothing here wants to.
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
    setWriteError(undefined);
    try {
      // `min={0}` on the input only guards typing — a pasted or autofilled negative still arrives here,
      // and would make `player.seekTo()` jump to a negative offset, so clamp it.
      const parsedMoment = draftMoment.trim() === '' ? NaN : Number(draftMoment);
      const momentSeconds = Math.max(0, parsedMoment);
      const body: HighlightDoc = {
        markdown: draft,
        // Omitted rather than written as `{}` when there are none: a document that never had a translation
        // and one whose last translation was just deleted should read back identically, and an empty object
        // is one more shape the backend's coverage pass would have to special-case.
        ...(Object.keys(draftTranslations).length > 0 ? { translations: draftTranslations } : {}),
        ...(Number.isFinite(momentSeconds) ? { momentSeconds } : {}),
        ...(draftSpoiler ? { spoiler: true } : {}),
        ...(draftImage ? { image: draftImage } : {}),
        // SDK 0.13.0. Preserve-or-set, never overwrite: this credits whoever *wrote* the highlight, and a
        // second podcaster fixing a typo is not that person. `ctx.user` is non-null here by construction —
        // the edit modal is behind the podcaster gate — but the optional chain keeps the field simply
        // absent rather than `undefined` if that ever stops being true.
        ...(highlight?.authorId
          ? { authorId: highlight.authorId }
          : ctx.user
            ? { authorId: ctx.user.id }
            : {}),
      };
      await ctx.docs.put(docTarget, HIGHLIGHT_KEY, body);
      setHighlight(body);
      setModalOpen(false);
      ctx.log('info', `highlight saved for ${docTarget.type} ${docTarget.id}`);
      // The doc is what decides an image is orphaned, so this waits until the write succeeded: dropping
      // the blob first would leave a saved highlight pointing at nothing if the put then failed.
      const dropped = highlight?.image?.ref;
      if (dropped && dropped !== draftImage?.ref) await dropImage(dropped);
    } catch (e) {
      // Not rethrown: nothing awaits this handler's promise (it's a bare onClick), so a rethrow here would
      // only become an unhandled rejection. What is new in 2.12.0 is that the modal *stays open* and says
      // what happened — the rejection carries a status and the host's problem detail, so "a `backendOwned`
      // key refused you" is now distinguishable from "the server fell over", and a podcaster no longer
      // watches a Save button close over a write that never landed.
      setWriteError(describeApiError(e));
      ctx.log('warn', `highlight save for ${docTarget.type} ${docTarget.id} failed`);
    } finally {
      setSaving(false);
    }
  }

  /**
   * `ctx.docs.remove` — the fourth verb of the host's generic doc-store surface, and the counterpart of the
   * backend's `DocStore.delete(scope, key)`. Removing the doc is genuinely different from saving an empty
   * one: a doc with blank markdown still reads as "present" to `SitemapProvider`/`ShareMetadataProvider`,
   * which is how contentless episodes used to end up in `sitemap.xml` with an empty OG description before
   * this button existed — and, since 0.9.1, would keep `PageRouteProvider` answering `200` for a highlight
   * with nothing in it. The backend's scheduled recompute prunes such leftovers; this removes them at the
   * source. Idempotent server-side, so a double click is harmless.
   */
  async function handleRemove() {
    setRemoving(true);
    setWriteError(undefined);
    try {
      await ctx.docs.remove(docTarget, HIGHLIGHT_KEY);
      setHighlight(null);
      setModalOpen(false);
      ctx.log('info', `highlight removed for ${docTarget.type} ${docTarget.id}`);
      // Same ordering as handleSave: the doc goes first, so a failed delete never strands a live
      // highlight pointing at a blob that is already gone.
      if (highlight?.image?.ref) await dropImage(highlight.image.ref);
    } catch (e) {
      // The modal stays open with the confirm step still showing, so the podcaster can retry or back out —
      // and now with the reason, rather than a log line only an operator would ever read.
      setWriteError(describeApiError(e));
      ctx.log('warn', `highlight removal for ${docTarget.type} ${docTarget.id} failed`);
    } finally {
      setRemoving(false);
    }
  }

  return (
    <div className="highlight" style={{ fontFamily }}>
      <style>{`
        ${ICON_CSS}
        /* Buttons and links carry an icon *plus* their label, so both need to line up on the text
           baseline rather than the box. inline-flex on a link would also break its wrapping. */
        button, .listen a, .back, .browse .episodeLink { display: inline-flex; align-items: center; gap: 0.35rem; }
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
        /* Provenance sits *under* the text it describes and stays muted. It is a caption, not a warning:
           a machine translation is still worth reading, and styling it as an alarm would tell a reader to
           distrust the paragraph rather than to know where it came from. */
        .provenance {
          margin: 0.35rem 0 0;
          font-size: 0.75rem;
          color: var(--mc-text-muted);
          display: flex;
          align-items: baseline;
          gap: 0.3rem;
        }
        .listen { margin: 0.5rem 0 0; font-size: 0.85rem; }
        .listen a { color: var(--mc-accent); }
        .empty {
          margin: 0;
          color: var(--mc-text-muted);
          font-style: italic;
        }
        /* Deliberately not styled as an alarm. A failed read is worth telling the visitor about — the point
           of typed errors is that it is no longer indistinguishable from an empty tile — but it is still
           one plugin's tile on somebody else's page, so it states the case and stops. */
        .error { margin: 0; font-size: 0.85rem; display: flex; align-items: baseline; gap: 0.35rem; }
        .error .detail { color: var(--mc-text-muted); font-size: 0.8rem; }
        .stat, .filterNote, .planned {
          margin: 0.5rem 0 0;
          font-size: 0.8rem;
          color: var(--mc-text-muted);
        }
        .planned { font-weight: 600; }
        .spoiler { display: flex; flex-direction: column; gap: 0.4rem; }
        .spoiler p { margin: 0; font-style: italic; color: var(--mc-text-muted); }
        .moment { margin-top: 0.5rem; display: flex; align-items: center; gap: 0.4rem; font-size: 0.8rem; }
        .moment .passed { color: var(--mc-text-muted); display: inline-flex; align-items: center; gap: 0.25rem; }
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

      {/* Every icon in this component sits *beside* its label, never instead of it. That is what lets
          the catalogs (`locales/*.json`) hold plain sentences: before 0.6.15 the arrow here was a literal
          `←` inside the translated string, which made a piece of presentation something a translator
          could change, drop, or mirror wrongly for an RTL locale. An icon is not a word. */}
      {inDeepLink && (
        <a className="back" {...internalLink(ctx.route, '')}>
          <Icon name="arrow-left" />
          {i18n.t('browse.back')}
        </a>
      )}

      <div className="header">
        <span className="title">{heading}</span>
        {canEdit && (
          <button type="button" ref={editButtonRef} onClick={openEditor}>
            <Icon name="edit" />
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
      ) : highlight && hasText && shown ? (
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
          {/* `lang` on the element, not just in the copy below it. It is what tells a screen reader to
              switch voice and a browser which hyphenation and quotation rules to apply — a German
              paragraph announced by an English synthesiser is unintelligible in a way no visible badge
              fixes. The tile's own chrome stays in the shell's language, which is why this sits on the
              content div rather than on the root. */}
          <div
            className="content"
            lang={shown.locale}
            dangerouslySetInnerHTML={{ __html: renderMarkdown(shown.markdown) }}
          />
          {/* Provenance, shown to the reader and not only to the podcaster. The SDK's rule that machine
              output is a draft is about not passing it off as an original: a paragraph an engine wrote is
              still worth reading, and a reader who cannot tell it from the author's own words is the one
              actually harmed. Two separate notes, because they are two separate facts — this was
              translated by a machine, and/or your language was not available at all. */}
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
        </>
      ) : loadError ? (
        /* "The read failed" and "nobody has written one" render differently now. Before SDK 0.9.0 they
           could not: absence *was* a rejection, so every plugin caught the lot and showed one empty state
           for a 404, a 403, a 500 and a dropped connection alike. */
        <p className="error" role="status">
          <Icon name="warning" />
          {i18n.t(loadError.key)}
          {loadError.detail && <span className="detail">{loadError.detail}</span>}
        </p>
      ) : (
        <p className="empty">{i18n.t('noHighlight')}</p>
      )}

      {/* The site's shared tag vocabulary (SDK 0.9.0, ARCHITECTURE §6.1.1) — the backend mirrors an
          episode's tags onto this highlight's own subject, and this is where they surface. Renders nothing
          at all when the manifest declares no `tags` block, when there is no highlight to describe, or
          behind the spoiler gate. */}
      {isEpisode && !spoilerHidden && hasText && highlight && (
        <HighlightTags ctx={ctx} i18n={i18n} slug={ctx.scope.id} />
      )}

      {/* ctx.users (SDK 0.13.0, §8.8). Renders nothing at all when the manifest declares no `identity`
          block, when the highlight predates 2.15.0 and has no `authorId`, or behind the spoiler gate. */}
      {!spoilerHidden && hasText && highlight && (
        <Byline i18n={i18n} authorId={highlight.authorId} authors={authors} />
      )}

      {/* ctx.links.episode (0.8.0). The deep-link view renders an episode's highlight on *this plugin's*
          page, where there is no player and `ctx.player.seekTo` would have nothing to seek — so the way
          out is a link to core's own episode page. `?t=` is the host's timestamp deep link: it seeks the
          player on arrival and beats the listener's stored position for that navigation without
          overwriting it, which turns the podcaster's key moment into a shareable entry point.

          A plain `href`, deliberately: `route.navigate` is namespace-confined and *cannot* name a core
          route, and producing a link is not navigating — the visitor still clicks. Before 0.8.0 this
          meant hardcoding `/episodes/${slug}` and breaking whenever the host changed a route. */}
      {inDeepLink && hasText && highlight && (
        <p className="listen">
          <a
            href={ctx.links.episode(
              deepLinkSlug,
              highlight.momentSeconds != null ? { t: highlight.momentSeconds } : undefined,
            )}
          >
            <Icon name="play" />
            {highlight.momentSeconds != null
              ? i18n.t('listen.at', { time: i18n.duration(highlight.momentSeconds) })
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
            <Icon name="play" />
            {i18n.t('moment.jump', { time: i18n.duration(highlight.momentSeconds) })}
          </button>
          {playerTime >= highlight.momentSeconds && (
            <span className="passed">
              <Icon name="check" />
              {i18n.t('moment.passed')}
            </span>
          )}
        </div>
      )}

      {isEpisode && !spoilerHidden && hasText && highlight && (
        <div className="fav">
          {ctx.user ? (
            <button
              type="button"
              className={favourite ? 'favOn' : 'secondary'}
              aria-pressed={favourite}
              onClick={toggleFavourite}
            >
              {/* The one icon here that carries *state*: filled when this visitor has marked it, outline
                  when they have not. It still never carries the state alone — `aria-pressed` above is
                  what a screen reader announces, and the label changes too. */}
              <Icon name={favourite ? 'star-on' : 'star'} />
              {favourite ? i18n.t('fav.on') : i18n.t('fav.off')}
            </button>
          ) : (
            <span className="favHint">{i18n.t('fav.anonymous')}</span>
          )}
          {/* i18n.plural (SDK 0.9.0). A catalog could not express "1 visitor" / "5 visitors" at all, so
              this used to be one string with a `{{count}}` in it and an English-shaped assumption baked
              into the wording. `plural` picks the CLDR category the *active* locale needs — which is two
              forms in en/de and up to six elsewhere — and interpolates `count` itself. */}
          {favouriteCount != null && favouriteCount > 0 && (
            <span className="favCount">{i18n.plural('fav.count', favouriteCount)}</span>
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
          {/* i18n.n for the two bare counts: locale-correct grouping, so a site with 1 200 episodes reads
              "1.200" in `de` and "1,200" in `en` rather than whatever `String(n)` produces. */}
          {i18n.t('stat', {
            highlighted: i18n.n(stats.highlightedEpisodes),
            total: i18n.n(stats.totalEpisodes),
          })}
          {stats.episodesWithMoment > 0 && ` ${i18n.plural('stat.withMoment', stats.episodesWithMoment)}`}
          {stats.totalFavourites > 0 && ` ${i18n.plural('stat.favourites', stats.totalFavourites)}`}
          {/* Only where there is more than one content language to be translated *into*. On a
              single-language site the figure is either zero or every highlight, and both are noise. */}
          {ctx.locale.content().length > 1 && stats.fullyTranslated > 0 &&
            ` ${i18n.plural('stat.translated', stats.fullyTranslated)}`}
        </p>
      )}

      {/* Stranded text, and podcasters only — a visitor can neither see the affected prose nor do anything
          about it, and the sidebar's admin panel is where the language lists that caused it are shown. */}
      {isSite && !inDeepLink && canEdit && stats && stats.strandedTranslations > 0 && (
        <p className="stat">
          <Icon name="warning" />
          {i18n.plural('stat.stranded', stats.strandedTranslations)}
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
                {/* `share-out` — the shell's own "this leaves here" mark. The two links in this row
                    differ in exactly that way, so they are marked differently: the title above stays in
                    the plugin's subtree, this one hands the visitor to core. */}
                <a className="episodeLink" href={ctx.links.episode(slug)}>
                  <Icon name="share-out" />
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
            ${ICON_CSS}
            /* The modal is portalled into its *own* shadow root (see HighlightModal), so the icon rules
               above have to be repeated here — a shadow root inherits custom properties from the host
               document but not stylesheets from a sibling. The --mc-icon-* values themselves still
               arrive from :root either way, which is the whole point of shipping artwork as tokens. */
            button, .imageField .quota, .imageField .uploadError {
              display: inline-flex; align-items: center; gap: 0.35rem;
            }
            /* The refusal is the one message here that wraps — the host's 415 names the type it sniffed,
               which runs to two lines in a modal this width. Centring an icon against a two-line block
               floats it into the gutter between the lines, so this one aligns to the first line instead
               and nudges down by the difference between the 1em box and the text's cap height. */
            .imageField .uploadError { align-items: flex-start; }
            .imageField .uploadError .mc-icon { margin-top: 0.15em; }
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
              {/* One control for every content language the site authors in (SDK 0.10.0/0.11.0), which on
                  a single-language site renders as exactly the bare textarea it replaced. The tabs come
                  from `ctx.locale.content()` and never from `available()` — see TranslationEditor for why
                  that distinction is the whole point of there being two lists. */}
              <TranslationEditor
                ctx={ctx}
                i18n={i18n}
                markdown={draft}
                onMarkdownChange={setDraft}
                translations={draftTranslations}
                onTranslationsChange={setDraftTranslations}
                textareaRef={focusOnMount}
                // Episode scope only — the backend's drafting pass walks `feeds().episodesIn(site)`, and
                // nothing in the contract enumerates feeds, so a feed-scope highlight has no drafts to
                // offer. Site scope has none either: `docTarget` there is the site singleton, which the
                // pass does not visit.
                draftTarget={isEpisode ? docTarget : undefined}
              />
              {/* ctx.blobs upload. Absent entirely when the operator refused the manifest block, and at
                  feed scope — see `canAttachImage`. Either way a text-only editor beats a control that
                  cannot work or whose result the backend would later delete. */}
              {canAttachImage && blobs && (
                <div className="imageField">
                  <label className="field">
                    <Icon name="image" />
                    {i18n.t('image.label')}
                    <input
                      type="file"
                      // Types *and* extensions, for the same reason `declaredType` exists: a browser
                      // filters this picker with the platform's MIME database, so where that lookup
                      // fails the type half matches nothing and the file the podcaster wants is greyed
                      // out. The extension half is what they can still pick with.
                      accept="image/png,image/jpeg,image/webp,.png,.jpg,.jpeg,.jfif,.webp"
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
                      {/* i18n.bytes (SDK 0.9.0) replaces this plugin's own formatter, which hardcoded `.`
                          as the decimal separator and was therefore simply wrong in `de`. Decimal units,
                          so the number agrees with what the podcaster's own file manager showed them. */}
                      {i18n.t('image.quota', {
                        remaining: i18n.bytes(quota.quotaBytes - quota.usedBytes),
                        max: i18n.bytes(quota.maxFileBytes),
                      })}
                    </p>
                  )}
                  {uploading && (
                    <p className="quota">
                      <Icon name="upload" />
                      {i18n.t('image.uploading')}
                    </p>
                  )}
                  {/* The refusal reaches the person, not only ctx.log — see handlePickImage. */}
                  {uploadError && (
                    <p className="uploadError" role="alert">
                      <Icon name="warning" />
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
                        <Icon name="delete" />
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
              {/* The write failed, and the modal stayed open to say so — see handleSave. The host's
                  `problem.detail` is core's own wording and cannot be translated, so it trails the
                  translated line rather than replacing it. */}
              {writeError && (
                <p className="uploadError" role="alert">
                  <Icon name="warning" />
                  <span>
                    {i18n.t(writeError.key)}
                    {writeError.detail && ` ${writeError.detail}`}
                  </span>
                </p>
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
                      <Icon name="delete" />
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
                        <Icon name="delete" />
                        {i18n.t('remove')}
                      </button>
                    )}
                    <span className="spacer" />
                    <button type="button" className="secondary" onClick={() => setModalOpen(false)} disabled={saving}>
                      {i18n.t('cancel')}
                    </button>
                    <button type="button" onClick={handleSave} disabled={saving}>
                      <Icon name="save" />
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
