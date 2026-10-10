-- Up Migration

-- Faz 6: KVKK aydınlatma onayı (kayıtta zorunlu). Mevcut hesaplar NULL kalır (onay kaydı yok).
ALTER TABLE drivers ADD COLUMN kvkk_accepted_at timestamptz;
ALTER TABLE drivers ADD COLUMN kvkk_version varchar(40);
ALTER TABLE stands ADD COLUMN kvkk_accepted_at timestamptz;
ALTER TABLE stands ADD COLUMN kvkk_version varchar(40);

-- Down Migration

ALTER TABLE stands DROP COLUMN IF EXISTS kvkk_version;
ALTER TABLE stands DROP COLUMN IF EXISTS kvkk_accepted_at;
ALTER TABLE drivers DROP COLUMN IF EXISTS kvkk_version;
ALTER TABLE drivers DROP COLUMN IF EXISTS kvkk_accepted_at;
