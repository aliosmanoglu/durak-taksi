// Çağrı / yolculuk rotalarının otomatik açılıp kapanması (faz3 4.1). Ekran değil; (app) düzeninde bir kez bağlanır.
// Kurallar:
// - Eşleşmiş yolculuk belirince (soğuk açılış dahil) D2 açılır. Geri tuşuyla ana ekrana dönülürse yeniden
//   açılmaz (ana ekrandaki mavi kart ile dönülür). E5 (izin) sürerken beklenir.
// - Açık çağrı listesi boşken ilk çağrı belirince (ya da sync ile) D1 açılır; E5/D2 açıkken açılmaz, üstte
//   "Yeni çağrı var. GÖR" şeridi çıkar. Liste boşalınca D1 kendiliğinden kapanır.
// - Yolculuk kapanınca (durak iptal/tamamlama) D3 açılır; yolculuk başka bir nedenle bitince D2'den ana ekrana dönülür.
import { useEffect, useRef } from 'react';
import { Pressable, View } from 'react-native';
import { usePathname, useRouter } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { T } from '@/lib/texts';
import { colors, tones } from '@/lib/theme';
import { useApp } from './hooks';
import { Txt } from './Txt';

const isRidePath = (p: string) => p.startsWith('/ride/');
const isClosedPath = (p: string) => p === '/ride/closed';

export function RideNavigator() {
  const router = useRouter();
  const pathname = usePathname();
  const insets = useSafeAreaInsets();
  const activeId = useApp((s) => s.activeRide?.rideId ?? null);
  const closed = useApp((s) => s.closed != null);
  const requestCount = useApp((s) => s.requests.length);
  const liveCount = useApp((s) => s.requests.filter((r) => !r.taken).length);
  const unseenCount = useApp((s) => s.unseen.length);
  const accepting = useApp((s) => s.accepting != null);
  const pendingDecline = useApp((s) => s.pendingDecline != null);
  const server = useApp((s) => s.server);
  const perm = useApp((s) => s.perm);

  const shownRide = useRef<string | null>(null);
  const prevLive = useRef(0);

  // D2: eşleşmiş yolculuk belirince
  useEffect(() => {
    if (!activeId) {
      shownRide.current = null;
      return;
    }
    if (shownRide.current === activeId) return;
    // E5 sürerken (ya da henüz açılacakken) beklenir; izin akışı bitince bu efekt yeniden çalışır.
    if (perm === 'undetermined' || pathname === '/permissions' || isClosedPath(pathname)) return;
    shownRide.current = activeId;
    const target = `/ride/${activeId}`;
    if (pathname === target) return;
    if (pathname === '/requests') router.replace(target);
    else router.push(target);
  }, [activeId, pathname, perm, router]);

  // D2'den ana ekrana: yolculuk durak iptali/tamamlaması dışında bir nedenle bitti (D3 yoksa)
  useEffect(() => {
    if (!activeId && !closed && isRidePath(pathname) && !isClosedPath(pathname)) router.dismissTo('/');
  }, [activeId, closed, pathname, router]);

  // D3: yolculuk kapandı
  useEffect(() => {
    if (!closed || isClosedPath(pathname)) return;
    if (isRidePath(pathname)) router.replace('/ride/closed');
    else router.push('/ride/closed');
  }, [closed, pathname, router]);

  // D1: ilk çağrı belirince aç
  useEffect(() => {
    const prev = prevLive.current;
    prevLive.current = liveCount;
    if (prev !== 0 || liveCount === 0) return;
    if (server !== 'available' || activeId) return;
    if (pathname === '/permissions' || pathname === '/requests' || isRidePath(pathname)) return;
    router.push('/requests');
  }, [liveCount, server, activeId, pathname, router]);

  // D1: liste boşalınca (kabul/ret/kapanma) kapan. GERİ AL penceresi (bekleyen ret) sürerken açık kalır.
  useEffect(() => {
    if (pathname !== '/requests' || activeId || accepting || pendingDecline) return;
    if (requestCount === 0) router.dismissTo('/');
  }, [pathname, requestCount, activeId, accepting, pendingDecline, router]);

  const showBanner = liveCount > 0 && unseenCount > 0 && (pathname === '/permissions' || (isRidePath(pathname) && !isClosedPath(pathname)));
  if (!showBanner) return null;
  const t = tones.yellow;
  return (
    <View pointerEvents="box-none" style={{ position: 'absolute', top: insets.top + 8, left: 16, right: 16 }}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`${T.ride.banner.newRequest} ${T.ride.banner.see}`}
        onPress={() => router.push('/requests')}
        style={{
          minHeight: 56,
          flexDirection: 'row',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: 12,
          paddingHorizontal: 16,
          borderRadius: 16,
          backgroundColor: t.bg,
          borderWidth: 1,
          borderColor: t.border,
        }}
      >
        <Txt bold size={18} color={t.color}>
          {T.ride.banner.newRequest}
        </Txt>
        <Txt bold size={18} color={colors.bg} style={{ backgroundColor: t.color, paddingHorizontal: 14, paddingVertical: 8, borderRadius: 10 }}>
          {T.ride.banner.see}
        </Txt>
      </Pressable>
    </View>
  );
}
