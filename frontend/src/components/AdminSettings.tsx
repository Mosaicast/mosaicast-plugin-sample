// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 The Mosaicast Authors

import { useEffect, useMemo, useState } from 'react';
import type { PluginContext } from '@mosaicast/plugin-sdk';
import { makeI18n } from '../i18n';

/** Site-wide look-and-feel for every `Highlight` tile, stored at `data/site/main/settings`. */
export interface SiteSettings {
  /** Replaces the per-scope i18n heading ("Episode Highlight", …) with this text everywhere, when set. */
  headingOverride?: string;
  /** Font stack applied to every Highlight tile; defaults to the system font when unset. */
  fontFamily?: 'system' | 'serif' | 'mono';
}

/** Doc-store address for {@link SiteSettings} — a site-scope singleton, like `stats`. */
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

  useEffect(() => {
    ctx.api
      .get<SiteSettings>(SETTINGS_PATH)
      .then((loaded) => setSettings(loaded ?? {}))
      .catch(() => setSettings({}));
  }, [ctx]);

  async function handleSave() {
    setSaving(true);
    try {
      await ctx.api.put(SETTINGS_PATH, settings);
      setSaved(true);
      ctx.log('info', 'site highlight settings saved');
    } catch (e) {
      // Not rethrown: nothing awaits this handler's promise (it's a bare onClick), so a rethrow here would
      // only become an unhandled rejection. Logging is the whole error-reporting story for this action.
      ctx.log('warn', `site highlight settings save failed: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="settings">
      <style>{`
        .settings { background: var(--mc-surface); color: var(--mc-text); border: 1px solid var(--mc-border);
          border-radius: 0.5rem; padding: 0.75rem 1rem; font-family: system-ui, sans-serif; display: flex;
          flex-direction: column; gap: 0.5rem; }
        .settings .title { font-size: 0.85rem; font-weight: 600; color: var(--mc-accent); margin: 0; }
        .settings .hint { font-size: 0.75rem; color: var(--mc-text-muted); margin: 0; }
        .settings label { display: flex; flex-direction: column; gap: 0.2rem; font-size: 0.8rem; }
        .settings input, .settings select { background: var(--mc-bg); color: var(--mc-text);
          border: 1px solid var(--mc-border); border-radius: 0.25rem; padding: 0.3rem; font: inherit; }
        .settings button { align-self: flex-start; background: var(--mc-accent); color: var(--mc-accent-contrast);
          border: none; border-radius: 0.25rem; padding: 0.3rem 0.7rem; cursor: pointer; font: inherit; }
        .settings .saved { font-size: 0.75rem; color: var(--mc-text-muted); }
      `}</style>

      <p className="title">{i18n.t('settings.title')}</p>
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

      <button type="button" onClick={handleSave} disabled={saving}>
        {saving ? i18n.t('saving') : i18n.t('settings.save')}
      </button>
      {saved && <span className="saved">{i18n.t('settings.saved')}</span>}
    </div>
  );
}
