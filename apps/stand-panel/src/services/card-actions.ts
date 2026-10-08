// Kart üzerindeki yerel (sunucuya yazmayan) eylemler. "BEKLEMEYE DEVAM" yalnızca bandı kapatır.
import { dismissDriverCancelled, dismissStillOpen } from '../lib/rides';
import { updateRides } from '../store';

export function dismissCardBanner(rideId: string, kind: 'stillOpen' | 'driverCancelled'): void {
  updateRides((s) => (kind === 'stillOpen' ? dismissStillOpen(s, rideId) : dismissDriverCancelled(s, rideId)));
}
