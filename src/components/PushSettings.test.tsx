// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
vi.mock('../lib/push', async (original) => ({
  ...await original<typeof import('../lib/push')>(),
  preparePush: vi.fn().mockResolvedValue({}),
  pushSupport: vi.fn().mockReturnValue(null),
  pushState: vi.fn(),
  enablePush: vi.fn(),
}));
import PushSettings from './PushSettings';
import { DEFAULT_PUSH_PREFERENCES, dismissPushPrompt, enablePush, pushState, pushSupport } from '../lib/push';

let host: HTMLDivElement, root: Root;
beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  localStorage.clear();
  vi.mocked(pushSupport).mockReturnValue(null);
  vi.mocked(pushState).mockResolvedValue({ enabled: false, preferences: { ...DEFAULT_PUSH_PREFERENCES } });
  vi.mocked(enablePush).mockResolvedValue(undefined);
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
});
const render = (memberId: string | null = 'me', onSelectMe = vi.fn()) => act(async () => {
  root.render(<PushSettings key={memberId} tripId="trip" memberId={memberId} prompt onSelectMe={onSelectMe} />);
});
const click = (text: string) => act(async () => {
  const button = [...host.querySelectorAll('button')].find(b => b.textContent === text);
  expect(button).toBeDefined();
  button!.click();
});

describe('entry push prompt', () => {
  it('waits for the enable gesture, defaults every category on, and hides after success', async () => {
    await render();
    expect(host.textContent).toContain('Включить уведомления?');
    expect(enablePush).not.toHaveBeenCalled();
    await click('Включить');
    expect(enablePush).toHaveBeenCalledExactlyOnceWith('trip', 'me', {
      expenses: true, settlements: true, reminders: true,
    });
    expect(host.textContent).toBe('');
  });

  it('requires an identity before requesting permission', async () => {
    const select = vi.fn();
    await render(null, select);
    await click('Выбрать себя');
    expect(select).toHaveBeenCalledOnce();
    expect(enablePush).not.toHaveBeenCalled();
  });

  it('remembers Later for the selected person without suppressing another person', async () => {
    await render();
    await click('Позже');
    await act(async () => root.unmount());
    root = createRoot(host);
    await render();
    expect(host.textContent).toBe('');
    await render('other');
    expect(host.textContent).toContain('Включить уведомления?');
  });

  it('does not prompt subscribed users or users who explicitly opted out', async () => {
    vi.mocked(pushState).mockResolvedValue({ enabled: true, preferences: DEFAULT_PUSH_PREFERENCES });
    await render();
    expect(host.textContent).toBe('');
    dismissPushPrompt('trip', 'other');
    vi.mocked(pushState).mockResolvedValue({ enabled: false, preferences: DEFAULT_PUSH_PREFERENCES });
    await render('other');
    expect(host.textContent).toBe('');
    expect(enablePush).not.toHaveBeenCalled();
  });

  it('shows installation instructions instead of a non-working permission button', async () => {
    vi.mocked(pushSupport).mockReturnValue('На iPhone добавь Split Trip на экран «Домой» и открой его оттуда.');
    await render();
    expect(host.textContent).toContain('экран «Домой»');
    expect([...host.querySelectorAll('button')].map(b => b.textContent)).toEqual(['Позже']);
    expect(enablePush).not.toHaveBeenCalled();
  });

  it('keeps an actionable error when subscription fails', async () => {
    vi.mocked(enablePush).mockRejectedValueOnce(new Error('Сервис недоступен'));
    await render();
    await click('Включить');
    expect(host.querySelector('[role="alert"]')?.textContent).toBe('Сервис недоступен');
    await click('Включить');
    expect(host.textContent).toBe('');
  });
});
