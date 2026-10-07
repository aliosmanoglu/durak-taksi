// İstemci logu. Gizlilik (tasarım Bölüm 8): telefon, ham koordinat ve token YAZILMAZ. Alanlar yalnızca
// sayı / boolean / kısa kod dizesi olabilir; konum en fazla doğruluk kovası (`accuracyBucket`) olarak loglanır.
type Field = string | number | boolean | null | undefined;

const isDev = typeof __DEV__ !== 'undefined' ? __DEV__ : process.env.NODE_ENV !== 'production';

export function log(event: string, fields?: Record<string, Field>) {
  if (!isDev) return;
  console.log(`[dn] ${event}`, fields ?? '');
}

declare const __DEV__: boolean | undefined;
