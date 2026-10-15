# EAS build profilleri (şoför uygulaması)

| Profil | Ne için | Çıktı | API adresi |
|---|---|---|---|
| `development` | Cihaz turu (arka plan konumu, push, navigasyon Expo Go'da çalışmaz) | Android APK, iOS dev client | `eas.json` içindeki LAN IP'si (`env`) |
| `preview` | Pilot öncesi iç dağıtım denemesi (gerçek API'ye karşı, dev client'sız) | Android APK (internal) | EAS ortamı `preview` |
| `production` | Pilot ve mağaza | Android AAB, iOS | EAS ortamı `production` |

`preview` ve `production` API adresini EAS ortam değişkeninden alır (koda gömülü adres yok):

```bash
cd apps/driver-mobile
eas env:create --environment production --name EXPO_PUBLIC_API_URL --value https://api.ornek.com --visibility plaintext
eas env:create --environment preview    --name EXPO_PUBLIC_API_URL --value https://api-test.ornek.com --visibility plaintext
eas build --profile development --platform android   # cihaz turu
eas build --profile production  --platform all
```

Notlar:
- `appVersionSource: remote` + `autoIncrement`: build numarası EAS'ta tutulur.
- Üretim API adresi HTTPS olmalı (Android cleartext trafiği varsayılan kapalıdır).
- Push için Expo credentials (FCM/APNs) EAS projesinde tanımlı olmalı; `EXPO_ACCESS_TOKEN` worker'da.
- iOS yerleşik şemalar ve Android `<queries>` `plugins/with-nav-queries` ile eklenir; yeni native modül eklenince yeni build gerekir.
- `app.json` → `extra.eas.projectId` ve `owner` EAS projesine bağlıdır; commitlenmelidir.
- `tsconfig.json` içinde `.expo/types/**/*.ts` ve `expo-env.d.ts` include'ları ve `expo-env.d.ts` dosyası repoda kalmalıdır (tipler `expo/types`'tan gelir).
