import { pino } from 'pino';
import { env } from './env.js';

export const logger = pino({
  level: env.LOG_LEVEL,
  ...(env.NODE_ENV === 'development' && {
    transport: { target: 'pino-pretty', options: { colorize: true } },
  }),
});

/** Separate child logger so Baileys' internal chatter can be tuned independently. */
export const baileysLogger = logger.child({ module: 'baileys' }, { level: env.BAILEYS_LOG_LEVEL });

export type Logger = typeof logger;
