// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 The Mosaicast Authors

import { useEffect, useMemo, useState } from 'react';
import type { PluginContext } from '@mosaicast/plugin-sdk';
import { makeI18n } from '../i18n';
import { ICON_CSS, Icon } from '../icons';
import { HIGHLIGHT_KEY, type HighlightDoc } from '../highlight-doc';

/**
 * The plugin's `episode`/`card` slot — the compact one-liner shown on an episode's **feed card**.
 *
 * <p>This is a second, deliberately minimal Web Component rather than a reuse of {@link Highlight}, which
 * is the point of the `card` placement (ARCHITECTURE §7.3): a card is a dense list item repeated once per
 * episode, so a plugin puts a badge there and keeps full rendering for the detail page's `main`. Three
 * consequences a plugin author should copy:
 *
 * <ul>
 *   <li><strong>It never renders the markdown body.</strong> Only a label, and the key moment if there is
 *       one. That also means the `ctx.progress` spoiler gate {@link Highlight} implements is moot here —
 *       there is no content to leak — so a spoiler-marked highlight is announced as such and nothing more.
 *   <li><strong>It renders nothing at all when there is no highlight</strong> (`return null`), instead of
 *       an empty-state line. A feed card belongs to the host, not the plugin; adding a permanent "no
 *       highlight yet" row to every card in the list would be a poor guest.
 *   <li><strong>It makes exactly one request.</strong> Unlike {@link Highlight} it deliberately does not
 *       read the site-wide `settings` doc for the heading override — on a feed page this component mounts
 *       once per episode, so a second fetch each would be N extra round trips for cosmetics.
 * </ul>
 */
export function HighlightCard({ ctx }: { ctx: PluginContext }) {
  const i18n = useMemo(() => makeI18n(ctx.locale), [ctx]);
  const [locale, setLocale] = useState(ctx.locale.current());
  useEffect(() => ctx.locale.onChange(setLocale), [ctx]);
  useEffect(() => () => i18n.dispose(), [i18n]);
  void locale; // re-render on locale change; i18n.t reads the current catalog internally

  const [highlight, setHighlight] = useState<HighlightDoc | null>(null);
  useEffect(() => {
    // `ctx.docs.get` resolves **null** when nothing is stored, so absence is an answer rather than a
    // rejection (SDK 0.9.0). The `.catch(() => undefined)` this used to end with swallowed the 500 and the
    // 403 alongside the 404; here a real failure logs to the host and the card stays away, which is the
    // right outcome for a badge on somebody else's feed list but is now a *decision* rather than an
    // accident.
    ctx.docs
      .get<HighlightDoc>(ctx.scope, HIGHLIGHT_KEY)
      .then(setHighlight)
      .catch((e: unknown) => {
        setHighlight(null);
        ctx.log('warn', `highlight badge unavailable for ${ctx.scope.type} ${ctx.scope.id}`);
        void e;
      });
  }, [ctx]);

  // A doc whose markdown is blank is contentless — the backend prunes those, but this must not badge an
  // episode in the meantime (the same "present != publishable" rule SamplePlugin.publishableHighlight
  // applies to sitemap.xml and the OpenGraph tags).
  if (!highlight?.markdown?.trim()) return null;

  return (
    <span className="card">
      <style>{`
        ${ICON_CSS}
        .card {
          display: inline-flex;
          align-items: center;
          gap: 0.35rem;
          font-size: 0.75rem;
          color: var(--mc-text-muted);
        }
        .card .label { color: var(--mc-accent-text); font-weight: 600; display: inline-flex; align-items: center; gap: 0.25rem; }
        .card .sep { opacity: 0.6; }
      `}</style>
      {/* The badge's mark used to be a literal ✨ in the catalogs. A host icon instead: it is `1em`, so it
          scales with this card's deliberately small type without naming a size, and it re-themes with the
          accent beside it rather than rendering as whatever emoji font the visitor's platform ships. */}
      <span className="label">
        <Icon name="pin" />
        {i18n.t('card.label')}
      </span>
      {highlight.spoiler === true ? (
        <>
          <span className="sep">·</span>
          <span className="spoiler">{i18n.t('card.spoiler')}</span>
        </>
      ) : (
        highlight.momentSeconds != null && (
          <>
            <span className="sep">·</span>
            {/* i18n.duration (SDK 0.9.0) replaces this plugin's own `90 -> "1:30"` helper — and unlike it,
                renders in the active locale's digits. */}
            <span className="moment">{i18n.t('card.moment', { time: i18n.duration(highlight.momentSeconds) })}</span>
          </>
        )
      )}
    </span>
  );
}
