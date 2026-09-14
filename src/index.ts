import { env } from './config/env.js';
import { logger } from './config/logger.js';
import { closeDb, db } from './db/client.js';
import { runMigrations } from './db/migrate.js';
import { StorageService } from './services/storage.js';
import { WhatsAppService } from './services/whatsapp.js';

const SHUTDOWN_TIMEOUT_MS = 25_000;

async function main(): Promise<void> {
  await runMigrations(db, env.MIGRATIONS_DIR, logger);

  const storage = new StorageService(db, logger.child({ module: 'storage' }));
  const whatsapp = new WhatsAppService({
    authDir: env.AUTH_DIR,
    storage,
    logger,
    storeRawPayload: env.STORE_RAW_PAYLOAD,
    reconnect: {
      baseDelayMs: env.RECONNECT_BASE_DELAY_MS,
      maxDelayMs: env.RECONNECT_MAX_DELAY_MS,
    },
    memberSync: {
      intervalMs: env.MEMBER_SYNC_INTERVAL_HOURS * 60 * 60 * 1000,
      minDelayMs: env.MEMBER_SYNC_MIN_DELAY_MS,
      maxDelayMs: env.MEMBER_SYNC_MAX_DELAY_MS,
    },
  });

  let shuttingDown = false;
  const shutdown = async (signal: NodeJS.Signals) => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info({ signal }, 'shutting down');

    const force = setTimeout(() => {
      logger.error('graceful shutdown timed out, forcing exit');
      process.exit(1);
    }, SHUTDOWN_TIMEOUT_MS);
    force.unref();

    try {
      await whatsapp.stop();
      await closeDb();
      process.exit(0);
    } catch (err) {
      logger.error({ err }, 'error during shutdown');
      process.exit(1);
    }
  };

  process.once('SIGINT', (s) => void shutdown(s));
  process.once('SIGTERM', (s) => void shutdown(s));
  process.on('unhandledRejection', (err) => logger.error({ err }, 'unhandled rejection'));

  await whatsapp.start();
}

main().catch((err: unknown) => {
  logger.fatal({ err }, 'fatal startup error');
  process.exit(1);
});
