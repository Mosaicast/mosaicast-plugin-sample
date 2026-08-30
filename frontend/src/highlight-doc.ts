// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 The Mosaicast Authors

/**
 * The stored shape of a highlight and the helpers both Web Components need — shared so the compact
 * `card` element and the full `main`/`feed`/`site` element cannot drift apart on the doc key, the path
 * encoding, or the timestamp format.
 */

import { SELF_SCOPE_ID } from '@mosaicast/plugin-sdk';

/**
 * A podcaster-uploaded image attached to a highlight (SDK 0.8.0, `ctx.blobs`).
 *
 * **`ref` is the identity, and the only thing stored.** The URL is derived from it by
 * `ctx.blobs.urlFor(ref)` at render time; the host is entitled to change how it shapes those URLs and is
 * not entitled to invalidate what a plugin wrote down. Persisting a URL trades a stable identifier for
 * one that silently rots.
 */
export interface HighlightImage {
  /** The host-assigned blob id. Opaque — never parsed, never constructed, never a URL. */
  ref: string;
  /** Alt text the podcaster typed. Empty means decorative, which is a claim only they can make. */
  alt: string;
}

/** One highlight, as written to `data/{scopeType}/{scopeId}/highlight` by the edit modal. */
export interface HighlightDoc {
  markdown: string;
  /** Optional playback position (seconds) this highlight refers to; episode scope only — `ctx.player`. */
  momentSeconds?: number;
  /** Podcaster opt-in: hide this highlight behind a reveal gate until `ctx.progress` shows listening has started. */
  spoiler?: boolean;
  /** Optional uploaded image (SDK 0.8.0). Absent for a text-only highlight, and for any install whose
   *  operator refused this plugin's `blobs` block — see {@link HighlightImage}. */
  image?: HighlightImage;
}

/**
 * Doc-store path for a scope's highlight.
 *
 * The id is percent-encoded because it can reach us from the URL (`ctx.route.path` on the deep-link
 * view): an unencoded `..` would be normalized away by the browser and point the request at a different
 * doc. The key itself stays literal — `DocStore.KEY_PATTERN` forbids `/`, so it is always one segment.
 */
export function highlightDocPath(scopeType: string, scopeId: string): string {
  return `data/${scopeType}/${encodeURIComponent(scopeId)}/highlight`;
}

/** How many visitors have favourited an episode's highlight — written by the backend's scheduled rollup. */
export interface FavouriteCount {
  count: number;
}

/**
 * Doc-store path for **this visitor's own** favourite mark on an episode (SDK 0.5.0).
 *
 * The scope type is `user` and the id is the literal `me` ({@link SELF_SCOPE_ID}) — a
 * `DataScopeType`, not a slot `Scope`: there is no user page, so `ctx.scope` stays whatever page this
 * component is mounted on while the *storage* address is the caller's own partition. The host resolves
 * `me` from the session, answers **400** to any other user id rather than substituting silently, and
 * **401** when nobody is signed in. So this path cannot be pointed at another visitor's data, which is
 * the whole reason the episode moved out of the scope and into the key.
 *
 * The key is *not* percent-encoded: `DocStore.KEY_PATTERN` (`[A-Za-z0-9._:-]`) has no room for a `%`, and
 * an episode slug never needs one. Callers pass the host-supplied `ctx.scope.id`, never a URL segment.
 */
export function favouriteDocPath(episodeSlug: string): string {
  return `data/user/${SELF_SCOPE_ID}/fav:${episodeSlug}`;
}

/**
 * Doc-store path for an episode's **published** favourite count — a shared doc the backend writes from
 * `queryAcrossUsers`, since no browser can count partitions it cannot address.
 */
export function favouriteCountPath(episodeSlug: string): string {
  return `data/episode/${encodeURIComponent(episodeSlug)}/favourites`;
}

/**
 * The image types this plugin's manifest declares, keyed by the file extension a browser might not
 * recognise on its own. Kept beside {@link declaredType} rather than inline, because the manifest's
 * `blobs.mimeTypes` and the editor's `accept` attribute have to agree with it.
 */
const EXTENSION_TYPES: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  jfif: 'image/jpeg',
  webp: 'image/webp',
};

/**
 * Returns `file` with a usable MIME type, deriving one from its extension when the browser supplied none.
 *
 * **Why this exists — a real cross-browser failure, not a hypothetical.** `File.type` is not filled in
 * the same way everywhere: Chromium carries its own extension→type table, while Firefox asks the
 * *operating system*'s MIME database. Where that lookup fails — a sparse `shared-mime-info` on Linux, a
 * missing or hijacked registry association on Windows, an extension the platform simply doesn't know —
 * Firefox hands over `File.type === ''`. `FormData` then sends the part as `application/octet-stream`,
 * and the host refuses on the **declared** type before it ever looks at the bytes (ARCHITECTURE §11.1:
 * size, declared type, actual type, quota — in that order). The result is a valid PNG rejected as
 * "not one this plugin may store", in one browser only, for a file that works in the other.
 *
 * **Why guessing is safe here, and would not be safe anywhere else.** This does not decide what the file
 * *is* — the host still sniffs the leading bytes and refuses anything whose content disagrees with the
 * declared type. A wrong guess therefore turns into the same 415 it would have been, never into a stored
 * file of the wrong kind. This only restores the claim the browser was supposed to make; the host remains
 * the only thing that decides whether it was true.
 *
 * An extension nothing maps is passed through untouched, so the refusal comes from the host with its own
 * wording rather than from a guess this plugin invented.
 *
 * @param file the file straight from an `<input type="file">`
 * @returns the same file when it already carries a type, otherwise a retyped copy
 */
export function declaredType(file: File): File {
  if (file.type && file.type !== 'application/octet-stream') return file;
  const extension = file.name.includes('.') ? file.name.split('.').pop()!.toLowerCase() : '';
  const mime = EXTENSION_TYPES[extension];
  return mime ? new File([file], file.name, { type: mime, lastModified: file.lastModified }) : file;
}

/** `90` -> `"1:30"`. Negative input floors to `0:00`, matching the clamp the edit modal applies on save. */
export function formatTime(totalSeconds: number): string {
  const seconds = Math.max(0, Math.round(totalSeconds));
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  return `${minutes}:${String(rest).padStart(2, '0')}`;
}

/**
 * `5242880` -> `"5 MB"`. For showing a `BlobQuota` to a podcaster deciding whether a file will fit.
 *
 * Decimal units, because that is what a file manager shows them; a remaining-space hint that disagrees
 * with the number beside the file they are looking at is worse than no hint. Clamps at zero — a quota
 * already exceeded should read `0 B`, not a negative.
 */
export function formatBytes(bytes: number): string {
  const value = Math.max(0, bytes);
  if (value < 1000) return `${Math.round(value)} B`;
  const units = ['kB', 'MB', 'GB'];
  let scaled = value / 1000;
  let unit = 0;
  while (scaled >= 1000 && unit < units.length - 1) {
    scaled /= 1000;
    unit += 1;
  }
  // One decimal below 10 (`1.4 MB` is useful), none above (`268 MB` beats `268.4 MB` for a ceiling).
  return `${scaled < 10 ? scaled.toFixed(1) : Math.round(scaled)} ${units[unit]}`;
}
