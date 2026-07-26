// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 The Mosaicast Authors

import { act } from 'react';

/**
 * Flushes pending microtasks under `act()`. The mock `ctx.api` client resolves its own promise before
 * a component's `.then(setState)` runs, so a single `await Promise.resolve()` isn't enough — two hops are
 * needed before React's state update actually lands.
 */
export async function flush() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}
