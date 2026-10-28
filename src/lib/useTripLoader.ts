import { useEffect, useMemo, useSyncExternalStore } from 'react';
import { EMPTY_TRIP_STATE, TripLoader } from './tripLoader';

const emptySubscribe = () => () => {};
const emptySnapshot = () => EMPTY_TRIP_STATE;
const noRefresh = async () => {};
const noUpdate: TripLoader['setBundle'] = () => {};
const noInvalidate = () => {};

export function useTripLoader(tripId: string | null) {
  const loader = useMemo(() => tripId ? new TripLoader(tripId) : null, [tripId]);
  const state = useSyncExternalStore(loader?.subscribe ?? emptySubscribe, loader?.getSnapshot ?? emptySnapshot);

  useEffect(() => {
    if (!loader) return;
    void loader.refresh();
    const refresh = () => { void loader.refresh(); };
    const onVisible = () => {
      if (document.visibilityState === 'visible') refresh();
    };
    window.addEventListener('online', refresh);
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      window.removeEventListener('online', refresh);
      document.removeEventListener('visibilitychange', onVisible);
      loader.cancel();
    };
  }, [loader]);

  return {
    ...state,
    refresh: loader?.refresh ?? noRefresh,
    invalidate: loader?.invalidate ?? noInvalidate,
    setBundle: loader?.setBundle ?? noUpdate,
  };
}
