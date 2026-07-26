// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 The Mosaicast Authors

import { useCallback, useEffect, useState } from 'react';
import type { PluginContext } from '@mosaicast/plugin-sdk';
import { marked } from 'marked';
import DOMPurify from 'dompurify';
import { makeI18n } from '../i18n';
import { HighlightModal } from './HighlightModal';

interface HighlightDoc {
  markdown: string;
}

interface HighlightStats {
  totalEpisodes: number;
  highlightedEpisodes: number;
}

/** Renders markdown to sanitized HTML — never trust a podcaster-authored string verbatim (ARCHITECTURE §12.6). */
function renderMarkdown(markdown: string): string {
  return DOMPurify.sanitize(marked.parse(markdown, { async: false }) as string);
}

/**
 * The one Web Component behind all three of this plugin's slots (episode/main, feed/feed, site/site).
 * Shows the markdown highlight for `ctx.scope` — or the "no highlight yet" fallback — and, for a
 * podcaster/admin, an Edit button opening a modal to write one. Reads/writes go through `ctx.api`'s
 * generic doc-store surface (`data/{scopeType}/{scopeId}/highlight`), never through a plugin-authored
 * route. The site-scope instance additionally shows the backend's precomputed highlighted-episode count.
 */
export function Highlight({ ctx }: { ctx: PluginContext }) {
  const scopeType = ctx.scope.type;
  const dataPath = `data/${scopeType}/${ctx.scope.id}/highlight`;
  const canEdit = ctx.user?.role === 'podcaster' || ctx.user?.role === 'admin';

  const [locale, setLocale] = useState(ctx.locale.current());
  const i18n = makeI18n(ctx.locale);
  useEffect(() => ctx.locale.onChange(setLocale), [ctx]);
  void locale; // re-render on locale change; i18n.t reads the current catalog internally

  const [highlight, setHighlight] = useState<HighlightDoc | undefined>(undefined);
  const [stats, setStats] = useState<HighlightStats | undefined>(undefined);
  const [modalOpen, setModalOpen] = useState(false);
  const [draft, setDraft] = useState('');
  const [saving, setSaving] = useState(false);

  const loadHighlight = useCallback(() => {
    ctx.api
      .get<HighlightDoc>(dataPath)
      .then(setHighlight)
      .catch(() => setHighlight(undefined));
  }, [ctx, dataPath]);

  useEffect(loadHighlight, [loadHighlight]);

  useEffect(() => {
    if (scopeType !== 'site') return;
    ctx.api
      .get<HighlightStats>('data/site/main/stats')
      .then(setStats)
      .catch(() => setStats(undefined));
  }, [ctx, scopeType]);

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
    setModalOpen(true);
  }

  async function handleSave() {
    setSaving(true);
    try {
      await ctx.api.put(dataPath, { markdown: draft } satisfies HighlightDoc);
      setHighlight({ markdown: draft });
      setModalOpen(false);
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="highlight">
      <style>{`
        .highlight {
          background: var(--mc-surface);
          color: var(--mc-text);
          border: 1px solid var(--mc-border);
          border-radius: 0.5rem;
          padding: 0.75rem 1rem;
          font-family: system-ui, sans-serif;
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
        .stat {
          margin: 0.5rem 0 0;
          font-size: 0.8rem;
          color: var(--mc-text-muted);
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

      <div className="header">
        <span className="title">{i18n.t(`title.${scopeType}`)}</span>
        {canEdit && (
          <button type="button" onClick={openEditor}>
            {i18n.t('edit')}
          </button>
        )}
      </div>

      {highlight?.markdown ? (
        <div className="content" dangerouslySetInnerHTML={{ __html: renderMarkdown(highlight.markdown) }} />
      ) : (
        <p className="empty">{i18n.t('noHighlight')}</p>
      )}

      {scopeType === 'site' && stats && (
        <p className="stat">{i18n.t('stat', { highlighted: stats.highlightedEpisodes, total: stats.totalEpisodes })}</p>
      )}

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
