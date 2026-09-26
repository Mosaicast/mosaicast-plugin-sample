// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 The Mosaicast Authors

import { useEffect, useMemo, useState } from 'react';
import type { LocaleInfo, PluginContext } from '@mosaicast/plugin-sdk';
import { makeI18n } from '../i18n';
import { ICON_CSS, Icon } from '../icons';
import { describeApiError } from '../api-error';

/** Site-wide look-and-feel for every `Highlight` tile, stored at `data/site/main/settings`. */
export interface SiteSettings {
  /** Replaces the per-scope i18n heading ("Episode Highlight", …) with this text everywhere, when set. */
  headingOverride?: string;
  /** Font stack applied to every Highlight tile; defaults to the system font when unset. */
  fontFamily?: 'system' | 'serif' | 'mono';
}

/**
 * Doc-store address for {@link SiteSettings} — a site-scope singleton, like `stats`.
 *
 * **This is the one place in the plugin that still builds a path by hand, and it is on purpose.**
 * Everywhere else moved to `ctx.docs` in 2.12.0, which is the right default: it builds the path, validates
 * the key against the host's pattern before a 400 round-trip, and resolves an unwritten key to `null`. But `ctx.api`
 * did not go away — the SDK keeps it as the documented escape hatch for anything the typed client does not
 * cover, and a reference plugin that used only the sugar would leave an author guessing whether the raw
 * client was still supported. It is. `ctx.docs.get('site', 'settings')` would be the idiomatic call here;
 * this stays to show the shape underneath it, and to prove the two reach the same document.
 */
export const SETTINGS_PATH = 'data/site/main/settings';

/** Maps a {@link SiteSettings.fontFamily} to a real CSS `font-family` value; exported so `Highlight` reuses it. */
export const FONT_STACKS: Record<NonNullable<SiteSettings['fontFamily']>, string> = {
  system: 'system-ui, sans-serif',
  serif: 'Georgia, "Times New Roman", serif',
  mono: 'ui-monospace, SFMono-Regular, "Cascadia Mono", monospace',
};

/**
 * The plugin's `site`/`sidebar` admin slot (`visibleTo: "podcaster"`, ARCHITECTURE §7.3) — a podcaster
 * (or admin) sees this in the site sidebar and nobody else does, because the *slot* is gated by role, the
 * same mechanism every other slot in this plugin relies on.
 *
 * <p>Why this exists instead of the manifest's declarative {@code config} block: core does not yet render
 * a generic config-admin form from a manifest's `config` field (that milestone, E5b, hadn't landed as of
 * this writing — see the README's "Two ways to be configurable" section). Until it does, a plugin that
 * wants an admin-editable setting with a real, live effect for every visitor owns that setting itself:
 * a small doc in its own store, written here, read back by {@link Highlight}. This is not a workaround —
 * it is the documented, supported pattern (ARCHITECTURE §7.6: "most declare nothing" beyond the store).
 */
export function AdminSettings({ ctx }: { ctx: PluginContext }) {
  const i18n = useMemo(() => makeI18n(ctx.locale), [ctx]);
  const [locale, setLocale] = useState(ctx.locale.current());
  useEffect(() => ctx.locale.onChange(setLocale), [ctx]);
  useEffect(() => () => i18n.dispose(), [i18n]);
  void locale; // re-render on locale change; i18n.t reads the current catalog internally


  const [settings, setSettings] = useState<SiteSettings>({});
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);

  const [error, setError] = useState<{ key: string; detail?: string } | undefined>(undefined);

  useEffect(() => {
    // `getOrNull` on the raw client (SDK 0.9.0), which is the escape hatch's half of the same fix
    // `ctx.docs.get` has: "nothing saved yet" is the ordinary state of a settings document, and the host's
    // 204 for it (SDK 0.16.0; a 404 before) resolves `null`. Every other status still rejects, and the catch below is a real error path again rather than
    // the `.catch(() => setSettings({}))` that reported a 500 to the podcaster as an empty form.
    ctx.api
      .getOrNull<SiteSettings>(SETTINGS_PATH)
      .then((loaded) => setSettings(loaded ?? {}))
      .catch((e: unknown) => {
        setError(describeApiError(e));
        ctx.log('warn', 'site highlight settings could not be loaded');
      });
  }, [ctx]);

  async function handleSave() {
    setSaving(true);
    setError(undefined);
    try {
      await ctx.api.put(SETTINGS_PATH, settings);
      setSaved(true);
      ctx.log('info', 'site highlight settings saved');
    } catch (e) {
      // Not rethrown: nothing awaits this handler's promise (it's a bare onClick), so a rethrow here would
      // only become an unhandled rejection. What changed in 2.12.0 is that the podcaster now *sees* it —
      // the rejection carries a status and the host's RFC-7807 body, so "the write floor refused you" is
      // showable instead of being one more silent no-op behind a Save button.
      setError(describeApiError(e));
      ctx.log('warn', 'site highlight settings save failed');
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="settings">
      <style>{`
        ${ICON_CSS}
        .settings .title, .settings button { display: inline-flex; align-items: center; gap: 0.35rem; }
        .settings { background: var(--mc-surface); color: var(--mc-text); border: 1px solid var(--mc-border);
          border-radius: 0.5rem; padding: 0.75rem 1rem; font-family: system-ui, sans-serif; display: flex;
          flex-direction: column; gap: 0.5rem; }
        .settings .title { font-size: 0.85rem; font-weight: 600; color: var(--mc-accent-text); margin: 0; }
        .settings .hint { font-size: 0.75rem; color: var(--mc-text-muted); margin: 0; }
        /* Fenced off from the editable fields above it, because nothing in here is editable *from this
           panel*: both lists are an admin's decision made elsewhere in the shell. A read-only block
           sitting flush with the inputs invites a click that goes nowhere. */
        .settings .locales {
          display: flex; flex-direction: column; gap: 0.2rem;
          padding-top: 0.5rem;
          border-top: 1px solid var(--mc-border);
        }
        .settings .localesTitle {
          margin: 0; font-size: 0.8rem; font-weight: 600;
          display: inline-flex; align-items: center; gap: 0.35rem;
        }
        .settings label { display: flex; flex-direction: column; gap: 0.2rem; font-size: 0.8rem; }
        .settings input, .settings select { background: var(--mc-bg); color: var(--mc-text);
          border: 1px solid var(--mc-border); border-radius: 0.25rem; padding: 0.3rem; font: inherit; }
        .settings button { align-self: flex-start; background: var(--mc-accent); color: var(--mc-accent-contrast);
          border: none; border-radius: 0.25rem; padding: 0.3rem 0.7rem; cursor: pointer; font: inherit; }
        .settings .saved { font-size: 0.75rem; color: var(--mc-text-muted); }
        .settings .error { display: inline-flex; align-items: center; gap: 0.35rem; font-size: 0.75rem;
          color: var(--mc-text); }
        /* The host's problem detail is core's wording, not a translated string — quieter than the
           translated line it follows, because it is a hint for the person fixing the install. */
        .settings .error .detail { color: var(--mc-text-muted); }
      `}</style>

      <p className="title">
        <Icon name="settings" />
        {i18n.t('settings.title')}
      </p>
      <p className="hint">{i18n.t('settings.hint')}</p>

      <label>
        {i18n.t('settings.headingLabel')}
        <input
          type="text"
          value={settings.headingOverride ?? ''}
          placeholder={i18n.t('settings.headingPlaceholder')}
          onChange={(e) => {
            setSaved(false);
            const value = e.target.value;
            setSettings((s) => ({ ...s, headingOverride: value || undefined }));
          }}
        />
      </label>

      <label>
        {i18n.t('settings.fontLabel')}
        <select
          value={settings.fontFamily ?? 'system'}
          onChange={(e) => {
            setSaved(false);
            setSettings((s) => ({ ...s, fontFamily: e.target.value as SiteSettings['fontFamily'] }));
          }}
        >
          <option value="system">{i18n.t('settings.font.system')}</option>
          <option value="serif">{i18n.t('settings.font.serif')}</option>
          <option value="mono">{i18n.t('settings.font.mono')}</option>
        </select>
      </label>

      {/* Read-only, and the only place in this plugin that renders `available()` at all (SDK 0.10.0).
          The editor uses `content()` and nothing else; showing both here, labelled, is what makes the
          distinction visible to the person who can act on it — a podcaster looking at a missing language
          tab needs to know which of the two lists an admin has to change. Languages are a runtime registry
          an operator edits, so both are the host's live answer rather than anything this plugin stores. */}
      <div className="locales">
        <p className="localesTitle">
          <Icon name="translate" />
          {i18n.t('admin.locales.title')}
        </p>
        <p className="hint">{i18n.t('admin.locales.ui', { list: nativeNames(ctx.locale.available()) })}</p>
        <p className="hint">{i18n.t('admin.locales.content', { list: nativeNames(ctx.locale.content()) })}</p>
        <p className="hint">{i18n.t('admin.locales.note')}</p>
      </div>

      <button type="button" onClick={handleSave} disabled={saving}>
        <Icon name="save" />
        {saving ? i18n.t('saving') : i18n.t('settings.save')}
      </button>
      {saved && <span className="saved">{i18n.t('settings.saved')}</span>}
      {/* Shown at all only because the rejection carries a status now (SDK 0.9.0). Before that this was a
          log line the podcaster never saw, and a Save button that appeared to work. */}
      {error && (
        <span className="error" role="status">
          <Icon name="warning" />
          {i18n.t(error.key)}
          {error.detail && <span className="detail">{error.detail}</span>}
        </span>
      )}
    </div>
  );
}

/**
 * A locale list as readable prose — "English, Deutsch, Nederlands".
 *
 * `nativeName`, never a name in the reader's own language: the host hands over each language's name *in
 * that language* precisely so no plugin ships a translation table for the world's languages, and a
 * podcaster choosing between them recognises "Nederlands" whether or not they read Dutch.
 *
 * A plain `join`, not `Intl.ListFormat`: this is a set of labels rather than a sentence about them, and the
 * host's own language pickers render the same way. `i18n.n`/`plural`/`duration` exist for the cases where a
 * locale genuinely changes the formatting; a comma-separated list of proper nouns is not one of them.
 */
function nativeNames(locales: readonly LocaleInfo[]): string {
  return locales.map((l) => l.nativeName).join(', ');
}
