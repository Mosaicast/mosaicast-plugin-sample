// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 The Mosaicast Authors

import { useEffect, useMemo, useState } from 'react';
import type { LocaleInfo, PluginContext, PluginI18n, Scope } from '@mosaicast/plugin-sdk';
import { Icon } from '../icons';
import { describeTranslationError } from '../api-error';
import {
  DRAFTS_KEY,
  defaultLocaleOf,
  javaStringHash,
  type HighlightTranslation,
  type TranslationDraft,
  type TranslationDrafts,
} from '../highlight-doc';

/**
 * The highlight's text, in every language this site authors content in (SDK 0.10.0/0.11.0).
 *
 * ## The two lists, and why this one uses `content()`
 *
 * `ctx.locale` offers two: `available()` is what the **shell can render in**, `content()` is what the admin
 * permits text to be **authored in**. They are routinely different and neither is a subset of the other — a
 * site can require a Dutch imprint without offering a Dutch UI, and it can ship a UI catalog for a language
 * it never wants prose written in. An editor is authoring, so it is built from `content()`. Building it
 * from `available()` produces the failure that looks like nothing at all: the tab for the language the
 * operator actually asked for is missing, and the tab that *is* there writes a locale nothing reads back.
 *
 * A site with one content locale gets **no tab bar** — just the textarea, exactly as before 2.13.0. Tabs
 * over a single language are chrome that teaches the reader nothing.
 *
 * ## Machine translation, and the two ways it is not there
 *
 * `ctx.translation` is `null` when this plugin's manifest omits `external.kinds: ["translation"]`, **or**
 * when the site admin configured no provider — deliberately indistinguishable at runtime, so the hint below
 * names both in that order (the manifest is a file the author wrote; the admin panel is somebody else's
 * decision). This plugin *does* declare it, so on a running site the remaining reason is the operator's,
 * which is why the copy leads with them.
 *
 * The handle is read at the point of use and never cached: half the gate is an admin setting that can
 * change under a running plugin. `available()` is the second check — advisory, so the error path still has
 * to exist — and `usedBy: "podcaster"` is the third, enforced by the host at the call as a **403** even
 * when the handle is non-`null`. A non-null handle is not permission.
 *
 * ## What comes back is a draft, and it is labelled twice
 *
 * Once for the podcaster, as an unconfirmed badge that lasts until they press Save — the human
 * confirmation the SDK asks for, and never stored. Once for the reader, as
 * {@link HighlightTranslation.machineTranslated}, which *is* stored, because a person reading a paragraph
 * is entitled to know an engine wrote it. Typing into the field clears the second: at that point the words
 * are the podcaster's, and the flag would be misattribution in the other direction.
 *
 * Failures are shown, never swallowed into the untranslated string. A reader who cannot tell a translation
 * from an original is worse off than one who sees an error.
 */
export function TranslationEditor({
  ctx,
  i18n,
  markdown,
  onMarkdownChange,
  translations,
  onTranslationsChange,
  textareaRef,
  draftTarget,
}: {
  ctx: PluginContext;
  i18n: PluginI18n;
  /** The text in the site's default locale — {@link HighlightDoc.markdown}. */
  markdown: string;
  onMarkdownChange: (next: string) => void;
  /** The other content locales, keyed by code. */
  translations: Record<string, HighlightTranslation>;
  onTranslationsChange: (next: Record<string, HighlightTranslation>) => void;
  /** Focus-on-mount ref for the textarea, owned by the modal that opens it. */
  textareaRef?: (el: HTMLTextAreaElement | null) => void;
  /**
   * Where to look for the backend's machine drafts, or omitted where there are none.
   *
   * Only the episode scope has them: the scheduled pass walks `feeds().episodesIn(site)`, and nothing in
   * the contract enumerates feeds — the same constraint that keeps image uploads off feed-scope tiles.
   */
  draftTarget?: Scope;
}) {
  // Read every render rather than memoised on `ctx`: both lists are the host's answer and change when an
  // admin edits them. `content()` is cheap — it reads a registry the host already holds.
  const contentLocales = ctx.locale.content();
  const defaultLocale = defaultLocaleOf(contentLocales);

  // The default first, then the rest in the host's order. A podcaster writes the original before they
  // translate it, so the tab they need first is the one that is not a translation.
  const tabs = useMemo(
    () => [
      ...contentLocales.filter((l) => l.code === defaultLocale),
      ...contentLocales.filter((l) => l.code !== defaultLocale),
    ],
    [contentLocales, defaultLocale],
  );

  const [active, setActive] = useState(defaultLocale);
  const [translating, setTranslating] = useState(false);
  const [translateError, setTranslateError] = useState<{ key: string; detail?: string } | undefined>(undefined);
  /**
   * Locales the translate button filled during *this* editing session, and which the podcaster has
   * therefore not yet confirmed.
   *
   * Deliberately component state and never part of the document: "a human has looked at this" is a fact
   * about a session, and persisting it would mean a second podcaster opening the editor tomorrow inherits
   * a confirmation they never gave.
   */
  const [unconfirmed, setUnconfirmed] = useState<ReadonlySet<string>>(new Set());

  /**
   * What the backend's scheduled pass already drafted for this episode, if anything.
   *
   * One read when the editor opens, and the payoff is that the common case costs **no provider call at
   * all**: the schedule ran overnight, the host cached the result, and the podcaster finds the suggestion
   * waiting. The translate button stays for text the schedule has never seen — which is every highlight in
   * the minutes after it is written.
   */
  const [drafts, setDrafts] = useState<TranslationDraft[]>([]);
  useEffect(() => {
    if (!draftTarget) return;
    ctx.docs
      .get<TranslationDrafts>(draftTarget, DRAFTS_KEY)
      .then((doc) => setDrafts(doc?.drafts ?? []))
      .catch(() => {
        // A suggestion is a convenience on top of an editor that works without it, so a failed read costs
        // one button and never an error in front of the podcaster.
        ctx.log('warn', 'backend translation drafts unavailable');
      });
  }, [ctx, draftTarget?.type, draftTarget?.id]);

  // A single-language site gets the plain textarea it had before this component existed.
  if (tabs.length <= 1) {
    return (
      <textarea
        ref={textareaRef}
        value={markdown}
        placeholder={i18n.t('markdownPlaceholder')}
        onChange={(e) => onMarkdownChange(e.target.value)}
      />
    );
  }

  const isDefaultTab = active === defaultLocale;
  const activeText = isDefaultTab ? markdown : (translations[active]?.markdown ?? '');
  const activeIsMachine = !isDefaultTab && translations[active]?.machineTranslated === true;
  const activeUnconfirmed = unconfirmed.has(active);

  // A backend draft is offered only for an *empty* tab whose source has not moved since the draft was
  // made. Both halves matter: overwriting text the podcaster wrote would be the editor undoing their work,
  // and a draft of a paragraph that has since been rewritten is a faithful translation of something that
  // no longer exists — which is worse than no suggestion, because it reads as current.
  const offeredDraft =
    !isDefaultTab && activeText === ''
      ? drafts.find((d) => d.locale === active && d.sourceHash === javaStringHash(markdown))
      : undefined;

  function writeActive(next: string, machineTranslated: boolean) {
    if (active === defaultLocale) {
      onMarkdownChange(next);
      return;
    }
    // An emptied tab is dropped rather than stored as `{ markdown: '' }`: a blank translation is not a
    // translation, and leaving the key behind would make the backend's coverage count claim this language
    // is written when it is not.
    if (next.trim() === '') {
      const { [active]: _dropped, ...rest } = translations;
      onTranslationsChange(rest);
      return;
    }
    onTranslationsChange({
      ...translations,
      [active]: { markdown: next, ...(machineTranslated ? { machineTranslated: true } : {}) },
    });
  }

  function handleType(next: string) {
    // Typing clears both flags for this tab: the stored provenance (these are the podcaster's words now)
    // and the session's unconfirmed badge (they have plainly looked at it).
    writeActive(next, false);
    if (unconfirmed.has(active)) {
      setUnconfirmed((prev) => {
        const rest = new Set(prev);
        rest.delete(active);
        return rest;
      });
    }
  }

  async function handleTranslate() {
    // Read the handle here, not at render and not into a ref. The operator half of the gate moves under a
    // running plugin, so a handle captured when the modal opened can be one the admin has since removed.
    const translation = ctx.translation;
    if (!translation || markdown.trim() === '') return;
    setTranslating(true);
    setTranslateError(undefined);
    try {
      const result = await translation.translate({
        text: markdown,
        from: defaultLocale,
        to: active,
        // `'text'`, and the choice is not obvious: this field holds **markdown**, which is neither of the
        // two formats on offer. `'html'` would have the provider treat `**bold**` as text (fine) and then
        // re-escape whatever it thinks are entities (not fine); `'text'` at least leaves the markup alone
        // to be mangled predictably. The SDK says this outright — markdown is neither — and the honest
        // consequence is the badge below: a podcaster has to read the result before it ships.
        format: 'text',
      });
      writeActive(result.text, true);
      setUnconfirmed((prev) => new Set(prev).add(active));
      ctx.log(
        'info',
        `highlight translated to ${active} by ${result.providerId}${result.fromCache ? ' (cached)' : ''}`,
      );
    } catch (e) {
      // Shown, never swallowed. The one call in this plugin where falling back to the input would be
      // actively harmful: the podcaster would save the source language into the target language's tab and
      // every reader of that language would be told it had been translated for them.
      setTranslateError(describeTranslationError(e));
      ctx.log('warn', `translating highlight to ${active} failed`);
    } finally {
      setTranslating(false);
    }
  }

  return (
    <div className="i18nField">
      <style>{`
        .i18nField { display: flex; flex-direction: column; gap: 0.4rem; }
        .i18nField .tabs { display: flex; flex-wrap: wrap; gap: 0.25rem; }
        /* Tabs are buttons, not links: they change what this control edits and navigate nowhere. */
        .i18nField .tabs button {
          background: transparent;
          color: var(--mc-text-muted);
          border: 1px solid var(--mc-border);
          border-radius: 999px;
          padding: 0.15rem 0.6rem;
          font-size: 0.8rem;
        }
        .i18nField .tabs button[aria-selected="true"] {
          background: var(--mc-accent);
          color: var(--mc-accent-contrast);
          border-color: var(--mc-accent);
        }
        /* A dot, not a colour change: the selected tab already owns colour, and a language that merely
           has text in it must stay legible against both states. */
        .i18nField .tabs .written::after {
          content: "";
          width: 0.35em; height: 0.35em;
          border-radius: 50%;
          background: currentColor;
        }
        .i18nField .translateRow {
          display: flex; flex-wrap: wrap; align-items: center; gap: 0.4rem; font-size: 0.8rem;
        }
        .i18nField .hint { margin: 0; color: var(--mc-text-muted); font-size: 0.75rem; }
        .i18nField .hint, .i18nField .badge, .i18nField .translateError {
          display: inline-flex; align-items: center; gap: 0.3rem;
        }
        .i18nField .hint, .i18nField .translateError { align-items: flex-start; }
        .i18nField .hint .mc-icon, .i18nField .translateError .mc-icon { margin-top: 0.15em; }
        /* The unconfirmed badge is the loudest thing in this control on purpose — it is the one state the
           podcaster must not save past without reading. */
        .i18nField .badge {
          align-self: flex-start;
          font-size: 0.75rem; font-weight: 600;
          color: var(--mc-accent-2);
          border: 1px solid currentColor;
          border-radius: 0.25rem;
          padding: 0.1rem 0.4rem;
        }
        .i18nField .provenance { font-size: 0.75rem; color: var(--mc-text-muted); }
        .i18nField .translateError { margin: 0; font-size: 0.8rem; font-weight: 600; color: var(--mc-accent-2); }
      `}</style>

      {/* `tablist`, so a screen reader announces "tab 2 of 3" and arrow keys are expected to work — which
          they do, because these are ordinary buttons in DOM order. `aria-selected` carries the state that
          the accent colour carries visually. */}
      <div className="tabs" role="tablist" aria-label={i18n.t('i18n.tabs.label')}>
        {tabs.map((locale) => (
          <button
            key={locale.code}
            type="button"
            role="tab"
            aria-selected={active === locale.code}
            className={hasText(locale, markdown, translations, defaultLocale) ? 'written' : undefined}
            onClick={() => {
              setActive(locale.code);
              setTranslateError(undefined);
            }}
          >
            {/* `nativeName` — "Nederlands", not "Dutch". The host hands it over ready to render precisely
                so a plugin never ships its own language-name table, which would be one more thing to
                translate and one more thing to get wrong for a language nobody here speaks. */}
            {locale.nativeName}
            {locale.isDefault && ` · ${i18n.t('i18n.default')}`}
          </button>
        ))}
      </div>

      <textarea
        ref={textareaRef}
        value={activeText}
        placeholder={isDefaultTab ? i18n.t('markdownPlaceholder') : i18n.t('i18n.placeholder')}
        onChange={(e) => handleType(e.target.value)}
      />

      {!isDefaultTab && (
        <>
          <div className="translateRow">
            {ctx.translation ? (
              <button
                type="button"
                className="secondary"
                // `available()` is advisory — an admin can drop the provider between this render and the
                // click — so it disables the control and the catch below still has to exist.
                disabled={translating || !ctx.translation.available() || markdown.trim() === ''}
                onClick={handleTranslate}
              >
                <Icon name="translate" />
                {translating
                  ? i18n.t('i18n.translating')
                  : i18n.t('i18n.translate', { from: nativeNameOf(tabs, defaultLocale) })}
              </button>
            ) : (
              // Both reasons, in the order an author should check them. Nothing at runtime can tell them
              // apart, and the SDK is explicit that this is deliberate rather than an omission.
              <p className="hint">
                <Icon name="info" />
                {i18n.t('i18n.noProvider')}
              </p>
            )}
            {/* The suggestion the backend already paid for. Offered beside the button rather than instead
                of it: this one is free and possibly hours old, that one is current and costs a call, and
                which the podcaster wants is theirs to decide. Accepting it goes through the same
                `writeActive(…, true)` as a live translation — a machine wrote it either way, and where the
                call happened is not a fact a reader cares about. */}
            {offeredDraft && (
              <button
                type="button"
                className="secondary"
                onClick={() => {
                  writeActive(offeredDraft.markdown, true);
                  setUnconfirmed((prev) => new Set(prev).add(active));
                  ctx.log('info', `accepted backend draft for ${active} from ${offeredDraft.providerId}`);
                }}
              >
                <Icon name="check" />
                {i18n.t('i18n.useDraft')}
              </button>
            )}
            {markdown.trim() === '' && ctx.translation && (
              <span className="provenance">{i18n.t('i18n.needsSource')}</span>
            )}
          </div>

          {translateError && (
            <p className="translateError" role="alert">
              <Icon name="warning" />
              <span>
                {i18n.t(translateError.key)}
                {translateError.detail && ` ${translateError.detail}`}
              </span>
            </p>
          )}

          {activeUnconfirmed && (
            <p className="badge" role="status">
              <Icon name="warning" />
              {i18n.t('i18n.unconfirmed')}
            </p>
          )}

          {activeIsMachine && !activeUnconfirmed && (
            <p className="provenance">{i18n.t('i18n.wasMachine')}</p>
          )}
        </>
      )}
    </div>
  );
}

/** Whether a tab has any text behind it, for the written-dot on the tab bar. */
function hasText(
  locale: LocaleInfo,
  markdown: string,
  translations: Record<string, HighlightTranslation>,
  defaultLocale: string,
): boolean {
  const text = locale.code === defaultLocale ? markdown : translations[locale.code]?.markdown;
  return (text ?? '').trim() !== '';
}

/** The host's own name for a locale, falling back to the bare code if it has dropped out of the registry. */
function nativeNameOf(locales: readonly LocaleInfo[], code: string): string {
  return locales.find((l) => l.code === code)?.nativeName ?? code;
}
