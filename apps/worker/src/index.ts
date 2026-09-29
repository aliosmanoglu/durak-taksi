import pino from 'pino';

// Faz 3'te BullMQ dispatch/hatırlatma job'ları ve heartbeat sweeper burada başlayacak.
const log = pino({ level: process.env.LOG_LEVEL ?? 'info' });
log.info('worker başladı (henüz iş tanımlı değil)');
