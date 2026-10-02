import type { StorageBrowserEventValue } from '@aws-amplify/ui-react-storage/browser';

/**
 * Mirror of the Storage Browser's current location (bucket + prefix + path), fed by the component's
 * `onValueChange`. `PortalDataTable` needs it to turn a row's display name back into a full object key.
 */
export interface CurrentLocation {
  bucket: string;
  /** location prefix + navigated sub-path; `key = locationKey + rowName` */
  locationKey: string;
  actionType: string | undefined;
}

let current: CurrentLocation | null = null;
const listeners = new Set<() => void>();

export function onStorageBrowserValueChange(value: StorageBrowserEventValue): void {
  const loc = value.location;
  current = loc
    ? { bucket: loc.bucket, locationKey: `${loc.prefix}${loc.path ?? ''}`, actionType: value.actionType }
    : null;
  for (const l of listeners) l();
}

export function getCurrentLocation(): CurrentLocation | null {
  return current;
}

export function subscribeLocation(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** test helper */
export function resetLocation(): void {
  current = null;
  for (const l of listeners) l();
}
