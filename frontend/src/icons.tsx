// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 The Mosaicast Authors

/**
 * The host's icon set, read as CSS custom properties (`--mc-icon-*`, ARCHITECTURE §12.3).
 *
 * This is the **third** channel a plugin shares with the shell, and the one that costs the least:
 *
 * - `ctx.api` / `ctx.blobs` — data, over HTTP, versioned by `platformApi`.
 * - `ctx.theme` — colours, which the SDK injects into the shadow root as `--mc-bg`, `--mc-accent`, ….
 * - **`--mc-icon-*` — artwork, which nothing injects.** The shell declares these on `:root`, custom
 *   properties inherit *through* the shadow boundary, and so a Web Component reads them with **no SDK
 *   import, no `platformApi` bump and no version skew**. A plugin built against SDK 0.8.0 picks up an
 *   icon the day a later core release publishes it. That is why they are not on `ctx`: putting them
 *   there would have made every new icon an SDK release and a manifest bump for every plugin.
 *
 * Three rules come out of that, and all three are encoded below rather than left to a comment:
 *
 * 1. **Mask, never `background-image`.** `background: currentColor` behind a mask makes the icon take
 *    the caller's own colour, so it re-themes with the text beside it. A `background-image` would bake
 *    in whatever the artwork was drawn as (black), which is invisible on a dark `--mc-surface`.
 * 2. **Every reference needs a fallback, and `none` is the wrong one.** An unresolved `var()` makes the
 *    declaration invalid at computed-value time, so `mask-image` falls back to its initial `none` — an
 *    unmasked element that paints `currentColor` across its whole box. The failure mode of a missing
 *    icon is therefore a *solid square*, not a blank space. {@link BLANK} masks with an empty SVG so a
 *    host that predates the icon set (or drops a name, which the contract forbids but reality permits)
 *    renders nothing and leaves the label beside it doing the work.
 * 3. **Do not declare your own `--mc-*`.** That prefix is the host's namespace, and a plugin defining
 *    into it would shadow the real token for its own subtree the moment core publishes one. This
 *    plugin's private property is `--sample-icon-blank`.
 *
 * The names are a contract — core adds freely and renames never — so referencing one is safe forever,
 * and a name core has not published yet simply renders as nothing (rule 2) instead of breaking a tile.
 */

/**
 * An empty SVG, used as the fallback mask for every icon.
 *
 * Masking with a document that draws nothing hides the element; falling through to `mask-image: none`
 * would show it, filled edge to edge with `currentColor`. See rule 2 above — this constant is the whole
 * difference between "old host, no icon" and "old host, black square in every button".
 */
const BLANK = "url(\"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg'/%3E\")";

/**
 * The host icons this plugin draws, in the shell's own vocabulary (its `frontend/dev/icons.txt`).
 *
 * Deliberately a closed set rather than an open `string`: a typo'd token silently renders nothing
 * (rule 2), which is the kind of bug that ships. Naming them here makes `<Icon name="edt" />` a
 * compile error and gives {@link ICON_CSS} its list.
 */
export const ICON_NAMES = [
  'arrow-left',
  'check',
  'delete',
  'edit',
  'image',
  'pin',
  'play',
  'save',
  'settings',
  'share-out',
  'star',
  'star-on',
  'upload',
  'warning',
] as const;

/** One of the host icons {@link ICON_NAMES} declares. */
export type IconName = (typeof ICON_NAMES)[number];

/**
 * The stylesheet behind {@link Icon} — concatenate it into a component's own `<style>`.
 *
 * Shipped as a string rather than a CSS file because each of this plugin's elements renders into its own
 * shadow root: a bundled stylesheet would land in the host document, where it could not reach any of them.
 *
 * `em` sizing throughout, so an icon scales with whatever text it sits beside — a `0.75rem` card badge
 * and a full-size button get proportionate icons without either one naming a pixel size.
 */
export const ICON_CSS = `
  .mcIcon {
    --sample-icon-blank: ${BLANK};
    display: inline-block;
    flex: none;
    width: 1em;
    height: 1em;
    vertical-align: -0.125em;
    mask-size: contain;
    mask-repeat: no-repeat;
    mask-position: center;
    background: currentColor;
  }
${ICON_NAMES.map((name) => `  .mcIcon--${name} { mask-image: var(--mc-icon-${name}, var(--sample-icon-blank)); }`).join(
  '\n',
)}
`;

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
  return <span className={`mcIcon mcIcon--${name}`} aria-hidden="true" />;
}
