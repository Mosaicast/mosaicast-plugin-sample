// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 The Mosaicast Authors

import { describe, expect, it } from 'vitest';
import { DOC_KEY_PATTERN, declaredTypeFor } from '@mosaicast/plugin-sdk';
import {
  FAVOURITE_COUNT_KEY,
  HIGHLIGHT_KEY,
  defaultLocaleOf,
  episodeTarget,
  favouriteKey,
  javaStringHash,
  resolveHighlightText,
  type HighlightDoc,
} from './highlight-doc';

/**
 * What this module still owns after SDK 0.9.0 took the rest: **keys**, not paths.
 *
 * The suite that used to live here tested a `declaredType(file)` helper and a private extension→MIME
 * table, both of which the SDK now provides — see the last block for what replaced them.
 */
describe('doc keys — the part a plugin still names itself', () => {
  it('produces keys the host will accept, without a round trip to find out', () => {
    // DOC_KEY_PATTERN is the client-side mirror of the Java DocStore.KEY_PATTERN, and `ctx.docs` throws at
    // the call site against it rather than spending a 400 on a key it could see was malformed. Asserting
    // it here means a slug shape this plugin cannot address fails in CI and not in front of a podcaster.
    for (const key of [HIGHLIGHT_KEY, FAVOURITE_COUNT_KEY, favouriteKey('the-sample-cast-s01e06')]) {
      expect(DOC_KEY_PATTERN.test(key), key).toBe(true);
    }
  });

  it('puts the episode in the key, because a USER partition is flat', () => {
    // One partition per person, not one per person *and* episode — so the entity is what the key is for.
    // Note the direction: the pre-0.5.0 advice was the inverse (an entity scope with the user in the key),
    // which is what made per-user data addressable, and forgeable, by anybody.
    expect(favouriteKey('the-kraken')).toBe('fav:the-kraken');
  });

  it('addresses an episode as a scope rather than as a path string', () => {
    expect(episodeTarget('the-kraken')).toEqual({ type: 'episode', id: 'the-kraken' });
  });

  it('never needs percent-encoding, which is why none is applied', () => {
    // The key pattern has no room for a `%`. A slug that needed one could not be a key at all, so encoding
    // it would produce a key the host still refuses — differently, and with a worse message.
    expect(DOC_KEY_PATTERN.source).not.toContain('%');
    expect(favouriteKey('a-b.c_d')).not.toContain('%');
  });
});

/**
 * The cross-browser upload failure this plugin used to carry its own fix for, now the SDK's.
 *
 * A valid image was refused in Firefox and accepted in Chromium, because only one of them could name the
 * file's type: the host checks the **declared** type before it reads a byte (ARCHITECTURE §11.1), so a
 * `File` arriving with `type === ''` becomes `application/octet-stream` in the multipart body and is
 * refused as a type this plugin may not store — with the bytes of a perfectly good PNG behind it.
 *
 * Verified against a running core 0.6.15 at the time: byte-identical PNG, `image/png` → 201, `''` → 415
 * "content type 'application/octet-stream' is not one this plugin may store".
 *
 * `blobs.upload` normalises by default now, so the plugin passes the raw `File` and this block exists to
 * document *why* that is safe rather than to test the SDK's implementation of it.
 */
describe('declared upload type — the fix that moved into the SDK', () => {
  const bytes = new Uint8Array([137, 80, 78, 71]);

  it('recovers the type from the extension when the browser supplied none', () => {
    const file = new File([bytes], 'shot.png');
    expect(file.type).toBe(''); // the Firefox-on-an-unmapped-extension case, reproduced
    expect(declaredTypeFor(file)).toBe('image/png');
  });

  it('never widens what this plugin may store', () => {
    // Guessing is safe here *specifically because the host still reads the bytes* — a wrong guess becomes
    // the same 415 it would have been. It still must not name a type outside the manifest's declaration,
    // or the refusal a podcaster sees stops matching what the plugin asked for.
    const allowed = new Set((['image/png', 'image/jpeg', 'image/webp'] as const));
    for (const name of ['a.png', 'a.jpg', 'a.jpeg', 'a.webp']) {
      expect(allowed.has(declaredTypeFor(new File([bytes], name)) as never), name).toBe(true);
    }
  });

  it('leaves an extension nothing maps alone, so the host words the refusal', () => {
    expect(declaredTypeFor(new File([bytes], 'holiday.heic'))).toBe('');
    expect(declaredTypeFor(new File([bytes], 'screenshot'))).toBe('');
  });
});

/**
 * Reader-side language resolution (SDK 0.10.0).
 *
 * The one piece of the multi-language feature a *visitor* meets, and the one with the security-relevant
 * property: it looks up a code the host supplied and never one read out of the document, so keys a browser
 * invented inside `translations` are unreachable rather than merely unrendered.
 */
describe('resolveHighlightText — which language a reader gets', () => {
  const doc: HighlightDoc = {
    markdown: 'the squid shows up',
    translations: {
      de: { markdown: 'der Tintenfisch taucht auf', machineTranslated: true },
      nl: { markdown: 'de inktvis verschijnt' },
    },
  };

  it('returns the default-locale text for a reader in the default language', () => {
    expect(resolveHighlightText(doc, 'en', 'en')).toEqual({
      markdown: 'the squid shows up',
      locale: 'en',
      machineTranslated: false,
      fallback: false,
    });
  });

  it('returns the translation for a language the document has', () => {
    expect(resolveHighlightText(doc, 'nl', 'en')).toEqual({
      markdown: 'de inktvis verschijnt',
      locale: 'nl',
      machineTranslated: false,
      fallback: false,
    });
  });

  it('carries the machine-translated flag through to the reader', () => {
    // Provenance is stored, not a workflow state: a person reading a paragraph is entitled to know an
    // engine produced it, and clearing the flag on save would be passing it off as an original.
    expect(resolveHighlightText(doc, 'de', 'en').machineTranslated).toBe(true);
  });

  it('falls back to the site default and says so', () => {
    const resolved = resolveHighlightText(doc, 'fr', 'en');
    expect(resolved.markdown).toBe('the squid shows up');
    expect(resolved.locale).toBe('en');
    expect(resolved.fallback).toBe(true);
  });

  it('does not negotiate a regional code down to its base language', () => {
    // `pt-br` is *not* quietly served `pt`. Negotiating one code into another is the host's job — it owns
    // the registry, the catalogs and the Accept-Language handling — and a plugin doing its own would answer
    // differently from the shell wrapped around it on the same page.
    expect(resolveHighlightText({ markdown: 'x', translations: { de: { markdown: 'y' } } }, 'de-at', 'en')
      .fallback).toBe(true);
  });

  it('ignores a translation whose text is blank', () => {
    // The editor cannot produce one — an emptied tab is dropped on save — but a hand-written document or an
    // older version can, and an empty tile is a worse answer than the original.
    const blank: HighlightDoc = { markdown: 'the squid', translations: { de: { markdown: '  ' } } };
    expect(resolveHighlightText(blank, 'de', 'en').markdown).toBe('the squid');
  });

  it('cannot be reached by a key a client invented', () => {
    // `translations` sits inside a JSON value, so the host's doc-key pattern never sees these keys and
    // nothing validated them on the way in. The defence is not a filter: the lookup asks for the locale the
    // *host* handed over, so a forged key has no path to a reader at all.
    const forged: HighlightDoc = {
      markdown: 'the squid',
      translations: { '<script>alert(1)</script>': { markdown: 'pwned' } },
    };
    expect(resolveHighlightText(forged, 'en', 'en').markdown).toBe('the squid');
    expect(resolveHighlightText(forged, 'de', 'en').markdown).toBe('the squid');
  });
});

describe('defaultLocaleOf — the site default, never hardcoded', () => {
  it('reads isDefault rather than trusting position', () => {
    // Languages are a runtime registry an operator edits, so a plugin that assumed `en` is simply wrong on
    // a site whose default is Dutch.
    expect(
      defaultLocaleOf([
        { code: 'de', nativeName: 'Deutsch', isDefault: false },
        { code: 'nl', nativeName: 'Nederlands', isDefault: true },
      ]),
    ).toBe('nl');
  });

  it('falls back to the first entry for a host that broke its own contract', () => {
    // `content()` is documented as never empty and as carrying exactly one default. This is belt and
    // braces, not a case the code expects.
    expect(defaultLocaleOf([{ code: 'de', nativeName: 'Deutsch', isDefault: false }])).toBe('de');
    expect(defaultLocaleOf([])).toBe('en');
  });
});

describe('javaStringHash — agreeing with the backend', () => {
  it('matches java.lang.String.hashCode for known values', () => {
    // Pinned against values the JDK produces, because the whole point is that two runtimes agree: the
    // backend stamps a draft with the hash of its source, and this side decides whether that source has
    // since been rewritten.
    expect(javaStringHash('')).toBe(0);
    expect(javaStringHash('a')).toBe(97);
    expect(javaStringHash('hello')).toBe(99162322);
    expect(javaStringHash('the squid shows up')).toBe(javaStringHash('the squid shows up'));
  });

  it("stays inside Java's 32-bit signed overflow", () => {
    // Without the `| 0` per step, JavaScript's doubles silently diverge past 2^53 and every draft for a long
    // highlight looks stale.
    const long = 'the squid shows up, and the keeper speaks, and nothing is ever the same again';
    expect(Number.isSafeInteger(javaStringHash(long))).toBe(true);
    expect(javaStringHash(long)).toBeGreaterThanOrEqual(-(2 ** 31));
    expect(javaStringHash(long)).toBeLessThan(2 ** 31);
  });
});
