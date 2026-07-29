// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 The Mosaicast Authors

import { useCallback, useEffect, useMemo, useState } from 'react';
import type { PluginContext } from '@mosaicast/plugin-sdk';
import { marked } from 'marked';
import DOMPurify from 'dompurify';
import { makeI18n } from '../i18n';
import { HighlightModal } from './HighlightModal';
import { ConsentExtras } from './ConsentExtras';
import { FONT_STACKS, SETTINGS_PATH, type SiteSettings } from './AdminSettings';

interface HighlightDoc {
  markdown: string;
  /** Optional playback position (seconds) this highlight refers to; episode scope only — `ctx.player`. */
  momentSeconds?: number;
  /** Podcaster opt-in: hide this highlight behind a reveal gate until `ctx.progress` shows listening has started. */
  spoiler?: boolean;
}

interface HighlightStats {
  totalEpisodes: number;
  highlightedEpisodes: number;
  episodesWithMoment: number;
}

/** The subpath prefix this plugin's deep links use under `/p/sample/` (ARCHITECTURE §6.4). */
const DEEP_LINK_PREFIX = 'highlight/';

/** Renders markdown to sanitized HTML — never trust a podcaster-authored string verbatim (ARCHITECTURE §12.6). */
function renderMarkdown(markdown: string): string {
  return DOMPurify.sanitize(marked.parse(markdown, { async: false }) as string);
}

/** `90` -> `"1:30"`. Used for the `ctx.player` key-moment button and its "played" indicator. */
function formatTime(totalSeconds: number): string {
  const seconds = Math.max(0, Math.round(totalSeconds));
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  return `${minutes}:${String(rest).padStart(2, '0')}`;
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
 *   matches `highlight/<slug>`.
 * - `progress` — an opt-in (`highlight.spoiler`) reveal gate at episode scope.
 * - `episode.status` — an "upcoming episode" badge while `PLANNED`.
 * - `log` — sent on a saved/failed highlight edit, a manual spoiler reveal, a key-moment jump, and every
 *   consent request/grant/deny (inside {@link ConsentExtras}) — real signal from real user actions, not
 *   a demo-only call site.
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

  const dataPath = inDeepLink
    ? `data/episode/${deepLinkSlug}/highlight`
    : `data/${scopeType}/${ctx.scope.id}/highlight`;
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

  useEffect(() => {
    if (!modalOpen) return;
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === 'Escape') setModalOpen(false);
    }
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [modalOpen]);

  function openEditor() {
    setDraft(highlight?.markdown ?? '');
    setDraftMoment(highlight?.momentSeconds != null ? String(highlight.momentSeconds) : '');
    setDraftSpoiler(highlight?.spoiler === true);
    setModalOpen(true);
  }

  async function handleSave() {
    setSaving(true);
    try {
      const momentSeconds = draftMoment.trim() === '' ? NaN : Number(draftMoment);
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
        <a className="back" href="/p/sample/">
          {i18n.t('browse.back')}
        </a>
      )}

      <div className="header">
        <span className="title">{heading}</span>
        {canEdit && (
          <button type="button" onClick={openEditor}>
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

      {(scopeType === 'feed' || (isSite && !inDeepLink)) && season != null && (
        <p className="filterNote">{i18n.t('filter.season', { season })}</p>
      )}

      {isSite && !inDeepLink && stats && (
        <p className="stat">
          {i18n.t('stat', { highlighted: stats.highlightedEpisodes, total: stats.totalEpisodes })}
          {stats.episodesWithMoment > 0 && ` ${i18n.t('stat.withMoment', { count: stats.episodesWithMoment })}`}
        </p>
      )}

      {isSite && !inDeepLink && ctx.episodes.length > 0 && (
        <div className="browse">
          <p className="browseTitle">{i18n.t('browse.title')}</p>
          <ul>
            {ctx.episodes.map((slug) => (
              <li key={slug}>
                <a href={`/p/sample/${DEEP_LINK_PREFIX}${slug}`}>{ctx.episodeLabels?.[slug] ?? slug}</a>
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
              justify-content: flex-end;
              gap: 0.5rem;
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
            <div className="modal" role="dialog" aria-modal="true">
              <h3>{i18n.t(`editTitle.${scopeType}`)}</h3>
              <textarea
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
              <div className="actions">
                <button type="button" className="secondary" onClick={() => setModalOpen(false)} disabled={saving}>
                  {i18n.t('cancel')}
                </button>
                <button type="button" onClick={handleSave} disabled={saving}>
                  {saving ? i18n.t('saving') : i18n.t('save')}
                </button>
              </div>
            </div>
          </div>
        </HighlightModal>
      )}
    </div>
  );
}
