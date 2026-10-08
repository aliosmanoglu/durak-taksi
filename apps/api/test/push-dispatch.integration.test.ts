// Faz 5 push hattı (docs/design/faz5-resilience.md Bölüm 1): worker dispatch sahte PushSender'a bildirim gönderir.
// Push yalnızca bildirimdir; socket `ride_requested` ile paralel gider ve biri diğerini beklemez.
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { DRIVER_EVENTS, PUSH, STAND_EVENTS } from '@duraknet/shared';
import { startRideApp, type RideApp } from './helpers/ride-app';
import { FakePushSender, uniquePushToken } from './helpers/push';
import { emitAck, north, Scope, sleep, uniqueCity, waitFor } from './helpers/rides';

let t: RideApp;
let s: Scope;
const sender = new FakePushSender();
beforeAll(async () => {
  t = await startRideApp({ workerExtras: { push: sender, pushReceiptDelayMs: 500 } });
});
afterEach(async () => {
  await s?.cleanup();
  sender.clear();
  sender.failAll = false;
  sender.ticketErrors.clear();
});
afterAll(async () => {
  await t?.close();
});

const forRide = (rideId: string) => (e: { rideId: string }) => e.rideId === rideId;
const setToken = (id: string, token: string | null) =>
  t.db.updateTable('drivers').set({ push_token: token }).where('id', '=', id).execute();
const tokenOf = async (id: string) =>
  (await t.db.selectFrom('drivers').select('push_token').where('id', '=', id).executeTakeFirstOrThrow()).push_token;

describe('ride_requested push', () => {
  it('yalnızca token\'ı olan adaya gider; içerik adres/not taşımaz, data.type ve rideId vardır', async () => {
    s = new Scope(t);
    const city = uniqueCity();
    const stand = await s.stand(city, { initialRadiusM: 1000, maxRadiusM: 3000 });
    const withTok = await s.driver(north(city, 300));
    const noTok = await s.driver(north(city, 400));
    const tok = uniquePushToken();
    await setToken(withTok.id, tok);

    const { rideId } = await s.createRide(stand, stand.location, { notes: 'Hastane acil girişi' });
    await withTok.rec.waitFor(DRIVER_EVENTS.rideRequested, forRide(rideId), { ms: 10_000 });
    await noTok.rec.waitFor(DRIVER_EVENTS.rideRequested, forRide(rideId), { ms: 10_000 });
    const msg = (await waitFor(async () => sender.to(tok), (m) => m.length > 0, 8000))[0]!;

    expect(msg.title).toBe('Yeni çağrı');
    expect(msg.body).toContain('Test Durağı');
    // Kilit ekranında adres ve not görünmemeli.
    expect(JSON.stringify(msg)).not.toContain('Test Mah.');
    expect(JSON.stringify(msg)).not.toContain('Hastane');
    expect(msg.data).toEqual({ type: 'ride_requested', rideId });
    expect(msg.channelId).toBe(PUSH.ANDROID_CHANNEL);
    expect(msg.priority).toBe('high');
    expect(msg.ttl).toBe(PUSH.TTL_S);
    expect(msg.sound).toBe('default');

    // Token'ı olmayan şoföre hiçbir mesaj gitmedi; gönderilenlerin hepsi tek alıcıya.
    await sleep(800);
    expect(new Set(sender.sent.map((m) => m.to))).toEqual(new Set([tok]));
  }, 30_000);

  it('sürekli taramada aynı adaya ikinci push gitmez; sonradan aktif olan yeni aday push alır', async () => {
    s = new Scope(t);
    const city = uniqueCity();
    const stand = await s.stand(city, { initialRadiusM: 1000, maxRadiusM: 3000 });
    const first = await s.driver(north(city, 300));
    const tokFirst = uniquePushToken();
    await setToken(first.id, tokFirst);
    const { rideId } = await s.createRide(stand);
    await waitFor(async () => sender.to(tokFirst), (m) => m.length === 1, 8000);

    // En az birkaç dalga daha geçsin.
    await stand.rec.waitFor(STAND_EVENTS.rideSearching, forRide(rideId), { n: 5, ms: 15_000 });
    expect(sender.to(tokFirst)).toHaveLength(1);

    const late = await s.driver(north(city, 500), { online: false });
    const tokLate = uniquePushToken();
    await setToken(late.id, tokLate);
    await emitAck(late.socket, DRIVER_EVENTS.goOnline, { location: north(city, 500) });
    const m = (await waitFor(async () => sender.to(tokLate), (x) => x.length > 0, 8000))[0]!;
    expect(m.data).toEqual({ type: 'ride_requested', rideId });
    await sleep(1000);
    expect(sender.to(tokLate)).toHaveLength(1);
    expect(sender.to(tokFirst)).toHaveLength(1);
  }, 40_000);

  it('ret eden (excluded) şoföre sürekli taramada tekrar push gitmez', async () => {
    s = new Scope(t);
    const city = uniqueCity();
    const stand = await s.stand(city, { initialRadiusM: 1000, maxRadiusM: 3000 });
    const d = await s.driver(north(city, 300));
    const tok = uniquePushToken();
    await setToken(d.id, tok);
    const { rideId } = await s.createRide(stand);
    await waitFor(async () => sender.to(tok), (m) => m.length === 1, 8000);
    expect((await emitAck(d.socket, DRIVER_EVENTS.rideDecline, { rideId })).ok).toBe(true);
    await stand.rec.waitFor(STAND_EVENTS.rideSearching, forRide(rideId), { n: 4, ms: 15_000 });
    expect(sender.to(tok)).toHaveLength(1);
  }, 30_000);

  it('DeviceNotRegistered: token PG\'de NULL\'lanır; çağrı socket ile yine ulaşır', async () => {
    s = new Scope(t);
    const city = uniqueCity();
    const stand = await s.stand(city, { initialRadiusM: 1000, maxRadiusM: 3000 });
    const d = await s.driver(north(city, 300));
    const tok = uniquePushToken();
    await setToken(d.id, tok);
    sender.ticketErrors.set(tok, 'DeviceNotRegistered');

    const { rideId } = await s.createRide(stand);
    await d.rec.waitFor(DRIVER_EVENTS.rideRequested, forRide(rideId), { ms: 10_000 });
    await waitFor(() => tokenOf(d.id), (v) => v === null, 8000);
    expect(sender.to(tok)).toHaveLength(1);
  }, 30_000);

  it('makbuz (receipt) DeviceNotRegistered dönerse gecikmeli kontrol token temizler', async () => {
    s = new Scope(t);
    const city = uniqueCity();
    const stand = await s.stand(city, { initialRadiusM: 1000, maxRadiusM: 3000 });
    const d = await s.driver(north(city, 300));
    const tok = uniquePushToken();
    await setToken(d.id, tok);
    // Ticket ok; makbuz, ticket kaydedildikten sonra hata verecek: id'yi önceden bilemeyiz, sender her yeni id için hata döner.
    sender.receiptErrors.set('*', 'DeviceNotRegistered');
    const orig = sender.getReceipts.bind(sender);
    sender.getReceipts = async (ids: string[]) =>
      Object.fromEntries(ids.map((id) => [id, { status: 'error', message: 'x', details: { error: 'DeviceNotRegistered' } }])) as Awaited<ReturnType<typeof orig>>;
    try {
      await s.createRide(stand);
      await waitFor(async () => sender.to(tok), (m) => m.length > 0, 8000);
      await waitFor(() => tokenOf(d.id), (v) => v === null, 10_000);
    } finally {
      sender.getReceipts = orig;
      sender.receiptErrors.clear();
    }
  }, 30_000);

  it('başka bir ticket hatası (ör. MessageRateExceeded) token\'ı silmez', async () => {
    s = new Scope(t);
    const city = uniqueCity();
    const stand = await s.stand(city, { initialRadiusM: 1000, maxRadiusM: 3000 });
    const d = await s.driver(north(city, 300));
    const tok = uniquePushToken();
    await setToken(d.id, tok);
    sender.ticketErrors.set(tok, 'MessageRateExceeded');
    await s.createRide(stand);
    await waitFor(async () => sender.to(tok), (m) => m.length > 0, 8000);
    await sleep(500);
    expect(await tokenOf(d.id)).toBe(tok);
  }, 30_000);

  it('push gönderimi tamamen başarısız olsa da dispatch bozulmaz: socket çağrısı gelir, dalgalar sürer, kabul çalışır', async () => {
    s = new Scope(t);
    const city = uniqueCity();
    const stand = await s.stand(city, { initialRadiusM: 1000, maxRadiusM: 3000 });
    const d = await s.driver(north(city, 300));
    await setToken(d.id, uniquePushToken());
    sender.failAll = true;

    const { rideId } = await s.createRide(stand);
    await d.rec.waitFor(DRIVER_EVENTS.rideRequested, forRide(rideId), { ms: 10_000 });
    await stand.rec.waitFor(STAND_EVENTS.rideSearching, forRide(rideId), { n: 4, ms: 15_000 });
    expect(await s.rideStatus(rideId)).toBe('searching');
    const ack = await emitAck(d.socket, DRIVER_EVENTS.rideAccept, { rideId });
    expect(ack.ok).toBe(true);
    expect(await s.rideStatus(rideId)).toBe('matched');
  }, 40_000);
});

describe('account_suspended push', () => {
  it('askıya alınan şoförün token\'ına account_suspended gönderilir ve token temizlenir', async () => {
    s = new Scope(t);
    const d = await s.driver();
    const tok = uniquePushToken();
    await setToken(d.id, tok);
    await t.adminAction('drivers', d.id, 'suspend');
    const m = (await waitFor(async () => sender.to(tok), (x) => x.length > 0, 8000))[0]!;
    expect(m.data).toEqual({ type: 'account_suspended' });
    expect(JSON.stringify(m)).not.toContain(d.id); // gizlilik: kimlik/telefon bildirimde yok
    expect(await tokenOf(d.id)).toBeNull();
  }, 30_000);

  it('tüm ticketlar geçici hata dönerse job başarısız olup yeniden denenir (attempts=3)', async () => {
    s = new Scope(t);
    const d = await s.driver();
    const tok = uniquePushToken();
    await setToken(d.id, tok);
    sender.ticketErrors.set(tok, 'MessageRateExceeded');
    await t.adminAction('drivers', d.id, 'suspend');
    await waitFor(async () => sender.to(tok), (m) => m.length >= 2, 15_000, 100);
    await waitFor(async () => sender.to(tok), (m) => m.length === 3, 15_000, 100);
    await sleep(1500);
    expect(sender.to(tok)).toHaveLength(3); // attempts üst sınırı
  }, 40_000);

  it('hepsi DeviceNotRegistered ise yeniden denenmez (tek gönderim) ve token silinir', async () => {
    s = new Scope(t);
    const d = await s.driver();
    const tok = uniquePushToken();
    await setToken(d.id, tok);
    sender.ticketErrors.set(tok, 'DeviceNotRegistered');
    await t.adminAction('drivers', d.id, 'suspend');
    await waitFor(async () => sender.to(tok), (m) => m.length >= 1, 8000);
    await sleep(3000); // ilk backoff 1 sn: yeniden deneme olsaydı görünürdü
    expect(sender.to(tok)).toHaveLength(1);
    expect(await tokenOf(d.id)).toBeNull();
  }, 40_000);
});
