// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 The Mosaicast Authors

import { act } from 'react';
import { flushMockApi, type MockDocClient, type MockPluginContext } from '@mosaicast/plugin-sdk/testing';
import type { DocClient, DocTarget, LocaleInfo, PluginApiError, PluginContext, Role } from '@mosaicast/plugin-sdk';

/**
 * Lets every pending host call settle and the component's `.then(setState)` hops reach the DOM.
 *
 * ## Why this is not `await Promise.resolve()` twice
 *
 * It used to be, and that was a real footgun rather than a stylistic one. The mock client resolves its own
 * promise **before** a component's `.then(setState)` runs, so each `.then` in the chain costs one more
 * microtask hop — and a hand-counted `await Promise.resolve()` covers one hop and not two. The symptom is
 * an assertion that fails *only sometimes*, depending on how many hops the component happens to have that
 * week, which is the worst kind of test failure to debug.
 *
 * {@link flushMockApi} (SDK 0.9.0) waits for the **calls** and then drains the hops behind them, so the
 * count stops being something this file has to guess. Wrapped in `act()` because React needs the state
 * updates it triggers to land inside one.
 *
 * @param ctx the mock context whose `api` recorded the calls; omit for a pure-`ctx.docs` component, where
 *            the microtask drain alone is enough
 */
export async function flush(ctx?: MockPluginContext) {
  await act(async () => {
    if (ctx) await flushMockApi(ctx.api);
    // `ctx.docs` and `ctx.feeds` are separate doubles with no call recorder of their own, so a few plain
    // hops still cover them. Cheap, and unlike the old version it is a *supplement* to a real wait rather
    // than the whole of one.
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
}

/**
 * An error shaped the way the **host** rejects, for testing a component's real error branch.
 *
 * The SDK's `apiError(status)` covers `ctx.api` — drop one into `apiResponses` and the call rejects. There
 * is no equivalent for `ctx.docs`, whose double is an in-memory store rather than a canned-response map,
 * so a test that wants a *failing* doc call builds the rejection itself. This is that.
 *
 * **Structural on purpose.** `isPluginApiError` tests the shape — an `Error` carrying a numeric `status` —
 * rather than `instanceof`, because the real error crosses a bundle boundary from the host and
 * `instanceof` against a plugin's own copy of a class would answer `false` for a genuine one. Which means
 * this plain object is not an approximation of a host error: by the contract's own definition, it *is* one.
 */
export function hostError(status: number, detail?: string): PluginApiError {
  return Object.assign(new Error(`mock host refusal: ${status}`), {
    status,
    problem: detail ? { detail } : undefined,
  });
}

/** The three languages this plugin's tests use, in the shape the host's registry hands over. */
const KNOWN_LOCALES: Record<string, string> = { en: 'English', de: 'Deutsch', nl: 'Nederlands' };

/**
 * A `ctx.locale` override for a site with more than one language (SDK 0.10.0).
 *
 * **The two lists are separate parameters because they are separate facts**, and a helper that took one
 * list would quietly teach the opposite. `available` is what the shell can render in; `content` is what
 * text may be authored in. A site can require a Dutch imprint without offering a Dutch UI, so the
 * interesting test — and the default here — is the one where they *differ*: passing the same list twice
 * would let a component that reads the wrong one pass every test in the suite.
 *
 * `makeMockCtx` defaults both to English alone, which is why an existing test that never mentions
 * languages still exercises the single-locale path where the editor renders a bare textarea.
 *
 * @param uiCodes      locale codes for `available()`
 * @param contentCodes locale codes for `content()`; the **first** is the site default
 * @param current      the locale the shell is currently rendering in; defaults to the first UI code
 */
export function localesOf(
  uiCodes: string[],
  contentCodes: string[],
  current = uiCodes[0],
): PluginContext['locale'] {
  // One site default, carried by whichever entries of either list name it. It is a property of the *site*,
  // not of a list — "the last fallback for anything stored per locale" — so deriving it per-list would let
  // `available()` and `content()` disagree about which language that is, a shape the host cannot produce.
  const siteDefault = contentCodes[0];
  const info = (codes: string[]): LocaleInfo[] =>
    codes.map((code) => ({
      code,
      nativeName: KNOWN_LOCALES[code] ?? code,
      isDefault: code === siteDefault,
    }));
  return {
    current: () => current,
    onChange: () => () => undefined,
    available: () => info(uiCodes),
    content: () => info(contentCodes),
  };
}

/** A doc client that records what it was asked for. See {@link docsRecording}. */
export interface RecordingDocClient extends DocClient {
  /** Every read, as `"<target>/<key>"` — e.g. `"self/fav:ep-1"`, `"episode:ep-1/highlight"`. */
  readonly reads: string[];
}

/**
 * Wraps a doc double so a test can assert a request was **not made**.
 *
 * `MockApiClient` records calls; `MockDocClient` is an in-memory store and records nothing, which is right
 * for asserting what was written and useless for asserting what was never read. The case that needs the
 * latter is real: an anonymous visitor has no `USER` partition, the host answers 401, and the component's
 * job is not to ask in the first place. "It rendered the sign-in hint" does not prove that; only the
 * absence of the call does.
 */
export function docsRecording(docs: MockDocClient): RecordingDocClient {
  const reads: string[] = [];
  const name = (target: DocTarget) => (typeof target === 'string' ? target : `${target.type}:${target.id}`);
  return {
    get: <T>(target: DocTarget, key: string) => {
      reads.push(`${name(target)}/${key}`);
      return docs.get<T>(target, key);
    },
    getMany: docs.getMany.bind(docs),
    put: docs.put.bind(docs),
    list: docs.list.bind(docs),
    remove: docs.remove.bind(docs),
    reads,
  };
}

/**
 * A {@link DocClient} that behaves like {@link MockDocClient} except for one verb, which rejects.
 *
 * Keeps the reads working — a component under test still has to load before it can fail to save — while
 * making exactly the write under test fail.
 */
export function docsFailing(
  docs: MockDocClient,
  verb: 'get' | 'put' | 'remove',
  error: PluginApiError,
): DocClient {
  return {
    get: <T>(target: DocTarget, key: string) =>
      verb === 'get' ? Promise.reject(error) : docs.get<T>(target, key),
    getMany: docs.getMany.bind(docs),
    put: <T>(target: DocTarget, key: string, value: T) =>
      verb === 'put' ? Promise.reject(error) : docs.put<T>(target, key, value),
    list: docs.list.bind(docs),
    remove: (target: DocTarget, key: string) =>
      verb === 'remove' ? Promise.reject(error) : docs.remove(target, key),
  };
}

/**
 * A `ctx.user` for a test, with the two presentation fields SDK 0.13.0 added.
 *
 * `ctx.user` gained `displayName` and `avatarUrl` alongside `ctx.users` — the same fields a {@link UserRef}
 * carries, and the same rule: `id` is identity, these two are presentation, read them at render and do not
 * keep a copy. That made every hand-written `{ id, role }` literal in this repo's tests a compile error,
 * which is the whole migration.
 *
 * `avatarUrl` is derived here the way the host derives it (`/api/users/{id}/avatar`, §8.7) rather than being
 * passed in, so an assertion in a test pins the string production actually produces.
 */
export function mockUser(id: string, role: Role, displayName = `User ${id}`) {
  return { id, role, displayName, avatarUrl: `/api/users/${id}/avatar` };
}
