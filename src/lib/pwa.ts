import { getTripIdFromUrl, putTripIdInUrl } from './api';

/** Bind installation to the invite URL, even when Safari restored a saved trip. */
export function initializePwa(): void {
  if (!new URLSearchParams(window.location.search).get('trip')) {
    const tripId = getTripIdFromUrl();
    if (tripId) putTripIdInUrl(tripId);
  }

  // No start_url in the manifest: installation uses this document's URL,
  // including ?trip=. iOS standalone storage may be separate from Safari's.
  // Attach only after restoring the URL so installation never captures './'.
  // Creating a trip changes the URL without navigating. Reattach a distinct
  // manifest URL so the browser processes it with the new document URL too.
  document.querySelector('link[rel="manifest"]')?.remove();
  const tripId = new URLSearchParams(window.location.search).get('trip');
  const manifest = document.createElement('link');
  manifest.rel = 'manifest';
  manifest.href = `manifest.webmanifest${tripId ? `?trip=${encodeURIComponent(tripId)}` : ''}`;
  document.head.appendChild(manifest);
}
