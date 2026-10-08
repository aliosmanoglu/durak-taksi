// Prometheus metin biçimi okuyucu (Faz 5 metrik testleri).
/** Prometheus metninden `name{labels...}` serilerinin toplamı (etiket süzgeci verilirse yalnızca eşleşenler). */
export function metricSum(text: string, name: string, labels: Record<string, string> = {}): number {
  let sum = 0;
  for (const line of text.split('\n')) {
    if (line.startsWith('#') || !line.startsWith(name)) continue;
    const m = /^([a-zA-Z_:][a-zA-Z0-9_:]*)(\{[^}]*\})?\s+(\S+)/.exec(line);
    if (!m || m[1] !== name) continue;
    const ok = Object.entries(labels).every(([k, v]) => (m[2] ?? '').includes(`${k}="${v}"`));
    if (ok) sum += Number(m[3]);
  }
  return sum;
}
