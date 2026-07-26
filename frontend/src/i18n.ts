// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 The Mosaicast Authors

import { createPluginI18n, type PluginContext } from '@mosaicast/plugin-sdk';
import en from '../locales/en.json';
import de from '../locales/de.json';

/** Builds this plugin's translator, bound to the host's active locale. */
export function makeI18n(locale: PluginContext['locale']) {
  return createPluginI18n({ en, de }, locale);
}
