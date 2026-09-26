// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 The Mosaicast Authors

import { useEffect, useState } from 'react';
import type { PluginContext, PluginI18n, TagInfo } from '@mosaicast/plugin-sdk';
import { Icon } from '../icons';

/**
 * The tags on one highlight, and what else on the site shares them (SDK 0.9.0, ARCHITECTURE §6.1.1).
 *
 * ## Why the vocabulary is shared, and what that changes
 *
 * Tags existed in core only as a feed-derived filter axis with no vocabulary and no plugin surface. So a
 * plugin that wanted them grew a private free-text column — and a wiki's `lore` and an episode's `lore`
 * became unrelated strings that could not be linked, suggested or counted together. `ctx.tags` is one
 * vocabulary several writers share, each assignment carrying its source (`feed`, `manual`, `plugin:<id>`).
 *
 * This plugin's backend mirrors an episode's tags onto its own **subject** (`highlight:<slug>`) on every
 * recompute; this component reads them back and links each one to the host's own filtered feed view. That
 * round trip is the whole demonstration: a word a podcaster typed into their feed reaches a plugin's page,
 * and clicking it lands on core's rendering of the same word rather than on something this plugin invented.
 *
 * ## Three rules from §6.1.1 that are visible in this file
 *
 * 1. **Display the label, compare on the key.** The host canonicalises (trim, collapse whitespace,
 *    casefold) and keeps `label` from first use, so `Maritime` and `maritime ` are one tag whose *readable*
 *    form is still `Maritime`. Rendering `tag` instead would lower-case what the visitor reads and undo the
 *    point of storing a label at all.
 * 2. **The two counts are scoped differently.** `TagInfo.episodes` is site-wide; `TagInfo.subjects` counts
 *    only *this plugin's* subjects, because you cannot see the size of a store you cannot read. Showing
 *    them side by side without saying so would read as an inconsistency, so this shows one.
 * 3. **`similarTo` is advice, not a score.** The ranking is the host's and explicitly not part of the
 *    contract, so this renders the order and never the numbers behind it.
 *
 * Renders **nothing** when `ctx.tags` is `null` — which is any install whose manifest declares no `tags`
 * block, the same shape `ctx.schema` and `ctx.blobs` have. TypeScript makes you check.
 */
export function HighlightTags({
  ctx,
  i18n,
  slug,
  showRelated = false,
}: {
  ctx: PluginContext;
  i18n: PluginI18n;
  /** The episode whose highlight this describes; the subject key is derived from it. */
  slug: string;
  /** Whether to draw the "related tags" row, which costs one extra request. Off on list views. */
  showRelated?: boolean;
}) {
  const tags = ctx.tags;
  const [own, setOwn] = useState<string[]>([]);
  const [vocabulary, setVocabulary] = useState<TagInfo[]>([]);
  const [related, setRelated] = useState<TagInfo[]>([]);

  useEffect(() => {
    if (!tags) return;
    // Two reads, not one per tag: `tagsOnSubject` gives the canonical keys on this highlight and `all`
    // gives the vocabulary those keys index into. Resolving a label per tag would be a request per row.
    Promise.all([tags.tagsOnSubject(subjectKeyFor(slug)), tags.all()])
      .then(([mine, all]) => {
        setOwn(mine);
        setVocabulary(all);
      })
      .catch(() => {
        // Tags are an enhancement on top of a highlight that renders fine without them. Nothing here is
        // worth an error state in front of a visitor, so the row simply does not appear.
        ctx.log('warn', `tags unavailable for ${slug}`);
      });
  }, [ctx, tags, slug]);

  useEffect(() => {
    if (!tags || !showRelated || own.length === 0) return;
    tags
      .similarTo(own[0], RELATED_LIMIT)
      .then((found) => setRelated(found.filter((t) => !own.includes(t.tag))))
      .catch(() => ctx.log('warn', 'related tags unavailable'));
  }, [ctx, tags, showRelated, own]);

  if (!tags || own.length === 0) return null;

  const byKey = new Map(vocabulary.map((t) => [t.tag, t]));

  return (
    <div className="tags">
      <style>{`
        .tags { margin-top: 0.5rem; display: flex; flex-wrap: wrap; align-items: center; gap: 0.35rem;
          font-size: 0.8rem; }
        .tags .tagsLabel { color: var(--mc-text-muted); display: inline-flex; align-items: center;
          gap: 0.25rem; }
        .tags a { display: inline-flex; align-items: center; gap: 0.25rem; padding: 0.1rem 0.45rem;
          border: 1px solid var(--mc-border); border-radius: 999px; color: var(--mc-accent-text);
          text-decoration: none; }
        .tags a:hover { border-color: var(--mc-accent); }
        .tags .count { color: var(--mc-text-muted); font-size: 0.75rem; }
        .tags .related { color: var(--mc-text-muted); }
        .tags .related a { border-style: dashed; }
      `}</style>

      <span className="tagsLabel">
        <Icon name="tag" />
        {i18n.t('tags.label')}
      </span>

      {own.map((key) => {
        const info = byKey.get(key);
        return (
          // ctx.links.feed with the host's own `tag` filter axis (§6.1). A plugin consumes filter axes and
          // never defines them, so the destination is core's feed view, not a listing of this plugin's own.
          // A real href, because the visitor is leaving this plugin's subtree — `route.navigate` cannot
          // name a core route, and producing a link is not navigating.
          <a key={key} href={ctx.links.feed(ctx.scope.id, { tag: key })} title={i18n.t('tags.browse')}>
            {/* The label, never the key: casefolding is the host's storage concern, not the reader's. */}
            {info?.label ?? key}
            {info && info.episodes > 0 && (
              // Site-wide, and said so in the copy — `info.subjects` would be this plugin's own count and
              // the two are not comparable.
              <span className="count">{i18n.n(info.episodes)}</span>
            )}
          </a>
        );
      })}

      {related.length > 0 && (
        <span className="related">
          {i18n.t('tags.related')}
          {related.map((t) => (
            <a key={t.tag} href={ctx.links.feed(ctx.scope.id, { tag: t.tag })}>
              {t.label}
            </a>
          ))}
        </span>
      )}
    </div>
  );
}

/**
 * The subject key this plugin's backend tags — `highlight:<episodeSlug>`.
 *
 * Opaque to the host and this plugin's to invent, the same namespacing property `ctx.schema` has for tables
 * and `ctx.route.navigate` has for URLs. It must match `SamplePlugin.SUBJECT_KEY_PREFIX` exactly: the two
 * halves of one plugin naming the same object differently is how a tag and a search hit end up describing
 * two things that are one thing.
 */
export function subjectKeyFor(slug: string): string {
  return `highlight:${slug}`;
}

/** How many related tags to offer. The host clamps rather than failing, so this is a display choice. */
const RELATED_LIMIT = 4;
