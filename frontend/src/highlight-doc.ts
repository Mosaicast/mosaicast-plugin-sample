// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 The Mosaicast Authors

/**
 * The stored shape of a highlight and the doc-store keys both Web Components need — shared so the compact
 * `card` element and the full `main`/`feed`/`site` element cannot drift apart on where a document lives.
 *
 * ## What used to be here, and where it went (SDK 0.9.0)
 *
 * This module was twice this size. Four things left, and every one of them is a thing the SDK now owns
 * because *every* plugin was writing its own subtly different copy:
 *
 * - **`highlightDocPath` / `favouriteDocPath` / `favouriteCountPath`** — four-segment path strings with the
 *   plugin responsible for `encodeURIComponent`, for the key pattern, and for knowing that `site` is always
 *   `main` and `user` always `me`. {@link DocClient} (`ctx.docs`) does all of that. Only the *keys* are
 *   still this plugin's business, and they are below.
 * - **`declaredType(file)` plus an extension→MIME table** — `blobs.upload` normalises the declared type by
 *   default now (ARCHITECTURE §11.1). See {@link HighlightImage}.
 * - **`formatTime`** — `i18n.duration(seconds)`, which also takes the ISO-8601 duration string a
 *   `DisplaySnapshot` carries, and renders in the active locale's digits.
 * - **`formatBytes`** — `i18n.bytes(n)`, which unlike the hand-rolled version does not hardcode `.` as the
 *   decimal separator, and is therefore not simply wrong in `de`.
 */

import type { LocaleInfo, Scope } from '@mosaicast/plugin-sdk';

/**
 * A podcaster-uploaded image attached to a highlight (SDK 0.8.0, `ctx.blobs`).
 *
 * **`ref` is the identity, and the only thing stored.** The URL is derived from it by
 * `ctx.blobs.urlFor(ref)` at render time; the host is entitled to change how it shapes those URLs and is
 * not entitled to invalidate what a plugin wrote down. Persisting a URL trades a stable identifier for
 * one that silently rots.
 *
 * **Nothing here retypes the file before upload any more.** `blobs.upload(file)` normalises the declared
 * type itself (SDK 0.9.0, ARCHITECTURE §11.1), which retires the real cross-browser failure this plugin
 * used to carry a helper for: Chromium fills `File.type` from its own table while Firefox asks the OS MIME
 * database, and where that lookup fails it hands over `''` — `FormData` then sends
 * `application/octet-stream` and the host refuses on the *declared* type before it sniffs anything, so a
 * valid PNG is rejected in one browser only. Guessing is safe there specifically because the host still
 * reads the bytes, and a wrong guess becomes the same 415 it would have been. Pass
 * `{ declaredType: 'preserve' }` if you ever want the browser's raw value instead.
 */
export interface HighlightImage {
  /** The host-assigned blob id. Opaque — never parsed, never constructed, never a URL. */
  ref: string;
  /** Alt text the podcaster typed. Empty means decorative, which is a claim only they can make. */
  alt: string;
}

/**
 * One highlight's text in a language other than the site default (SDK 0.10.0, `ctx.locale.content()`).
 *
 * **The site default's text is not here** — it stays in {@link HighlightDoc.markdown}, where it has always
 * been. That is not tidiness: every highlight written before 2.13.0 has a `markdown` and no `translations`,
 * and moving the default into the map would have made all of them unreadable. A new field that older
 * documents simply lack costs one `?? {}` and no migration.
 */
export interface HighlightTranslation {
  markdown: string;
  /**
   * Whether a machine wrote this and no human has rewritten it.
   *
   * **Provenance, not a workflow state.** It is stored and it is shown to the *reader*, because someone
   * reading a paragraph is entitled to know a translation engine produced it — the SDK's rule that machine
   * output is a draft is about not passing it off as an original, and clearing the flag on save would do
   * exactly that. The unconfirmed-draft state a podcaster sees in the editor is separate and never stored:
   * it lasts until they press Save, which is the human confirmation.
   *
   * Set by the editor's translate button, and cleared by the podcaster typing into the field — at which
   * point the words are theirs and claiming otherwise would be the same misattribution in reverse.
   */
  machineTranslated?: true;
}

/** One highlight, as written to the {@link HIGHLIGHT_KEY} document of a scope by the edit modal. */
export interface HighlightDoc {
  /** The text in the site's default locale — the last fallback, and the only field older docs have. */
  markdown: string;
  /**
   * The same highlight in the site's other **content** locales, keyed by locale code (SDK 0.10.0).
   *
   * Built from `ctx.locale.content()` and never from `ctx.locale.available()`: a site can require an
   * imprint in Dutch without offering a Dutch UI, so the languages text may be *authored* in are a
   * different list from the ones the shell can *render* in, and an editor built from the wrong one
   * silently refuses the language its operator actually asked for.
   *
   * **These keys are client input.** They live inside a JSON value, so the host's doc-key pattern never
   * sees them and nothing validates them on the way in. Two things keep that harmless, and both are
   * deliberate: {@link resolveHighlightText} only ever *looks up* a code the host handed it, so a forged
   * key is unreachable rather than merely unrendered; and the backend re-checks every key with
   * `Locales.isContentLocale` rather than trusting what a browser wrote.
   */
  translations?: Record<string, HighlightTranslation>;
  /** Optional playback position (seconds) this highlight refers to; episode scope only — `ctx.player`. */
  momentSeconds?: number;
  /** Podcaster opt-in: hide this highlight behind a reveal gate until `ctx.progress` shows listening has started. */
  spoiler?: boolean;
  /** Optional uploaded image (SDK 0.8.0). Absent for a text-only highlight, and for any install whose
   *  operator refused this plugin's `blobs` block — see {@link HighlightImage}. */
  image?: HighlightImage;
  /**
   * The UUID of whoever first wrote this highlight (SDK 0.13.0, `ctx.users`) — absent before 2.15.0.
   *
   * **A UUID and never a name.** A display name copied in here would survive the rename meant to shed it
   * and the erasure meant to end it, and core cannot reach inside a plugin's own documents to repair
   * either — it provisioned this storage without ever learning which field holds a person. So the id is
   * what is stored and {@link Byline} resolves it at render, which is also what makes a rename show up
   * immediately instead of at the next time somebody edits the highlight.
   *
   * **A byline, not an authorization fact.** This is a shared-scope document and a shared-scope document
   * has no owner: anything above the manifest's `data.writableBy` floor could `PUT` any UUID here, exactly
   * as it could rewrite the prose next to it. Nothing is decided on this field. The user ids this plugin
   * genuinely knows to be true are the ones the *host* resolves from a partition — the `fav:` marks the
   * backend reads with `queryAcrossUsers`.
   *
   * Set once, on the first save that has a signed-in author, and preserved by every later edit: it credits
   * whoever wrote the highlight, not whoever last touched it.
   */
  authorId?: string;
}

/**
 * The document key a scope's highlight lives under.
 *
 * A key, not a path. `ctx.docs` takes a {@link DocTarget} and a key and builds the rest, which is what
 * removed the percent-encoding this module used to have to get right: the id is now handled by the client
 * rather than spliced into a template string here.
 */
export const HIGHLIGHT_KEY = 'highlight';

/** How many visitors have favourited an episode's highlight — written by the backend's scheduled rollup. */
export interface FavouriteCount {
  count: number;
}

/**
 * The key of **this visitor's own** favourite mark on an episode, inside their own partition.
 *
 * Read it with `ctx.docs.get('self', favouriteKey(slug))`. **`'self'` is `data/user/me`** — per-user data
 * belongs in the `USER` scope and never in a doc key, because a key is client input while a scope id is
 * resolved from the session. The host answers **400** to any other user id rather than substituting
 * silently, and **401** when nobody is signed in, so this cannot be pointed at another visitor's data.
 *
 * The episode goes in the key here for the opposite reason: a `USER` partition is **flat** — one per
 * person, not one per person *and* episode — so the entity is what the key is for. Note the direction
 * carefully; pre-0.5.0 the advice was the exact inverse (an entity scope with the *user* in the key), which
 * is what made per-user data addressable, and forgeable, by anybody.
 *
 * No percent-encoding: the key pattern (`[A-Za-z0-9._:-]`) has no room for a `%`, an episode slug never
 * needs one, and `ctx.docs` throws at the call site with the pattern in the message if one ever did.
 */
export function favouriteKey(episodeSlug: string): string {
  return `fav:${episodeSlug}`;
}

/** The key of an episode's **published** favourite count, written by the backend from `queryAcrossUsers`. */
export const FAVOURITE_COUNT_KEY = 'favourites';

/**
 * The doc-store partition of one episode, by slug.
 *
 * A trivial helper, kept because the alternative is an object literal at every call site and one of them
 * eventually says `'episodes'`. `ctx.scope` is the target for the scope a component is mounted in; this is
 * for the episodes it reaches *across*, which the page view does constantly.
 *
 * Returns a `Scope` rather than the wider `DocTarget` a `ctx.docs` call accepts: `DocTarget` also admits the
 * `'self'` and `'site'` shorthands, which name singletons and carry no id, so a caller that wants to read
 * `.id` back off the result needs the narrower type.
 */
export function episodeTarget(slug: string): Scope {
  return { type: 'episode', id: slug };
}

/** The doc key holding an episode's backend-drafted translations — see {@link TranslationDrafts}. */
export const DRAFTS_KEY = 'drafts';

/** One machine draft the backend's scheduled pass produced, mirroring `SamplePlugin.TranslationDraft`. */
export interface TranslationDraft {
  locale: string;
  markdown: string;
  /** Which provider produced it, so a podcaster can weigh the suggestion. */
  providerId: string;
  /** {@link javaStringHash} of the source this was translated from. */
  sourceHash: number;
}

/**
 * The backend's machine drafts for one episode, read from `data/episode/<slug>/drafts`.
 *
 * **Never rendered to a reader.** This is the whole reason it is a separate document from the highlight:
 * the contract's rule is that machine output is a draft, and the only way a scheduled job can honour that
 * is to write somewhere a visitor never looks. The edit modal offers these; nothing else reads them.
 *
 * Declared `data.backendOwned`, so a client `PUT` here is a 403. Without that, anyone above `writableBy`
 * could plant a "suggestion" the editor would then offer a podcaster in good faith.
 */
export interface TranslationDrafts {
  drafts: TranslationDraft[];
}

/**
 * `java.lang.String.hashCode`, in TypeScript.
 *
 * Reproduced rather than replaced because the backend already stores one: a draft records the hash of the
 * text it was translated *from*, so the editor can tell a suggestion that still matches the original from
 * one made before the podcaster rewrote it. Offering the second is worse than offering nothing — it is a
 * faithful translation of a paragraph that no longer exists.
 *
 * Java's algorithm and not a better one, because the two sides have to agree and the backend's is fixed by
 * the JDK. `| 0` after each step is what keeps this in Java's 32-bit signed overflow: JavaScript numbers are
 * doubles, so without it the value silently diverges above 2^53 and every draft looks stale.
 *
 * Not a security boundary — a hash collision here costs one wrongly-offered suggestion that the podcaster
 * reads before accepting, which is the same review this whole flow is built around.
 */
export function javaStringHash(s: string): number {
  let hash = 0;
  for (let i = 0; i < s.length; i++) {
    hash = (Math.imul(31, hash) + s.charCodeAt(i)) | 0;
  }
  return hash;
}

/**
 * The site's default content locale — the last fallback for anything stored per language.
 *
 * Read off `ctx.locale.content()` rather than hardcoded, because languages are a **runtime registry** since
 * core 0.6.23: an operator drops a catalog into `MOSAICAST_LOCALES_DIR` and enables it, and a plugin that
 * assumed `en` is simply wrong on a site whose default is `nl`. The list is documented as never empty and
 * as always carrying exactly one default, so the `?? [0] ?? 'en'` tail is belt-and-braces for a host that
 * broke its own contract — not a case this code expects to see.
 *
 * @param locales `ctx.locale.content()`
 * @returns the default locale's code
 */
export function defaultLocaleOf(locales: readonly LocaleInfo[]): string {
  return (locales.find((l) => l.isDefault) ?? locales[0])?.code ?? 'en';
}

/** Which text a reader actually gets, and what to tell them about where it came from. */
export interface ResolvedHighlightText {
  markdown: string;
  /** The locale the returned text is written in — not necessarily the one that was asked for. */
  locale: string;
  /** Whether a machine produced it — see {@link HighlightTranslation.machineTranslated}. */
  machineTranslated: boolean;
  /** Whether the requested language was unavailable and this is the site default standing in for it. */
  fallback: boolean;
}

/**
 * Picks the text to show a reader, given the language their shell is in.
 *
 * **Exact match, then the site default. Nothing in between.** A `pt-br` visitor is *not* quietly served
 * `pt`: negotiating one language code down to another is the host's job (it owns the registry, the
 * catalogs and the `Accept-Language` handling), and a plugin doing its own would answer differently from
 * the shell wrapped around it on the same page. Falling back to the default is not negotiation — it is
 * this document saying it has nothing in that language.
 *
 * **A forged key cannot be reached through here.** The lookup is by a code the host supplied, never by
 * anything read out of the document, so a `translations` map carrying keys a browser invented contributes
 * nothing: they are not merely skipped, there is no path that asks for them. See
 * {@link HighlightDoc.translations}.
 *
 * @param doc           the stored highlight
 * @param uiLocale      `ctx.locale.current()` — the language the shell is rendering in
 * @param defaultLocale the site default, from {@link defaultLocaleOf}
 * @returns the text plus everything the caller needs to caption it
 */
export function resolveHighlightText(
  doc: HighlightDoc,
  uiLocale: string,
  defaultLocale: string,
): ResolvedHighlightText {
  const wanted = uiLocale.toLowerCase();
  const fallbackText = {
    markdown: doc.markdown,
    locale: defaultLocale,
    machineTranslated: false,
    fallback: wanted !== defaultLocale.toLowerCase(),
  };
  if (fallbackText.fallback === false) return { ...fallbackText, fallback: false };

  const translated = doc.translations?.[wanted];
  // A translation whose text is blank is not a translation. The editor cannot produce one — an empty tab
  // is dropped on save — but a document written by an older version, or by hand, can, and showing a
  // visitor an empty tile because their language has an empty string in it is worse than the default.
  if (!translated?.markdown.trim()) return fallbackText;

  return {
    markdown: translated.markdown,
    locale: wanted,
    machineTranslated: translated.machineTranslated === true,
    fallback: false,
  };
}
