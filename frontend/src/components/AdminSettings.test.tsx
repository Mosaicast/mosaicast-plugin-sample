// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 The Mosaicast Authors

import { describe, expect, it } from 'vitest';
import { createRoot } from 'react-dom/client';
import { act } from 'react';
import { makeMockCtx } from '@mosaicast/plugin-sdk/testing';
import type { MockApiClient } from '@mosaicast/plugin-sdk/testing';
import type { PluginContext } from '@mosaicast/plugin-sdk';
import { flush } from '../test-utils';
import { AdminSettings } from './AdminSettings';

function mount(ctx: PluginContext) {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => {
    root.render(<AdminSettings ctx={ctx} />);
  });
  return container;
}

const nativeInputValueSetter = () =>
  Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!;

describe('AdminSettings — the plugin-owned site/sidebar podcaster settings panel', () => {
  it('loads the current heading override and font from the store', async () => {
    const ctx = makeMockCtx({
      scope: { type: 'site', id: 'main' },
      user: { id: 'u1', role: 'podcaster' },
      apiResponses: { 'get data/site/main/settings': { headingOverride: '🎙️ Producer’s Pick', fontFamily: 'serif' } },
    });
    const container = mount(ctx);
    await flush();

    const input = container.querySelector('input[type="text"]') as HTMLInputElement;
    expect(input.value).toBe('🎙️ Producer’s Pick');
    const select = container.querySelector('select') as HTMLSelectElement;
    expect(select.value).toBe('serif');
  });

  it('writes the edited settings back via ctx.api.put on Save', async () => {
    const ctx = makeMockCtx({
      scope: { type: 'site', id: 'main' },
      user: { id: 'u1', role: 'podcaster' },
    });
    const container = mount(ctx);
    await flush();

    const input = container.querySelector('input[type="text"]') as HTMLInputElement;
    act(() => {
      nativeInputValueSetter().call(input, 'New heading');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });

    const select = container.querySelector('select') as HTMLSelectElement;
    act(() => {
      select.value = 'mono';
      select.dispatchEvent(new Event('change', { bubbles: true }));
    });

    const saveButton = Array.from(container.querySelectorAll('button')).find((b) => b.textContent === 'Save settings')!;
    act(() => {
      saveButton.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    await flush();

    expect(ctx.api.calls).toContainEqual({
      method: 'put',
      path: 'data/site/main/settings',
      body: { headingOverride: 'New heading', fontFamily: 'mono' },
    });
    expect(container.textContent).toContain('Saved');
    expect(ctx.logs).toContainEqual({ level: 'info', message: 'site highlight settings saved' });
  });

  it('logs a warning and does not show "Saved" when the save fails', async () => {
    const mockApi: MockApiClient = {
      calls: [],
      responses: {},
      get: () => Promise.resolve(undefined as never),
      post: () => Promise.reject(new Error('nope')),
      put: () => Promise.reject(new Error('network down')),
      delete: () => Promise.resolve(undefined as never),
    };
    const ctx = makeMockCtx({
      scope: { type: 'site', id: 'main' },
      user: { id: 'u1', role: 'podcaster' },
      api: mockApi,
    });
    const container = mount(ctx);
    await flush();

    const saveButton = Array.from(container.querySelectorAll('button')).find((b) => b.textContent === 'Save settings')!;
    await act(async () => {
      saveButton.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await flush();
    });

    expect(container.textContent).not.toContain('Saved');
    expect(ctx.logs).toContainEqual({ level: 'warn', message: 'site highlight settings save failed: network down' });
  });
});
