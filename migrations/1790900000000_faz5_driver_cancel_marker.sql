-- Up Migration

-- Faz 5: ride_driver_cancel idempotent tekrarı yalnızca GERÇEKTEN o ride'ı iptal etmiş şoföre ok verir.
-- Kanıt, iptal geçişiyle aynı UPDATE'te yazılır (commit ile atomik; Redis'e bağlı değil). Yanıt, orijinal iptalin
-- sürümüdür (başkasının sonraki sürümü sızmaz).
ALTER TABLE rides ADD COLUMN last_driver_cancel_by uuid REFERENCES drivers(id) ON DELETE SET NULL;
ALTER TABLE rides ADD COLUMN last_driver_cancel_version integer;

-- Down Migration

ALTER TABLE rides DROP COLUMN IF EXISTS last_driver_cancel_version;
ALTER TABLE rides DROP COLUMN IF EXISTS last_driver_cancel_by;
