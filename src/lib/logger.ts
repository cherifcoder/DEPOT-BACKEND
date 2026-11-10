import pino from 'pino';
import { env } from '../env.js';

const prettyTransport =
  env.NODE_ENV === 'development'
    ? {
        target: 'pino-pretty',
        options: {
          colorize: true,
          translateTime: 'SYS:HH:MM:ss',
          ignore: 'pid,hostname,service,env',
          singleLine: false,
        },
      }
    : undefined;

export const logger = pino({
  level: env.LOG_LEVEL,
  base: { service: 'depot-boissons-api', env: env.NODE_ENV },
  redact: {
    paths: ['req.headers.authorization', 'password', '*.password', 'token', '*.token'],
    censor: '[redacted]',
  },
  ...(prettyTransport ? { transport: prettyTransport } : {}),
});
