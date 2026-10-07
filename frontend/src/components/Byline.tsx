// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 The Mosaicast Authors

import { useEffect, useState } from 'react';
import type { PluginContext, PluginI18n, UserRef } from '@mosaicast/plugin-sdk';
import { FallbackImg } from '../images';

/**
 * Who wrote a highlight, resolved from a UUID at render (SDK 0.13.0, `ctx.users`, ARCHITECTURE §8.8).
 *
 * ## Why a lookup exists at all
 *
 * A plugin that aggregates across people reads `OwnedDocEntry(userId, …)` on the backend and gets UUIDs and
 * nothing else, so a leaderboard had ids and no way to draw a person. The two workarounds were both wrong:
 * copy display names into the plugin's own store — where they outlive the rename meant to shed them and the
 * erasure meant to end them, because core provisioned that storage without ever learning which field holds a
 * person — or show raw UUIDs. §8.8 fills the gap with a **lookup rather than a wider `ctx.user`**: the host
 * still resolves access, and what a plugin learns about somebody else stays exactly a name, an avatar path
 * and a role.
 *
 * ## The three rules this file exists to demonstrate
 *
 * 1. **Store the UUID, resolve at render.** {@link HighlightDoc.authorId} is an id and never a name, which
 *    is also why a rename shows up here on the next paint rather than the next time somebody edits the text.
 * 2. **Absent, not redacted.** An id that is unknown, erased or pseudonymised (§12.8) is *missing* from
 *    `resolve`'s result — no `null` element, no tombstone. The array is therefore **not index-aligned** with
 *    what was asked and may be shorter, so {@link useAuthors} keys a `Map` on `UserRef.id` and every lookup
 *    goes through it. Matching on position is the bug this shape is built to make visible: it would silently
 *    attribute one person's highlight to another the moment a single author deleted their account.
 * 3. **It resolves, it does not enumerate.** There is no list call and there will not be one. The only ids
 *    that reach {@link useAuthors} are ones this plugin already holds in its own documents.
 *
 * `avatarUrl` needs no fallback: every user has one — the host generates it from the UUID when there is no
 * provider picture (§8.7) — and it is always the host's own `/api/users/{id}/avatar`, never a provider URL,
 * because the host proxies the bytes rather than redirecting. So a Discord snowflake never reaches the page
 * source, which is the whole reason a picture can be handed to a plugin at all.
 *
 * Renders **nothing** when `ctx.users` is `null` — any install whose manifest declares no `identity` block,
 * the same shape `ctx.tags`, `ctx.schema` and `ctx.blobs` have.
 */
export function Byline({
  i18n,
  authorId,
  authors,
}: {
  i18n: PluginI18n;
  /** The stored UUID, or undefined for a highlight written before 2.15.0. */
  authorId?: string;
  /** What {@link useAuthors} resolved, or `null` when there is no `identity` block to resolve through. */
  authors: Map<string, UserRef> | null;
}) {
  if (!authors || !authorId) return null;

  const who = authors.get(authorId);

  return (
    <p className="byline">
      <style>{`
        .byline { margin-top: 0.5rem; display: flex; align-items: center; gap: 0.4rem;
          font-size: 0.8rem; color: var(--mc-text-muted); }
        .byline img { width: 1.4rem; height: 1.4rem; border-radius: 999px; object-fit: cover;
          background: var(--mc-surface-2); }
        .byline .former { font-style: italic; }
      `}</style>
      {who ? (
        <>
          {/* No lazy loading and no dimensions to guess: the host serves a small square from its own
              origin, so this is one same-origin request that needs no CSP widening and no consent
              category — the picture is the host's, not a third party's. */}
          {/* Decoration beside the name, so a failed load simply goes (#49). */}
          <FallbackImg src={who.avatarUrl} alt="" width={22} height={22} />
          <span>{i18n.t('byline.by', { name: who.displayName })}</span>
        </>
      ) : (
        // The author is gone — erased, pseudonymised, or an id this install has never heard of. The
        // highlight stays and the person becomes a placeholder, which is precisely the property §8.8 was
        // written to give an aggregate: the work outlives its author without the plugin having to keep a
        // copy of their name to make that possible.
        <span className="former">{i18n.t('byline.former')}</span>
      )}
    </p>
  );
}

/**
 * Resolves a set of author UUIDs to people in **one** call, keyed by id.
 *
 * One `resolve` per distinct id set, not one per row: `resolve` takes an array precisely so a listing costs
 * a single request no matter how long it is, and duplicate ids resolve once. The returned `Map` is what
 * makes rule 2 above unavoidable at every call site — there is no index to get wrong.
 *
 * @param ids author ids, in any order and with any number of duplicates; empty is fine and issues no call
 * @returns the resolved people keyed by {@link UserRef.id}, or `null` when the manifest declares no
 *          `identity` block and there is therefore nothing to resolve through
 */
export function useAuthors(ctx: PluginContext, ids: string[]): Map<string, UserRef> | null {
  const users = ctx.users;
  const [authors, setAuthors] = useState<Map<string, UserRef>>(new Map());
  // The dependency is the *content* of the list, not its identity: `ids` is rebuilt on every render by the
  // caller's `.map`, so depending on the array itself would re-resolve on every paint.
  const key = [...new Set(ids)].sort().join(',');

  useEffect(() => {
    if (!users || key === '') {
      setAuthors(new Map());
      return;
    }
    let live = true;
    users
      .resolve(key.split(','))
      .then((people) => {
        if (live) setAuthors(new Map(people.map((p) => [p.id, p])));
      })
      .catch(() => {
        // A byline is decoration on top of a highlight that reads fine without it, so a failure leaves the
        // map empty and every row falls through to the "former contributor" branch rather than showing an
        // error nobody can act on. Deliberately not `.catch(() => undefined)` on a `get`: this is a real
        // rejection from a real call, not the absent-document answer (a 204 since SDK 0.16.0) that `get`
        // already turns into `null`.
        ctx.log('warn', 'resolving highlight authors failed; bylines will read as former contributors');
      });
    return () => {
      // The host mounts each slot in its own shadow root and unmounts it on navigation; a resolve in flight
      // when that happens must not write into a component that is gone.
      live = false;
    };
  }, [ctx, users, key]);

  return users ? authors : null;
}
