// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 The Mosaicast Authors

/**
 * The host's icon set, read as CSS custom properties (`--mc-icon-*`, ARCHITECTURE §12.3).
 *
 * This is the **third** channel a plugin shares with the shell, and the one that costs the least:
 *
 * - `ctx.api` / `ctx.docs` / `ctx.blobs` — data, over HTTP, versioned by `platformApi`.
 * - `ctx.theme` — colours, which the SDK injects into the shadow root as `--mc-bg`, `--mc-accent`, ….
 * - **`--mc-icon-*` — artwork, which nothing injects.** The shell declares these on `:root`, custom
 *   properties inherit *through* the shadow boundary, and so a Web Component reads them with **no SDK
 *   import, no `platformApi` bump and no version skew**. A plugin built against SDK 0.9.1 picks up an
 *   icon the day a later core release publishes it. That is why they are not on `ctx`: putting them
 *   there would have made every new icon an SDK release and a manifest bump for every plugin.
 *
 * ## What changed in SDK 0.9.0, and what did not
 *
 * The three rules that fall out of the design above — mask rather than `background-image`, a *blank image*
 * fallback rather than `mask-image: none`, and never declaring into the host's `--mc-*` namespace — used to
 * be hand-written here, in about sixty lines that every plugin copied and one of them always got wrong.
 * {@link iconCss} owns them now. This module keeps only the two things that are genuinely local:
 *
 * 1. **A closed {@link ICON_NAMES} list**, so `<Icon name="edt" />` is a compile error. The SDK's
 *    `KnownIconName` deliberately stays *open* (`string & {}`) because closing it would pin the icon set to
 *    an SDK version and undo the whole no-skew property above. A plugin narrowing it for its own call sites
 *    is the right place for that check — the SDK cannot do it without taking the property away from
 *    everyone.
 * 2. **Layout that is this plugin's taste, not the contract's** — see {@link ICON_LAYOUT_CSS}.
 *
 * The failure mode worth remembering even though the SDK now handles it: an unresolved `var()` invalidates
 * the declaration at computed-value time, so `mask-image` falls back to its *initial* `none` and an
 * unmasked element paints `currentColor` across its whole box. **A missing icon renders as a solid square,
 * not as blank space** — which is why `iconCss` emits a blank SVG and not `none`. A name core has not
 * published yet therefore renders as nothing and leaves the label beside it doing the work.
 */

import { iconCss, type KnownIconName } from '@mosaicast/plugin-sdk';

/**
 * The host icons this plugin draws, in the shell's own vocabulary (its `frontend/dev/icons.txt`).
 *
 * Deliberately a closed set rather than an open `string`: a typo'd token silently renders nothing, which is
 * the kind of bug that ships. Naming them here makes `<Icon name="edt" />` a compile error and gives
 * {@link ICON_CSS} its list.
 */
export const ICON_NAMES = [
  'arrow-left',
  'check',
  'clock',
  'compose',
  'delete',
  'edit',
  'image',
  'info',
  'pin',
  'play',
  'save',
  'settings',
  'share-out',
  'sort',
  'star',
  'star-on',
  'tag',
  'translate',
  'upload',
  'warning',
] as const satisfies readonly KnownIconName[];

/** One of the host icons {@link ICON_NAMES} declares. */
export type IconName = (typeof ICON_NAMES)[number];

/**
 * Layout this plugin wants on top of the SDK's mechanics.
 *
 * `iconCss` emits sizing in `em` and the masking rules; it does not — and should not — decide that an icon
 * must not shrink inside a flex row, or how far it sits below the baseline of the text beside it. Those are
 * per-plugin taste, so they live here rather than being smuggled into the shared helper.
 */
const ICON_LAYOUT_CSS = `.mc-icon { flex: none; vertical-align: -0.125em; }`;

/**
 * The stylesheet behind {@link Icon} — concatenate it into a component's own `<style>`.
 *
 * Shipped as a string rather than a CSS file because each of this plugin's elements renders into its own
 * shadow root: **a bundled stylesheet lands in the host document, where it cannot reach any shadow root**,
 * and silently does nothing. That is the thing everyone tries first.
 *
 * `em` sizing throughout, so an icon scales with whatever text it sits beside — a `0.75rem` card badge and
 * a full-size button get proportionate icons without either one naming a pixel size.
 */
export const ICON_CSS = `${iconCss(ICON_NAMES, { className: 'mc-icon' })}\n${ICON_LAYOUT_CSS}`;

/**
 * One host icon, as a decorative inline element.
 *
 * Always `aria-hidden`: every call site in this plugin puts an icon *beside* a real label, so announcing
 * it would read the meaning twice ("star star Favourite this"). An icon that carried meaning on its own
 * would need a visible or `aria-label`led name instead — but that plugin should ask whether a bare icon
 * button is the right control at all.
 *
 * @param name the host icon to draw; see {@link ICON_NAMES}
 */
export function Icon({ name }: { name: IconName }) {
  return <span className={`mc-icon mc-icon-${name}`} aria-hidden="true" />;
}
