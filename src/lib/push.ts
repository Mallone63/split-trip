const STORAGE_KEY = 'tripsplit:push-device:v1';
export interface PushPreferences {
  expenses: boolean;
  settlements: boolean;
  reminders: boolean;
}
interface Device {
  deviceId: string;
  deviceToken: string;
  tripId?: string;
  memberId?: string;
  preferences: PushPreferences;
}
export const DEFAULT_PUSH_PREFERENCES: PushPreferences = {
  expenses: true,
  settlements: true,
  reminders: true,
};
const base = import.meta.env.VITE_SUPABASE_URL as string | undefined;
const key = import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined;
export function pushSupport(): string | null {
  const ios =
    /iPad|iPhone|iPod/.test(navigator.userAgent) ||
    (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  const standalone =
    window.matchMedia?.('(display-mode: standalone)').matches ||
    (navigator as Navigator & { standalone?: boolean }).standalone;
  if (ios && !standalone)
    return 'На iPhone добавь Split Trip на экран «Домой» и открой его оттуда.';
  if (
    !('serviceWorker' in navigator) ||
    !('PushManager' in window) ||
    !('Notification' in window)
  )
    return 'Этот браузер не поддерживает пуш-уведомления.';
  if (Notification.permission === 'denied')
    return 'Уведомления запрещены. Разреши их в настройках браузера или iPhone.';
  return null;
}
function readDevice(): Device | null {
  try {
    const value = localStorage.getItem(STORAGE_KEY);
    return value ? JSON.parse(value) : null;
  } catch {
    return null;
  }
}
function saveDevice(device: Device) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(device));
}
export function pushPromptDismissed(tripId: string, memberId: string | null): boolean {
  try {
    return localStorage.getItem(`tripsplit:push-prompt:${tripId}:${memberId ?? 'unknown'}`) === '1';
  } catch { return false; }
}
export function dismissPushPrompt(tripId: string, memberId: string | null): void {
  try {
    localStorage.setItem(`tripsplit:push-prompt:${tripId}:${memberId ?? 'unknown'}`, '1');
  } catch { /* The prompt may reappear when storage is unavailable. */ }
}
function getDevice(): Device {
  let device = readDevice();
  if (device) return device;
  device = {
    deviceId: crypto.randomUUID(),
    deviceToken: [...crypto.getRandomValues(new Uint8Array(32))]
      .map((x) => x.toString(16).padStart(2, '0'))
      .join(''),
    preferences: { ...DEFAULT_PUSH_PREFERENCES },
  };
  saveDevice(device);
  return device;
}
async function call(action: string, body?: unknown) {
  if (!base || !key) throw new Error('Сервис уведомлений не настроен');
  const response = await fetch(`${base}/functions/v1/push/${action}`, {
    method: body ? 'POST' : 'GET',
    headers: {
      apikey: key,
      Authorization: `Bearer ${key}`,
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
    signal: AbortSignal.timeout(15000),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok)
    throw new Error(data.error || 'Сервис уведомлений временно недоступен');
  return data;
}
let prepared:
  | Promise<{ registration: ServiceWorkerRegistration; publicKey: string }>
  | undefined;
export function preparePush() {
  prepared ??= (async () => {
    const [registration, config] = await Promise.all([
      navigator.serviceWorker.register(new URL('sw.js', document.baseURI), {
        scope: new URL('./', document.baseURI).pathname,
      }),
      call('config'),
    ]);
    await navigator.serviceWorker.ready;
    if (typeof config.publicKey !== 'string' || config.publicKey.length < 80)
      throw new Error('Сервис уведомлений ещё не настроен');
    return { registration, publicKey: config.publicKey as string };
  })().catch((error) => {
    prepared = undefined;
    throw error;
  });
  return prepared;
}
function applicationKey(key: string): Uint8Array<ArrayBuffer> {
  const b = atob(key.replace(/-/g, '+').replace(/_/g, '/'));
  return Uint8Array.from(b, (c) => c.charCodeAt(0));
}
export async function pushState(tripId: string, memberId: string | null) {
  const d = readDevice();
  if (!d || d.tripId !== tripId || d.memberId !== memberId || pushSupport())
    return {
      enabled: false,
      preferences: d?.preferences ?? DEFAULT_PUSH_PREFERENCES,
    };
  const reg = await navigator.serviceWorker.getRegistration(
    new URL('./', document.baseURI),
  );
  return {
    enabled: !!(await reg?.pushManager.getSubscription()),
    preferences: d.preferences,
  };
}
export async function enablePush(
  tripId: string,
  memberId: string,
  preferences: PushPreferences,
) {
  const problem = pushSupport();
  if (problem) throw new Error(problem);
  // Request permission directly from the button's gesture, before awaiting network I/O.
  const permission = Notification.requestPermission();
  const knownDevice = readDevice();
  const device = getDevice();
  if ((await permission) !== 'granted')
    throw new Error('Разрешение на уведомления не получено');
  const { registration, publicKey } = await preparePush();
  let previous = await registration.pushManager.getSubscription();
  if (previous && !knownDevice) {
    await previous.unsubscribe();
    previous = null;
  }
  const subscription =
    previous ??
    (await registration.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: applicationKey(publicKey),
    }));
  await call('subscribe', {
    deviceId: device.deviceId,
    deviceToken: device.deviceToken,
    tripId,
    memberId,
    subscription: subscription.toJSON(),
    preferences,
  });
  saveDevice({ ...device, tripId, memberId, preferences });
  dismissPushPrompt(tripId, memberId);
}
export async function disablePush() {
  const d = readDevice();
  if (!d?.memberId) return;
  // Remove private server subscription first. If offline, keep identity unchanged and allow retry.
  await call('unsubscribe', {
    deviceId: d.deviceId,
    deviceToken: d.deviceToken,
  });
  if ('serviceWorker' in navigator) {
    const reg = await navigator.serviceWorker.getRegistration(
      new URL('./', document.baseURI),
    );
    await (await reg?.pushManager.getSubscription())?.unsubscribe();
  }
  saveDevice({ ...d, memberId: undefined, tripId: undefined });
  if (d.tripId) dismissPushPrompt(d.tripId, d.memberId);
}
export async function disconnectPushOnIdentityChange(
  tripId: string,
  memberId: string | null,
) {
  const d = readDevice();
  if (d?.memberId && (d.tripId !== tripId || d.memberId !== memberId))
    await disablePush();
}
/** The server checks the current debt, creditor identity and wallet cooldown. */
export async function remindDebt(input: {
  requestId: string;
  tripId: string;
  actorId: string;
  payerId: string;
  receiverId: string;
  currency: string;
}) {
  return call('remind', input);
}
