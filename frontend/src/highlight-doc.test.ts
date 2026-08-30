// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 The Mosaicast Authors

import { describe, expect, it } from 'vitest';
import { declaredType } from './highlight-doc';

/**
 * Regression tests for a cross-browser upload failure: a valid image, refused in Firefox and accepted in
 * Chromium, because only one of them could name the file's type.
 *
 * The host checks the **declared** type before it reads a byte (ARCHITECTURE §11.1), so a `File` that
 * arrives with `type === ''` becomes `application/octet-stream` in the multipart body and is refused as a
 * type this plugin may not store — with the bytes of a perfectly good PNG sitting behind it.
 *
 * Verified against a running core 0.6.15: byte-identical PNG, `image/png` → 201, `''` → 415
 * "content type 'application/octet-stream' is not one this plugin may store".
 */
describe('declaredType — the type a browser did not supply', () => {
  const bytes = new Uint8Array([137, 80, 78, 71]);

  it('leaves a file that already knows its type completely alone', () => {
    const file = new File([bytes], 'shot.png', { type: 'image/png' });
    // Same object, not a copy: re-wrapping a 5 MB upload for nothing is worth avoiding, and identity
    // is the cheapest way to assert it did not happen.
    expect(declaredType(file)).toBe(file);
  });

  it('names the type from the extension when the browser supplied none', () => {
    const file = new File([bytes], 'shot.png');
    expect(file.type).toBe(''); // the Firefox-on-an-unmapped-extension case, reproduced
    expect(declaredType(file).type).toBe('image/png');
  });

  it('treats application/octet-stream as "unnamed" too', () => {
    // Some platforms hand over the generic type rather than an empty one. It is equally unstorable, and
    // equally not what the file is.
    const file = new File([bytes], 'shot.webp', { type: 'application/octet-stream' });
    expect(declaredType(file).type).toBe('image/webp');
  });

  it('covers every extension the manifest and the picker allow', () => {
    for (const [name, expected] of [
      ['a.png', 'image/png'],
      ['a.jpg', 'image/jpeg'],
      ['a.jpeg', 'image/jpeg'],
      ['a.jfif', 'image/jpeg'], // a .jpg by another name, and one platforms routinely fail to map
      ['a.webp', 'image/webp'],
      ['A.PNG', 'image/png'], // the extension is matched case-insensitively
    ] as const) {
      expect(declaredType(new File([bytes], name)).type, name).toBe(expected);
    }
  });

  it('keeps the name and the bytes', () => {
    const file = new File([bytes], 'holiday snap.png');
    const retyped = declaredType(file);
    expect(retyped.name).toBe('holiday snap.png');
    expect(retyped.size).toBe(bytes.length);
  });

  it('passes through an extension nothing maps, so the host words the refusal', () => {
    // Guessing here would mean inventing a claim the browser never made. Leaving it alone lets the host
    // refuse it with its own message — which is the one the podcaster can act on.
    const file = new File([bytes], 'holiday.heic');
    expect(declaredType(file).type).toBe('');
    const noExtension = new File([bytes], 'screenshot');
    expect(declaredType(noExtension).type).toBe('');
  });

  it('never invents a type the manifest does not declare', () => {
    // The guess is only ever restoring a claim; it must not widen what this plugin can store. Every
    // value this can produce has to be in the manifest's `blobs.mimeTypes`.
    const allowed = new Set(['image/png', 'image/jpeg', 'image/webp']);
    for (const name of ['a.png', 'a.jpg', 'a.jpeg', 'a.jfif', 'a.webp']) {
      expect(allowed.has(declaredType(new File([bytes], name)).type)).toBe(true);
    }
  });
});
