// Shared Nominatim access rules. The OSMF usage policy allows an absolute maximum of 1 request/second per
// application, so every Nominatim call in this process (geocoding and the venue fallback) goes through
// one queue that spaces request starts at least 1 s apart.

export const NOMINATIM_SEARCH = "https://nominatim.openstreetmap.org/search";

const MIN_INTERVAL_MS = 1_000;
let queue: Promise<void> = Promise.resolve();
let lastAt = Number.NEGATIVE_INFINITY;

/** Resolves when this caller may send its Nominatim request. */
export function nominatimSlot(): Promise<void> {
  const slot = queue.then(async () => {
    const wait = lastAt + MIN_INTERVAL_MS - Date.now();
    if (wait > 0) await new Promise<void>((resolve) => setTimeout(resolve, wait));
    lastAt = Date.now();
  });
  queue = slot.catch(() => undefined);
  return slot;
}

/** Test hook: forget the last Nominatim request time. */
export function _resetNominatimThrottle(): void {
  queue = Promise.resolve();
  lastAt = Number.NEGATIVE_INFINITY;
}
