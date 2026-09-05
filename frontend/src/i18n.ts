// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 The Mosaicast Authors

import { createPluginI18n, type PluginContext } from '@mosaicast/plugin-sdk';
import en from '../locales/en.json';
import de from '../locales/de.json';

/** Builds this plugin's translator, bound to the host's active locale. */
export function makeI18n(locale: PluginContext['locale']) {
  return createPluginI18n({ en, de }, locale);
}

/**
 * A locale's name in its own language, from the host's registry (SDK 0.10.0).
 *
 * `nativeName` is "Nederlands", not "Dutch", and the host hands it over ready to render so that no plugin
 * ships a language-name table of its own — which would be one more thing to translate, and would be wrong
 * for exactly the languages nobody on the project speaks. Falls back to the bare code for a locale that has
 * dropped out of the registry since a document named it, which is a real state: an admin can disable a
 * content language while prose written in it is still stored.
 *
 * Both lists are searched because a code can legitimately be in either: text may be authored in a language
 * the shell does not render, and the shell renders languages nothing was ever authored in.
 *
 * @param ctx  the plugin context, for `ctx.locale.content()` / `ctx.locale.available()`
 * @param code the locale code to name
 * @returns the language's own name for itself, or `code` when the registry no longer knows it
 */
export function nativeNameOf(ctx: PluginContext, code: string): string {
  const known = [...ctx.locale.content(), ...ctx.locale.available()];
  return known.find((l) => l.code === code)?.nativeName ?? code;
}
