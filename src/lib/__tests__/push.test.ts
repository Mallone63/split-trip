// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const getSubscription = vi.fn(),
  subscribe = vi.fn(),
  unsub = vi.fn(),
  permission = vi.fn(),
  http = vi.fn();
let push: typeof import('../push');
beforeEach(async () => {
  vi.resetModules();
  localStorage.clear();
  vi.stubEnv('VITE_SUPABASE_URL', 'https://example.supabase.co');
  vi.stubEnv('VITE_SUPABASE_ANON_KEY', 'anon');
  vi.stubGlobal('fetch', http);
  vi.stubGlobal('PushManager', class {});
  vi.stubGlobal('Notification', {
    permission: 'default',
    requestPermission: permission,
  });
  permission.mockResolvedValue('granted');
  unsub.mockResolvedValue(true);
  const sub = {
    toJSON: () => ({
      endpoint: 'https://web.push.apple.com/test',
      keys: { p256dh: 'a'.repeat(87), auth: 'b'.repeat(22) },
    }),
    unsubscribe: unsub,
  };
  getSubscription.mockResolvedValue(null);
  subscribe.mockResolvedValue(sub);
  const registration = { pushManager: { getSubscription, subscribe } };
  Object.defineProperty(navigator, 'serviceWorker', {
    configurable: true,
    value: {
      register: vi.fn(async () => registration),
      ready: Promise.resolve(registration),
      getRegistration: vi.fn(async () => registration),
    },
  });
  http.mockImplementation(async (url: string) =>
    Response.json(
      url.endsWith('/config')
        ? { publicKey: 'B' + 'a'.repeat(86) }
        : { subscribed: true },
    ),
  );
  push = await import('../push');
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.resetAllMocks();
});
describe('device push lifecycle', () => {
  it('requests permission during the click before network work, persists scope, and uses the same device on preference update', async () => {
    const pending = push.enablePush(
      'trip',
      'member',
      push.DEFAULT_PUSH_PREFERENCES,
    );
    expect(permission).toHaveBeenCalledOnce();
    await pending;
    expect(push.pushPromptDismissed('trip', 'member')).toBe(true);
    const first = JSON.parse(
      http.mock.calls.find((c) => String(c[0]).endsWith('/subscribe'))![1].body,
    );
    expect(first).toMatchObject({
      tripId: 'trip',
      memberId: 'member',
      preferences: { expenses: true },
    });
    expect(first.deviceToken).toMatch(/^[a-f0-9]{64}$/);
    http.mockClear();
    await push.enablePush('trip', 'member', {
      ...push.DEFAULT_PUSH_PREFERENCES,
      expenses: false,
    });
    expect(JSON.parse(http.mock.calls[0][1].body)).toMatchObject({
      deviceId: first.deviceId,
      deviceToken: first.deviceToken,
      preferences: { expenses: false },
    });
  });
  it('does not subscribe or call the server after permission is denied', async () => {
    permission.mockResolvedValue('denied');
    await expect(
      push.enablePush('trip', 'member', push.DEFAULT_PUSH_PREFERENCES),
    ).rejects.toThrow('Разрешение');
    expect(subscribe).not.toHaveBeenCalled();
    expect(http).not.toHaveBeenCalled();
  });
  it('disconnects the old identity before changing it, and keeps it on server failure for retry', async () => {
    await push.enablePush('trip', 'member', push.DEFAULT_PUSH_PREFERENCES);
    getSubscription.mockResolvedValue({ unsubscribe: unsub });
    http.mockClear();
    http.mockResolvedValueOnce(
      Response.json({ error: 'Offline' }, { status: 503 }),
    );
    await expect(
      push.disconnectPushOnIdentityChange('trip', 'other'),
    ).rejects.toThrow('Offline');
    expect(unsub).not.toHaveBeenCalled();
    await push.disconnectPushOnIdentityChange('trip', 'other');
    expect(unsub).toHaveBeenCalledOnce();
    expect(push.pushPromptDismissed('trip', 'member')).toBe(true);
    expect(push.pushPromptDismissed('trip', 'other')).toBe(false);
    expect(await push.pushState('trip', 'member')).toMatchObject({
      enabled: false,
    });
  });
  it('rotates a leftover browser subscription when local device credentials were lost', async () => {
    getSubscription.mockResolvedValue({ unsubscribe: unsub });
    await push.enablePush('trip', 'member', push.DEFAULT_PUSH_PREFERENCES);
    expect(unsub).toHaveBeenCalledOnce();
    expect(subscribe).toHaveBeenCalledOnce();
  });
});
