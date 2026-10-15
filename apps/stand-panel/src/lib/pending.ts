// Yönetici: bekleyen hesap listeleri için saf yardımcılar.

export type PendingDriver = {
  id: string;
  fullName: string;
  phone: string;
  plate: string;
  licenseNo: string;
  vehicleModel: string | null;
  vehicleColor: string | null;
  createdAt: string;
};

export type PendingStand = {
  id: string;
  name: string;
  phone: string;
  address: string | null;
  username: string;
  createdAt: string;
};

export type PendingKind = 'drivers' | 'stands';

export const pendingListPath = (kind: PendingKind): string => `/admin/${kind}?status=pending`;
export const approvePath = (kind: PendingKind, id: string): string => `/admin/${kind}/${encodeURIComponent(id)}/approve`;

/** Onaylanan satırı listeden çıkarır (başka satıra dokunmaz). */
export function removeById<T extends { id: string }>(items: readonly T[], id: string): T[] {
  return items.filter((i) => i.id !== id);
}

/** "Model · Renk"; ikisi de yoksa boş çizgi. */
export function vehicleLabel(model: string | null, color: string | null): string {
  const parts = [model, color].map((s) => s?.trim()).filter((s): s is string => !!s);
  return parts.length ? parts.join(' · ') : '—';
}

export function formatCreatedAt(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '—' : d.toLocaleString('tr-TR', { timeZone: 'Europe/Istanbul' });
}
