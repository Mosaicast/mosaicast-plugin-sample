// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 The Mosaicast Authors

/**
 * Turning a rejected host call into something worth putting in front of a person (SDK 0.9.0).
 *
 * ## The thing this replaced
 *
 * Every call site in this plugin used to end `.catch(() => undefined)`. That was not laziness — it was the
 * only thing available. `ctx.api.get` rejects on **any** non-2xx, and 404 is the *ordinary* state of a
 * doc-store key nothing has written yet, so a plugin either swallowed the rejection or rendered an error
 * on every empty tile. Swallowing it also swallowed the 500, the 403 from the read floor and the network
 * failure, and reported all four to the visitor as a blank widget.
 *
 * 0.9.0 fixed both ends. `getOrNull` (and `ctx.docs.get`) make **absence an answer**, so the `catch` that
 * remains is a real error path; and the rejection now carries the HTTP `status` and the host's RFC 7807
 * `problem` body, so that path can say something true.
 *
 * ## Why the guard is structural
 *
 * {@link isPluginApiError} tests the *shape* — an `Error` carrying a numeric `status` — rather than using
 * `instanceof`. The error is constructed by the host and reaches this bundle across a module boundary, so
 * `instanceof` against this plugin's own copy of a class would answer `false` for a genuine one. This is
 * the sort of failure that only shows up in a real install, never in a test that constructs its own error,
 * which is why the SDK exports the guard rather than leaving it to each plugin.
 */

import { isPluginApiError } from '@mosaicast/plugin-sdk';

/**
 * Which i18n key describes a failed host call, and what to interpolate into it.
 *
 * Deliberately returns a **key**, not a sentence: an error a visitor reads is UI text and belongs in the
 * catalogs like everything else (ARCHITECTURE §12.7). The host's `problem.detail` is the one part that
 * cannot be translated — it is written by core, in core's language — so it is passed through as a
 * parameter and the catalog decides whether to show it.
 *
 * The three cases are the ones the contract genuinely words apart:
 *
 * - **403** — a refusal. The manifest's `readableBy`/`writableBy` floor, or a `backendOwned` key. Both are
 *   things the *plugin author* got wrong, not the visitor, so the detail matters and is shown.
 * - **401** — nobody is signed in. Reachable on any `USER`-scope call; a sign-in prompt is the answer, not
 *   an error.
 * - anything else — a real failure, including the network one that carries no status at all.
 *
 * There is deliberately no `404` case: absence never reaches here. Since SDK 0.16.0 the host answers an
 * unwritten key with **204**, which `ctx.docs.get` and `getOrNull` resolve to `null`; a 404 now means a wrong
 * address, i.e. a genuine bug, and falls into the generic branch.
 */
export function describeApiError(e: unknown): { key: string; detail?: string } {
  if (!isPluginApiError(e)) {
    return { key: 'error.unavailable' };
  }
  if (e.status === 401) {
    return { key: 'error.signedOut' };
  }
  if (e.status === 403) {
    return { key: 'error.refused', detail: e.problem?.detail };
  }
  // Every field of a `problem` body is optional — the host may answer with a bare status, and a plugin that
  // destructures blindly breaks on the day it does.
  return { key: 'error.unavailable', detail: e.problem?.detail };
}

/**
 * The same treatment for a rejected `ctx.translation.translate(...)` (SDK 0.10.0/0.11.0).
 *
 * Separate from {@link describeApiError} because the statuses genuinely mean different things here, and
 * three of them are things a *person* can act on rather than bugs:
 *
 * - **403** — the visitor is below `external.usedBy`. Not a floor the doc store has anything to do with,
 *   and the one status that proves a non-`null` handle is not permission.
 * - **409** — the admin removed the provider between `available()` answering `true` and this call. A race,
 *   not a misconfiguration: retrying will not help, but nothing is broken either.
 * - **429** — the site is over its rate limit. Later will work; now will not.
 * - **503 / 504** — the host is saturated, or the provider did not answer. Both worth retrying, and worth
 *   distinguishing from "your text was refused" so nobody edits a paragraph that was never the problem.
 *
 * A `404` **is** reachable here, unlike in {@link describeApiError}, and it means exactly one thing: this
 * plugin's manifest does not declare `external.kinds: ["translation"]`. The handle should have been `null`
 * and the button should never have rendered, so it is folded into the generic failure rather than given
 * copy of its own — a visitor cannot fix a manifest, and the author will find it in `ctx.log`.
 */
export function describeTranslationError(e: unknown): { key: string; detail?: string } {
  if (!isPluginApiError(e)) {
    return { key: 'i18n.error.unavailable' };
  }
  switch (e.status) {
    case 403:
      return { key: 'i18n.error.refused' };
    case 409:
      return { key: 'i18n.error.noProvider' };
    case 429:
      return { key: 'i18n.error.rateLimited' };
    case 503:
    case 504:
      return { key: 'i18n.error.busy' };
    default:
      return { key: 'i18n.error.unavailable', detail: e.problem?.detail };
  }
}
