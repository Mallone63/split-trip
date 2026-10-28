import { loadTripBundle, type TripBundle } from './api';
import { errorMessage, TripNotFoundError } from './errors';
import { readTripCache, removeTripCache, writeTripCache } from './tripCache';

export const TRIP_LOAD_TIMEOUT_MS = 12_000;
export interface TripLoadState {
  bundle: TripBundle | null;
  updatedAt: number | null;
  refreshing: boolean;
  error: string | null;
}

export const EMPTY_TRIP_STATE: TripLoadState = {
  bundle: null, updatedAt: null, refreshing: false, error: null,
};

/** One cancellable request per trip, shared by Retry, reconnect and realtime. */
export class TripLoader {
  private state: TripLoadState;
  private listeners = new Set<() => void>();
  private request: { controller: AbortController; promise: Promise<void> } | null = null;
  private revalidateQueued = false;

  constructor(
    private tripId: string,
    private load = loadTripBundle,
    private timeoutMs = TRIP_LOAD_TIMEOUT_MS,
  ) {
    const cached = readTripCache(tripId);
    this.state = { ...EMPTY_TRIP_STATE, bundle: cached?.bundle ?? null, updatedAt: cached?.updatedAt ?? null };
  }

  getSnapshot = (): TripLoadState => this.state;
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  };

  private publish(patch: Partial<TripLoadState>) {
    this.state = { ...this.state, ...patch };
    this.listeners.forEach((listener) => listener());
  }

  cancel = (): void => {
    this.revalidateQueued = false;
    const previous = this.request;
    this.request = null;
    previous?.controller.abort();
    if (this.state.refreshing) this.publish({ refreshing: false });
  };

  // A realtime event may describe a write made after an in-flight read began.
  // Coalesce a burst into one follow-up rather than dropping those changes.
  invalidate = (): void => {
    if (this.request) this.revalidateQueued = true;
    else void this.refresh();
  };

  // Called only after a server mutation succeeds. Cancel older reads so they
  // cannot overwrite that mutation with a snapshot taken before the write.
  setBundle = (update: (current: TripBundle | null) => TripBundle | null): void => {
    const needsRevalidation = Boolean(this.request);
    this.cancel();
    const bundle = update(this.state.bundle);
    if (!bundle) return;
    writeTripCache(bundle, this.state.updatedAt ?? Date.now());
    this.publish({ bundle });
    if (needsRevalidation) void this.refresh();
  };

  refresh = (): Promise<void> => {
    if (this.request) return this.request.promise;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    const result = new Promise<TripBundle>((resolve, reject) => {
      controller.signal.addEventListener('abort', () => {
        reject(new Error('Загрузка отменена'));
      }, { once: true });
      timer = setTimeout(() => {
        reject(new Error('Не удалось загрузить данные за 12 секунд. Проверьте соединение и повторите загрузку.'));
        controller.abort();
      }, this.timeoutMs);
      // Also bounds a loader that does not react to AbortSignal (e.g. auth waits).
      Promise.resolve().then(() => {
        if (controller.signal.aborted) throw new Error('Загрузка отменена');
        return this.load(this.tripId, controller.signal);
      }).then(resolve, reject);
    });
    const request = { controller, promise: Promise.resolve() };
    this.request = request;
    this.publish({ refreshing: true, error: null });
    request.promise = result.then((bundle) => {
      if (this.request !== request) return;
      const updatedAt = Date.now();
      writeTripCache(bundle, updatedAt);
      this.publish({ bundle, updatedAt, error: null });
    }).catch((err: unknown) => {
      if (this.request !== request) return;
      if (err instanceof TripNotFoundError) {
        removeTripCache(this.tripId);
        this.publish({ bundle: null, updatedAt: null });
      }
      this.publish({ error: errorMessage(err) });
    }).finally(() => {
      clearTimeout(timer);
      if (this.request !== request) return;
      this.request = null;
      this.publish({ refreshing: false });
      if (this.revalidateQueued) {
        this.revalidateQueued = false;
        void this.refresh();
      }
    });
    return request.promise;
  };
}
