// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 The Mosaicast Authors

import { describe, expect, it } from 'vitest';
import { createRoot } from 'react-dom/client';
import { act } from 'react';
import { apiError, makeMockCtx, makeMockDocs, makeMockTranslation } from '@mosaicast/plugin-sdk/testing';
import type { MockTranslationClient } from '@mosaicast/plugin-sdk/testing';
import type { PluginContext } from '@mosaicast/plugin-sdk';
import { flush, localesOf } from '../test-utils';
import { makeI18n } from '../i18n';
import { TranslationEditor } from './TranslationEditor';
import { DRAFTS_KEY, javaStringHash, type HighlightTranslation } from '../highlight-doc';

/**
 * The 0.10.0/0.11.0 surface, tested where it is actually decided.
 *
 * Two of these tests exist because the corresponding mistake is **silent in production**: an editor built
 * from `available()` instead of `content()` renders a plausible tab bar that writes the wrong locales, and a
 * plugin that forgot `external.kinds` gets a `null` handle with no type error and no log line. Neither
 * fails anything else in this suite.
 */

/** Mounts the editor over a mutable draft, returning the container and the current stored state. */
function mount(ctx: PluginContext, initial: { markdown: string; translations: Record<string, HighlightTranslation> }) {
  const state = { ...initial };
  const container = document.createElement('div');
  document.body.appendChild(container);
  const i18n = makeI18n(ctx.locale);
  const root = createRoot(container);
  function render() {
    root.render(
      <TranslationEditor
        ctx={ctx}
        i18n={i18n}
        markdown={state.markdown}
        onMarkdownChange={(next) => {
          state.markdown = next;
          render();
        }}
        translations={state.translations}
        onTranslationsChange={(next) => {
          state.translations = next;
          render();
        }}
        draftTarget={{ type: 'episode', id: 'the-kraken' }}
      />,
    );
  }
  act(render);
  return { container, state };
}

/** A bilingual site: the shell renders in English only, but content may be written in English or German. */
function bilingual(over: Parameters<typeof makeMockCtx>[0] = {}) {
  return makeMockCtx({ locale: localesOf(['en'], ['en', 'de']), ...over });
}

const tabLabels = (c: HTMLElement) => [...c.querySelectorAll('[role="tab"]')].map((t) => t.textContent);
const tab = (c: HTMLElement, name: string) =>
  [...c.querySelectorAll('[role="tab"]')].find((t) => t.textContent?.startsWith(name)) as HTMLButtonElement;
const button = (c: HTMLElement, text: string) =>
  [...c.querySelectorAll('button')].find((b) => b.textContent?.includes(text));

/**
 * Types into a controlled textarea the way a person does.
 *
 * Assigning `.value` and dispatching `input` is not enough: React installs its own value setter on the
 * element's prototype and reads the *tracked* value to decide whether anything changed, so a direct
 * assignment updates the DOM and the handler never fires. Reaching for the prototype's own setter is what
 * makes React see a change — the same trick every testing library performs internally.
 */
function type(el: HTMLTextAreaElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!;
  act(() => {
    setter.call(el, value);
    el.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

describe('TranslationEditor — the two locale lists', () => {
  it('builds its tabs from content(), never from available()', async () => {
    // The whole reason `ctx.locale` carries two lists. This site renders its UI in English *and* Dutch but
    // only permits content in English and German — a shape that looks contrived and is exactly what an
    // operator produces by shipping a UI catalog they have no intention of writing prose in. An editor
    // built from `available()` would offer a Dutch tab (writing a locale nothing reads back) and hide the
    // German one (silently refusing the language the admin actually asked for).
    const ctx = makeMockCtx({ locale: localesOf(['en', 'nl'], ['en', 'de']) });
    const { container } = mount(ctx, { markdown: 'the squid shows up', translations: {} });

    expect(tabLabels(container)).toHaveLength(2);
    expect(tabLabels(container)[1]).toBe('Deutsch');
    expect(tabLabels(container).some((l) => l?.includes('Nederlands'))).toBe(false);
  });

  it('renders a bare textarea on a single-language site', () => {
    // The default `makeMockCtx` shape, and the one every other test in this repo runs under: tabs over one
    // language are chrome that teaches nobody anything, so the control degrades to what it replaced.
    const { container } = mount(makeMockCtx(), { markdown: 'the squid shows up', translations: {} });

    expect(container.querySelectorAll('[role="tab"]')).toHaveLength(0);
    expect(container.querySelector('textarea')?.value).toBe('the squid shows up');
  });

  it('puts the site default first and marks it, whatever order the host returns', () => {
    // A podcaster writes the original before they translate it, so the tab they need first is the one that
    // is not a translation. `content()[0]` is the default by the host's contract; this asserts the
    // component reads `isDefault` rather than trusting position.
    const ctx = makeMockCtx({ locale: localesOf(['en'], ['de', 'en']) });
    const { container } = mount(ctx, { markdown: 'der Tintenfisch', translations: {} });

    expect(tabLabels(container)[0]).toContain('Deutsch');
  });
});

describe('TranslationEditor — translating', () => {
  it('fills the active tab and flags it as machine output', async () => {
    const translation = makeMockTranslation();
    const ctx = bilingual({ translation });
    const { container, state } = mount(ctx, { markdown: 'the squid shows up', translations: {} });

    act(() => tab(container, 'Deutsch').click());
    await act(async () => void button(container, 'Translate from')!.click());
    await flush();

    // Translated *from the site default*, never from whatever tab happened to be open — a German tab
    // translating German into German is the bug this pins.
    expect(translation.requests).toEqual([
      { text: 'the squid shows up', from: 'en', to: 'de', format: 'text' },
    ]);
    expect(state.translations.de).toEqual({
      markdown: '[de] the squid shows up',
      machineTranslated: true,
    });
  });

  it('badges the result as unconfirmed until the podcaster has touched it', async () => {
    const ctx = bilingual({ translation: makeMockTranslation() });
    const { container, state } = mount(ctx, { markdown: 'the squid', translations: {} });

    act(() => tab(container, 'Deutsch').click());
    await act(async () => void button(container, 'Translate from')!.click());
    await flush();
    expect(container.querySelector('.badge')?.textContent).toContain('read it before you save');

    // Typing is the human confirmation, and it also transfers authorship: the stored provenance flag goes
    // with it, because the words are now the podcaster's and claiming a machine wrote them would be the
    // same misattribution in reverse.
    type(container.querySelector('textarea')!, 'der Tintenfisch taucht auf');
    expect(container.querySelector('.badge')).toBeNull();
    expect(state.translations.de).toEqual({ markdown: 'der Tintenfisch taucht auf' });
  });

  it('drops an emptied tab rather than storing a blank translation', () => {
    const ctx = bilingual({ translation: makeMockTranslation() });
    const { container, state } = mount(ctx, {
      markdown: 'the squid',
      translations: { de: { markdown: 'der Tintenfisch' } },
    });

    act(() => tab(container, 'Deutsch').click());
    type(container.querySelector('textarea')!, '   ');

    // Not `{ de: { markdown: '' } }`. A blank translation is not a translation, and the key surviving would
    // make the backend's coverage pass count this language as written.
    expect(state.translations).toEqual({});
  });

  it('will not translate an empty original', () => {
    const ctx = bilingual({ translation: makeMockTranslation() });
    const { container } = mount(ctx, { markdown: '   ', translations: {} });

    act(() => tab(container, 'Deutsch').click());
    expect(button(container, 'Translate from')?.disabled).toBe(true);
  });
});

describe('TranslationEditor — the ways translation is not there', () => {
  it('offers a hint instead of a button when ctx.translation is null', () => {
    // The default. `null` for two deliberately indistinguishable reasons — a manifest that never declared
    // `external.kinds: ["translation"]`, or an operator who configured no provider — and this is the shape
    // every site has until an admin chooses one. A component written against a translator that is always
    // there breaks here and nowhere else.
    const { container } = mount(bilingual(), { markdown: 'the squid', translations: {} });

    act(() => tab(container, 'Deutsch').click());
    expect(button(container, 'Translate from')).toBeUndefined();
    expect(container.querySelector('.hint')?.textContent).toContain('No translation service');
    // The tab is still there, and still writable by hand. Absence of a machine is not absence of the
    // feature — this is the one thing the hint has to leave working.
    expect(container.querySelector('textarea')).not.toBeNull();
  });

  it('disables the button when a handle exists but available() says no', () => {
    // `available()` is advisory: it is what a button should be disabled on, and never what an error path
    // should be built on. Both halves are asserted — here, and in the 409 case below.
    const translation: MockTranslationClient = { ...makeMockTranslation(), available: () => false };
    const { container } = mount(bilingual({ translation }), { markdown: 'the squid', translations: {} });

    act(() => tab(container, 'Deutsch').click());
    expect(button(container, 'Translate from')?.disabled).toBe(true);
  });

  it.each([
    [403, 'not allowed to use the translation service'],
    [409, 'switched off while you were writing'],
    [429, 'used up its translation allowance'],
    [503, 'did not answer'],
  ])('shows the failure on %i rather than falling back to the original', async (status, expected) => {
    // The one call in this plugin where swallowing the error would be actively harmful: the podcaster would
    // save the English source into the German tab, and every German reader would be told it had been
    // translated for them. 403 is the sharpest of the four — a non-null handle is not permission, because
    // the host enforces `external.usedBy` at the call.
    const translation = makeMockTranslation({ fail: apiError(status) });
    const { container, state } = mount(bilingual({ translation }), {
      markdown: 'the squid',
      translations: {},
    });

    act(() => tab(container, 'Deutsch').click());
    await act(async () => void button(container, 'Translate from')!.click());
    await flush();

    expect(container.querySelector('[role="alert"]')?.textContent).toContain(expected);
    expect(state.translations).toEqual({});
  });
});

describe('TranslationEditor — the backend drafts', () => {
  /** A context whose doc store already holds a draft the schedule produced for `source`. */
  function withDraft(source: string, over: { locale?: string; sourceHash?: number } = {}) {
    const docs = makeMockDocs();
    void docs.put({ type: 'episode', id: 'the-kraken' }, DRAFTS_KEY, {
      drafts: [
        {
          locale: over.locale ?? 'de',
          markdown: 'der Tintenfisch taucht auf',
          providerId: 'libretranslate',
          sourceHash: over.sourceHash ?? javaStringHash(source),
        },
      ],
    });
    return bilingual({ docs, translation: makeMockTranslation() });
  }

  it('offers a ready-made draft without spending a provider call', async () => {
    const ctx = withDraft('the squid shows up');
    const { container, state } = mount(ctx, { markdown: 'the squid shows up', translations: {} });
    await flush();

    act(() => tab(container, 'Deutsch').click());
    act(() => button(container, 'ready-made')!.click());

    expect(state.translations.de).toEqual({
      markdown: 'der Tintenfisch taucht auf',
      machineTranslated: true,
    });
    // The point of the whole mechanism: the schedule already paid for this one.
    expect((ctx.translation as MockTranslationClient).requests).toEqual([]);
  });

  it('withholds a draft whose original has been rewritten since', async () => {
    // A faithful translation of a paragraph that no longer exists, offered as current, is worse than no
    // suggestion at all — so the draft carries the hash of what it was made from and this compares it.
    const ctx = withDraft('the squid shows up', { sourceHash: javaStringHash('something else entirely') });
    const { container } = mount(ctx, { markdown: 'the squid shows up', translations: {} });
    await flush();

    act(() => tab(container, 'Deutsch').click());
    expect(button(container, 'ready-made')).toBeUndefined();
  });

  it('withholds a draft for a tab the podcaster has already written', async () => {
    const ctx = withDraft('the squid shows up');
    const { container } = mount(ctx, {
      markdown: 'the squid shows up',
      translations: { de: { markdown: 'von Hand geschrieben' } },
    });
    await flush();

    act(() => tab(container, 'Deutsch').click());
    // Overwriting a podcaster's own words with a machine's is the editor undoing their work.
    expect(button(container, 'ready-made')).toBeUndefined();
  });
});
