// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 The Mosaicast Authors

import { useState, type ImgHTMLAttributes, type ReactNode } from 'react';

/**
 * Props for {@link FallbackImg}: an ordinary `<img>`, minus `onError`, which it owns.
 */
export type FallbackImgProps = Omit<ImgHTMLAttributes<HTMLImageElement>, 'onError' | 'src'> & {
  /** The image URL. A new one gets a fresh attempt; a failure is remembered per URL, not per element. */
  src: string;
  /** What renders instead once the image has failed. Nothing by default — the element simply goes. */
  fallback?: ReactNode;
  /** Told once per failed URL, e.g. to `ctx.log` it — the visitor sees nothing, so the author should. */
  onFail?: (src: string) => void;
};

/**
 * An `<img>` that stands down when it fails to load, instead of painting a broken-image glyph with its raw
 * alt text beside it in the middle of a card (plugin-sample#47, #49).
 *
 * Every image this plugin renders can fail for a reason the visitor did nothing about: a third-party host
 * that is blocked, offline or refused by the CSP, a blob deleted between the index and the render, a
 * visitor's content blocker. Core cannot help. The element lives in this plugin's shadow root, so each
 * plugin decides what a failed image means, and the right answer depends on what the image is **for**:
 *
 * - **Decoration** (an avatar beside a name, a badge, a card thumbnail): hide it, or swap in the neutral
 *   placeholder the layout already has for "no picture". Nothing is lost.
 * - **Content** (the podcaster's own picture): show its alt text as text. That is what the podcaster wrote
 *   it for, and a screen reader never needed the pixels.
 *
 * The failure is remembered against the URL, so a changed `src` (another episode, a replaced upload) gets
 * its own attempt rather than inheriting the last one's verdict.
 */
export function FallbackImg({ src, fallback = null, onFail, ...img }: FallbackImgProps) {
  const [failedSrc, setFailedSrc] = useState<string | null>(null);
  if (failedSrc === src) return <>{fallback}</>;
  return (
    <img
      {...img}
      src={src}
      onError={() => {
        setFailedSrc(src);
        onFail?.(src);
      }}
    />
  );
}

/**
 * Ref callback for a container whose HTML this plugin did not build element by element — the rendered,
 * sanitized Markdown. `ctx.sanitize` keeps `<img>` with an `http(s)` source, so a podcaster can point at
 * any host, and one the CSP refuses fails exactly like a dead one.
 *
 * `error` does not bubble, so the listener sits in the **capture** phase on the container and hides the
 * failed image in place. It is attached once per element and survives React replacing the inner HTML,
 * because it is on the container, not on the images. Module-level, so the ref's identity never changes and
 * React never detaches and re-attaches it.
 */
export function hideFailedImages(container: HTMLElement | null): void {
  container?.addEventListener(
    'error',
    (e) => {
      // An inline style rather than `hidden`: `hidden` is only a user-agent `display: none`, and any later
      // author rule such as `.content img { display: block }` would quietly bring the glyph back.
      if (e.target instanceof HTMLImageElement) e.target.style.display = 'none';
    },
    true,
  );
}
