// Android 11+ paket görünürlüğü (CLAUDE.md Bölüm 7): `Linking.canOpenURL`'ün harita uygulamalarını doğru
// bulabilmesi için AndroidManifest.xml'e <queries> eklenir. Expo Go'da değil, development build'de çalışır.
const { withAndroidManifest } = require('expo/config-plugins');

const SCHEMES = ['google.navigation', 'yandexnavi', 'yandexmaps'];

module.exports = function withNavQueries(config) {
  return withAndroidManifest(config, (cfg) => {
    const manifest = cfg.modResults.manifest;
    manifest.queries = manifest.queries ?? [];
    const present = new Set(
      manifest.queries
        .flatMap((q) => q.intent ?? [])
        .flatMap((i) => i.data ?? [])
        .map((d) => d.$?.['android:scheme']),
    );
    for (const scheme of SCHEMES) {
      if (present.has(scheme)) continue;
      manifest.queries.push({
        intent: [
          {
            action: [{ $: { 'android:name': 'android.intent.action.VIEW' } }],
            data: [{ $: { 'android:scheme': scheme } }],
          },
        ],
      });
    }
    return cfg;
  });
};
