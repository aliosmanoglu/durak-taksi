import { KVKK_NOTICE_VERSION } from '@duraknet/shared';
import type {
  AccountStatus,
  AuthTokens,
  DriverRegisterInput,
  LoginInput,
  Role,
  StandRegisterInput,
} from '@duraknet/shared';
import { isForeignKeyViolation, isUniqueViolation, toGeography, type Db } from '../db';
import { errors } from '../http/errors';
import { burnPasswordCheck, hashPassword, verifyPassword } from './password';
import { issueTokens, verifyToken, type TokenClaims, type TokenSecrets } from './tokens';

export const ADMIN_ID = 'admin';

/** Yönetici oturumunu çalışma zamanında iptal etmek için paylaşılan sayaç (Redis); yoksa yalnızca env sürümü geçerlidir. */
export type AdminSessionVersion = { get(): Promise<number>; bump(): Promise<number> };

export type AdminCredentials = {
  username: string;
  passwordHash: string;
  tokenVersion: number;
  sessionVersion?: AdminSessionVersion;
};

/** Etkin yönetici token_version'ı: env sürümü + çalışma zamanı sayacı. Redis hatasında istek reddedilir (fail-closed). */
async function adminTokenVersion(deps: AuthDeps): Promise<number> {
  return deps.admin.tokenVersion + (deps.admin.sessionVersion ? await deps.admin.sessionVersion.get() : 0);
}

export type AuthDeps = { db: Db; secrets: TokenSecrets; admin: AdminCredentials };

type AccountState = { status: AccountStatus; tokenVersion: number };

const tableOf = (role: 'driver' | 'stand') => (role === 'driver' ? 'drivers' : 'stands');

export async function getAccountState(deps: AuthDeps, role: Role, id: string): Promise<AccountState | null> {
  if (role === 'admin') {
    return id === ADMIN_ID ? { status: 'approved', tokenVersion: await adminTokenVersion(deps) } : null;
  }
  const row = await deps.db
    .selectFrom(tableOf(role))
    .select(['status', 'token_version'])
    .where('id', '=', id)
    .executeTakeFirst();
  return row ? { status: row.status, tokenVersion: row.token_version } : null;
}

/**
 * Token hâlâ geçerli bir oturumu temsil ediyor mu: hesap var, onaylı ve token_version eşleşiyor.
 * REST middleware, socket handshake ve refresh aynı kontrolü kullanır; askıya alma anında etkili olur.
 */
export async function assertActiveSession(deps: AuthDeps, claims: TokenClaims): Promise<void> {
  const state = await getAccountState(deps, claims.role, claims.sub);
  if (!state || state.tokenVersion !== claims.tv) throw errors.unauthorized();
  if (state.status === 'pending') throw errors.pending();
  if (state.status === 'suspended') throw errors.suspended();
}

export async function registerDriver(deps: AuthDeps, input: DriverRegisterInput) {
  try {
    return await deps.db
      .insertInto('drivers')
      .values({
        full_name: input.fullName,
        phone: input.phone,
        password_hash: await hashPassword(input.password),
        plate: input.plate,
        license_no: input.licenseNo,
        vehicle_model: input.vehicleModel ?? null,
        vehicle_color: input.vehicleColor ?? null,
        home_stand_id: input.homeStandId ?? null,
        kvkk_accepted_at: new Date(),
        kvkk_version: KVKK_NOTICE_VERSION,
      })
      .returning(['id', 'status'])
      .executeTakeFirstOrThrow();
  } catch (err) {
    if (isUniqueViolation(err)) throw errors.conflict('Bu telefon numarası veya plaka zaten kayıtlı');
    if (isForeignKeyViolation(err)) throw errors.validation('Bağlı olunan durak bulunamadı');
    throw err;
  }
}

export async function registerStand(deps: AuthDeps, input: StandRegisterInput) {
  try {
    return await deps.db
      .insertInto('stands')
      .values({
        name: input.name,
        phone: input.phone,
        address: input.address ?? null,
        location: toGeography(input.location),
        username: input.username,
        password_hash: await hashPassword(input.password),
        kvkk_accepted_at: new Date(),
        kvkk_version: KVKK_NOTICE_VERSION,
      })
      .returning(['id', 'status'])
      .executeTakeFirstOrThrow();
  } catch (err) {
    if (isUniqueViolation(err)) throw errors.conflict('Bu kullanıcı adı zaten kayıtlı');
    throw err;
  }
}

export async function login(
  deps: AuthDeps,
  input: LoginInput,
): Promise<AuthTokens & { role: Role; id: string }> {
  let account: { id: string; password_hash: string; status: AccountStatus; token_version: number } | undefined;

  if (input.role === 'admin') {
    if (input.username === deps.admin.username) {
      account = {
        id: ADMIN_ID,
        password_hash: deps.admin.passwordHash,
        status: 'approved',
        token_version: await adminTokenVersion(deps),
      };
    }
  } else if (input.role === 'driver') {
    account = await deps.db
      .selectFrom('drivers')
      .select(['id', 'password_hash', 'status', 'token_version'])
      .where('phone', '=', input.phone)
      .executeTakeFirst();
  } else {
    account = await deps.db
      .selectFrom('stands')
      .select(['id', 'password_hash', 'status', 'token_version'])
      .where('username', '=', input.username)
      .executeTakeFirst();
  }

  if (!account) {
    await burnPasswordCheck(input.password);
    throw errors.invalidCredentials();
  }
  if (!(await verifyPassword(account.password_hash, input.password))) throw errors.invalidCredentials();
  // Durum kontrolü şifre doğrulandıktan sonra: hesabın varlığı/durumu şifresiz öğrenilemez.
  if (account.status === 'pending') throw errors.pending();
  if (account.status === 'suspended') throw errors.suspended();

  const tokens = issueTokens(deps.secrets, { sub: account.id, role: input.role, tv: account.token_version });
  return { ...tokens, role: input.role, id: account.id };
}

export async function refresh(deps: AuthDeps, refreshToken: string): Promise<AuthTokens> {
  const claims = verifyToken(deps.secrets.refreshSecret, refreshToken, 'refresh');
  if (!claims) throw errors.unauthorized('Oturum süresi doldu, tekrar giriş yapın');
  await assertActiveSession(deps, claims);
  return issueTokens(deps.secrets, claims);
}


/**
 * Hesabın TÜM oturumlarını (tüm cihazlarda) kapatır: token_version + 1 → mevcut access/refresh token'lar geçersiz.
 * Yönetici: paylaşılan Redis sayacı artar (tüm admin token'ları geçersiz); sayaç yoksa (`sessionVersion`
 * verilmemiş) yalnızca ADMIN_TOKEN_VERSION ile iptal edilebilir ve 400 döner.
 */
export async function logoutAllDevices(deps: AuthDeps, claims: TokenClaims): Promise<'driver' | 'stand' | 'admin'> {
  if (claims.role === 'admin') {
    if (!deps.admin.sessionVersion) {
      throw errors.validation('Yönetici oturumu ADMIN_TOKEN_VERSION ortam değişkeniyle iptal edilir');
    }
    await deps.admin.sessionVersion.bump();
    return 'admin';
  }
  if (claims.role === 'driver') {
    // Çıkışta push token da silinir: çıkış yapmış cihaza çağrı bildirimi gitmesin.
    await deps.db
      .updateTable('drivers')
      .set((eb) => ({ token_version: eb('token_version', '+', 1), push_token: null }))
      .where('id', '=', claims.sub)
      .execute();
    return 'driver';
  }
  await deps.db
    .updateTable('stands')
    .set((eb) => ({ token_version: eb('token_version', '+', 1) }))
    .where('id', '=', claims.sub)
    .execute();
  return 'stand';
}
