// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 The Mosaicast Authors

import { useEffect, useState } from 'react';
import type { PluginContext, PluginI18n } from '@mosaicast/plugin-sdk';

/**
 * Three tiny widgets, one per service this plugin declares in `plugin.json`'s `consent.services[]` — so a
 * plugin author can see every shape `ctx.consent` takes in one place (ARCHITECTURE §12.5):
 *
 * - `analytics` — a **known** category (the host has a translated label for it in the banner). Gates a
 *   fire-and-forget, cookieless view ping to a third-party endpoint; nothing is rendered either way, so
 *   this demonstrates gating a *side effect*, not just markup.
 * - `functional` — also **known**. Gates a visible `<img>` pulled from a declared service host; before
 *   consent, a click-to-load button calls `consent.request('functional')` — this is the plugin's one
 *   full, real usage of the 0.4.0 `request()`/`granted()`/`onChange()` flow.
 * - `social` — an **unknown/custom** category: the host has no translated label for it and just passes it
 *   through verbatim (per `ConsentService.KNOWN_CATEGORIES` on the core side). Proves a plugin is not
 *   limited to the host's known vocabulary.
 *
 * `consent.onChange` IS wired here (unlike a pre-0.4.0 version of this file, which skipped it): consent
 * can be withdrawn — or granted from elsewhere, e.g. another plugin tile's `request()` for the same
 * category — mid-session from the host's settings page, and only `onChange` tells this component to
 * re-read `consent.has(...)`.
 */

const ANALYTICS_ENDPOINT = 'https://plausible.example/api/event';
const FUNCTIONAL_BADGE_SRC = 'https://cdn.example.com/highlight-badge.svg';
const SOCIAL_WIDGET_SRC = 'https://share.example.com/badge.svg';

/** Fire-and-forget cookieless ping. Errors are swallowed: a blocked/failed beacon must never affect UI. */
function pingAnalytics(): void {
  fetch(ANALYTICS_ENDPOINT, { method: 'POST', keepalive: true }).catch(() => {
    // Intentionally ignored — an analytics beacon is best-effort by definition.
  });
}

export function ConsentExtras({
  consent,
  log,
  i18n,
}: {
  consent: PluginContext['consent'];
  log: PluginContext['log'];
  i18n: PluginI18n;
}) {
  // Forces a re-render on any consent change (a withdrawal, or a grant made from elsewhere) so the
  // `has()`/`granted()` reads below always reflect the current decision rather than a stale render.
  const [, forceRerender] = useState(0);
  useEffect(() => consent.onChange(() => forceRerender((n) => n + 1)), [consent]);

  const analyticsAllowed = consent.has('analytics');
  const functionalAllowed = consent.has('functional');
  const socialAllowed = consent.has('social');

  useEffect(() => {
    if (analyticsAllowed) pingAnalytics();
  }, [analyticsAllowed]);

  async function requestAndLog(category: string) {
    log('info', `consent: requesting "${category}"`);
    const granted = await consent.request(category);
    log('info', `consent: "${category}" ${granted ? 'granted' : 'denied'}`);
    // Belt-and-braces: also react locally rather than rely solely on onChange's timing relative to this
    // promise resolving.
    forceRerender((n) => n + 1);
  }

  return (
    <div className="extras">
      <style>{`
        .extras { margin-top: 0.75rem; padding-top: 0.5rem; border-top: 1px dashed var(--mc-border); display: flex; flex-direction: column; gap: 0.4rem; }
        .extras p { margin: 0; font-size: 0.75rem; color: var(--mc-text-muted); }
        .extras img.badge { max-height: 1.5rem; display: block; }
        .extras button.secondary { font-size: 0.75rem; padding: 0.2rem 0.5rem; }
      `}</style>
      <p className="summary">
        {i18n.t('consent.summary', { granted: consent.granted().join(', ') || i18n.t('consent.none') })}
      </p>
      <p className="analytics">
        {analyticsAllowed ? (
          i18n.t('consent.analytics.granted')
        ) : (
          <button type="button" className="secondary" onClick={() => requestAndLog('analytics')}>
            {i18n.t('consent.analytics.request')}
          </button>
        )}
      </p>
      {functionalAllowed ? (
        <img className="badge" src={FUNCTIONAL_BADGE_SRC} alt={i18n.t('consent.functional.alt')} />
      ) : (
        <button type="button" className="secondary" onClick={() => requestAndLog('functional')}>
          {i18n.t('consent.functional.request')}
        </button>
      )}
      {socialAllowed ? (
        <img className="badge" src={SOCIAL_WIDGET_SRC} alt={i18n.t('consent.social.alt')} />
      ) : (
        <button type="button" className="secondary" onClick={() => requestAndLog('social')}>
          {i18n.t('consent.social.request')}
        </button>
      )}
    </div>
  );
}
