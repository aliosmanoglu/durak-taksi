// RideStateMachine (CLAUDE.md Bölüm 1): `rides.status` YALNIZCA burada değişir.
// Geçiş kuralları packages/shared/src/ride-machine.ts'tendir (tek kaynak). Her geçiş tek bir koşullu
// `UPDATE ... WHERE id AND status IN (from) [AND version = $v] [AND sahiplik]` ifadesidir: SELECT-sonra-UPDATE
// yok. 0 satır dönerse nedeni (yok / sahip değil / geçersiz geçiş / sürüm uyuşmazlığı) ayrıca sorgulanır;
// bu sorgu yalnızca hata sınıflandırması içindir, karar UPDATE'in kendisindedir.
// Her geçişte `version` bir artar ve ilgili zaman damgası yazılır; `searching_at` her `searching` girişinde yenilenir.
import { sql } from 'kysely';
import {
  canTransition,
  RIDE_TRANSITIONS,
  type RideActor,
  type RideStatus,
  type RideTransitionReason,
} from '@duraknet/shared';
import type { Db } from '../db';
import { AppError } from '../http/errors';

export type TransitionRequest = {
  rideId: string;
  reason: RideTransitionReason;
  actor: RideActor;
  /** Verilirse `version = $v` koşulu eklenir (aksi halde VERSION_CONFLICT). Şoför kabulünde Lua'dan gelen önceki sürüm. */
  expectedVersion?: number;
  /** Sahiplik koşulu: ride bu durağa ait olmalı (durak işlemleri ve durak tamamlaması). */
  standId?: string;
  /**
   * `driver_accepted`: atanacak şoför. `driver_cancelled` / `driver_suspended` / şoför tamamlaması:
   * ride bu şoföre ait olmalı (sahiplik koşulu).
   */
  driverId?: string;
  /** `stand_cancelled` için durağın girdiği opsiyonel sebep. */
  cancelReason?: string;
};

export type TransitionResult = {
  rideId: string;
  from: RideStatus;
  to: RideStatus;
  version: number;
  standId: string;
  /** `matched` için şoför; `searching`/`created` için null. İptalde (`stand_cancelled`) önceki şoför korunur. */
  driverId: string | null;
  completedAt: Date | null;
};

/** Saf planlama: geçişin hedef durumu ve kaynak durum kümesi. Geçersiz (sebep, aktör) `INVALID_TRANSITION`. */
export function planTransition(reason: RideTransitionReason, actor: RideActor) {
  const candidates = RIDE_TRANSITIONS.filter((t) => t.reason === reason);
  if (candidates.length === 0) throw invalid();
  const froms = candidates.filter((t) => canTransition(t.from, t.to, reason, actor)).map((t) => t.from);
  if (froms.length === 0) throw invalid();
  return { to: candidates[0]!.to, froms };
}

const invalid = () => new AppError(409, 'INVALID_TRANSITION', 'Geçersiz durum geçişi');

export class RideStateMachine {
  constructor(private readonly db: Db) {}

  async transition(req: TransitionRequest): Promise<TransitionResult> {
    const { to, froms } = planTransition(req.reason, req.actor);
    if (req.reason === 'driver_accepted' && !req.driverId) throw new Error('driver_accepted için driverId gerekli');

    let q = this.db
      .updateTable('rides')
      .set((eb) => ({
        status: to,
        version: eb('version', '+', 1),
        ...this.columnsFor(req, to),
      }))
      .where('id', '=', req.rideId)
      .where('status', 'in', froms);
    if (req.expectedVersion !== undefined) q = q.where('version', '=', req.expectedVersion);
    if (req.standId) q = q.where('stand_id', '=', req.standId);
    if (req.driverId && req.reason !== 'driver_accepted') q = q.where('driver_id', '=', req.driverId);

    let row;
    try {
      row = await q.returning(['id', 'version', 'stand_id', 'driver_id', 'completed_at']).executeTakeFirst();
    } catch (err) {
      // uq_driver_one_active_ride: şoförün zaten `matched` bir ride'ı var (ikinci güvenlik katmanı).
      if (req.reason === 'driver_accepted' && (err as { code?: string }).code === '23505') {
        throw new AppError(409, 'DRIVER_NOT_AVAILABLE', 'Şoförün zaten aktif bir işi var');
      }
      throw err;
    }
    if (!row) throw await this.explainFailure(req, froms);
    const from: RideStatus = froms.length === 1 ? froms[0]! : row.driver_id ? 'matched' : 'searching';
    return {
      rideId: row.id, from, to, version: row.version, standId: row.stand_id, driverId: row.driver_id,
      completedAt: row.completed_at ? new Date(row.completed_at) : null,
    };
  }

  private columnsFor(req: TransitionRequest, to: RideStatus) {
    const now = sql<Date>`now()`;
    switch (to) {
      case 'searching':
        // Yeni arama turu: sayaçlar sıfırlanır, eşleşme bilgisi silinir (rapor: matched_at - searching_at).
        return {
          searching_at: now, driver_id: null, matched_at: null, dispatch_wave: 0, current_radius_m: null,
        };
      case 'matched':
        return { driver_id: req.driverId ?? null, matched_at: now };
      case 'completed':
        return { completed_at: now };
      case 'cancelled':
        return { cancelled_at: now, cancel_reason: req.cancelReason ?? null };
      default:
        return {};
    }
  }

  private async explainFailure(req: TransitionRequest, froms: RideStatus[]): Promise<AppError> {
    const cur = await this.db
      .selectFrom('rides')
      .select(['status', 'version', 'stand_id', 'driver_id'])
      .where('id', '=', req.rideId)
      .executeTakeFirst();
    if (!cur) return new AppError(404, 'NOT_FOUND', 'Çağrı bulunamadı');
    if (req.standId && cur.stand_id !== req.standId) return new AppError(403, 'FORBIDDEN', 'Bu çağrı size ait değil');
    if (req.driverId && req.reason !== 'driver_accepted' && cur.driver_id !== req.driverId && cur.status === 'matched') {
      return new AppError(403, 'FORBIDDEN', 'Bu çağrı size ait değil');
    }
    if (!froms.includes(cur.status)) return invalid();
    if (req.driverId && req.reason !== 'driver_accepted' && cur.driver_id !== req.driverId) {
      return new AppError(403, 'FORBIDDEN', 'Bu çağrı size ait değil');
    }
    if (req.expectedVersion !== undefined && cur.version !== req.expectedVersion) {
      return new AppError(409, 'VERSION_CONFLICT', 'Çağrı güncellenmiş; durumu yenileyin');
    }
    return invalid();
  }
}
