import { afterEach, describe, expect, it, vi } from 'vitest';
import manifestSource from '../../../public/manifest.webmanifest?raw';
import { getMe, getTripIdFromUrl, putTripIdInUrl, setMe } from '../api';
import { initializePwa } from '../pwa';

const manifest = JSON.parse(manifestSource);

function browser(href: string, savedTrip?: string, storageBlocked = false) {
  let location = new URL(href);
  const values = new Map<string, string>();
  if (savedTrip) values.set('tripsplit:lastTrip', savedTrip);
  const storage = {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value); },
    removeItem: (key: string) => { values.delete(key); },
  };
  const installed: { documentUrl: string; manifestUrl: string; rel: string }[] = [];
  let currentManifest: { remove: () => void } | null = null;
  vi.stubGlobal('window', {
    get location() { return location; },
    get localStorage() {
      if (storageBlocked) throw new Error('Storage blocked');
      return storage;
    },
    history: {
      replaceState: (_state: unknown, _title: string, url: string) => {
        location = new URL(url, location);
      },
    },
  });
  vi.stubGlobal('document', {
    querySelector: () => currentManifest,
    createElement: () => ({ rel: '', href: '', remove: () => { currentManifest = null; } }),
    head: {
      appendChild: (link: { rel: string; href: string; remove: () => void }) => {
        currentManifest = link;
        installed.push({
          documentUrl: location.href,
          manifestUrl: new URL(link.href, location).href,
          rel: link.rel,
        });
      },
    },
  });
  return { installed, values };
}

afterEach(() => { vi.unstubAllGlobals(); });

describe('PWA invite handoff', () => {
  it('uses the installation document URL rather than a fixed root launch URL', () => {
    // A fixed start_url strips the invite before a fresh iOS storage context opens.
    expect(manifest).not.toHaveProperty('start_url');
    expect(manifest.scope).toBe('./');
    expect(manifest.display).toBe('standalone');
  });

  it.each(['https://example.com/', 'https://example.com/split-trip/'])(
    'keeps the invite with empty standalone storage at %s',
    (base) => {
      const safari = browser(`${base}?trip=invited-trip`);
      initializePwa();
      expect(safari.installed).toEqual([{
        documentUrl: `${base}?trip=invited-trip`,
        manifestUrl: `${base}manifest.webmanifest?trip=invited-trip`,
        rel: 'manifest',
      }]);

      // The manifest has no start_url, so the installation document URL is
      // the launch URL. Simulate a new app with no Safari localStorage.
      const standalone = browser(safari.installed[0].documentUrl);
      expect(standalone.values.size).toBe(0);
      expect(getTripIdFromUrl()).toBe('invited-trip');
      putTripIdInUrl('invited-trip');
      expect(standalone.values.get('tripsplit:lastTrip')).toBe('invited-trip');
    },
  );

  it('restores the saved trip before the manifest is attached', () => {
    const safari = browser('https://example.com/split-trip/?view=balances#top', 'saved-trip');
    initializePwa();
    expect(safari.installed[0].documentUrl).toBe(
      'https://example.com/split-trip/?view=balances&trip=saved-trip#top',
    );
    browser(safari.installed[0].documentUrl);
    expect(getTripIdFromUrl()).toBe('saved-trip');
  });

  it('updates installation after creating a trip without a page navigation', () => {
    const safari = browser('https://example.com/split-trip/');
    initializePwa();
    putTripIdInUrl('created-trip');
    initializePwa();
    expect(safari.installed[1]).toEqual({
      documentUrl: 'https://example.com/split-trip/?trip=created-trip',
      manifestUrl: 'https://example.com/split-trip/manifest.webmanifest?trip=created-trip',
      rel: 'manifest',
    });
    browser(safari.installed[1].documentUrl);
    expect(getTripIdFromUrl()).toBe('created-trip');
  });

  it('prefers a new invite over a previous trip without persisting it before load', () => {
    const safari = browser('https://example.com/?trip=new-trip', 'old-trip');
    initializePwa();
    expect(safari.installed[0].documentUrl).toBe('https://example.com/?trip=new-trip');
    expect(getTripIdFromUrl()).toBe('new-trip');
    expect(safari.values.get('tripsplit:lastTrip')).toBe('old-trip');
  });

  it('still opens an invite when localStorage throws', () => {
    const safari = browser('https://example.com/?trip=invited-trip', undefined, true);
    initializePwa();
    expect(safari.installed).toHaveLength(1);
    expect(getTripIdFromUrl()).toBe('invited-trip');
    expect(() => putTripIdInUrl('invited-trip')).not.toThrow();
    expect(getMe('invited-trip')).toBeNull();
    expect(() => setMe('invited-trip', 'member')).not.toThrow();
    expect(() => setMe('invited-trip', null)).not.toThrow();
  });

  it('keeps a fresh visit on setup even when storage is blocked', () => {
    const safari = browser('https://example.com/split-trip/', undefined, true);
    initializePwa();
    expect(getTripIdFromUrl()).toBeNull();
    expect(safari.installed[0].documentUrl).toBe('https://example.com/split-trip/');
  });

  it('continues to remember and clear the local participant per trip', () => {
    browser('https://example.com/');
    setMe('trip-a', 'member-a');
    expect(getMe('trip-a')).toBe('member-a');
    expect(getMe('trip-b')).toBeNull();
    setMe('trip-a', null);
    expect(getMe('trip-a')).toBeNull();
  });
});
