import { createApp } from './app.js';
import { env } from './env.js';
import { logger } from './lib/logger.js';
import { prisma } from './lib/prisma.js';
import { ensureStorage } from './lib/storage.js';
import { startNotificationJob, stopNotificationJob } from './jobs/notification.job.js';

async function main(): Promise<void> {
  await ensureStorage();

  const app = createApp();
  const server = app.listen(env.PORT, () => {
    logger.info(
      { port: env.PORT, env: env.NODE_ENV, baseUrl: env.PUBLIC_BASE_URL },
      'API depot de boissons demarree',
    );
  });

  server.requestTimeout = 60_000;
  server.headersTimeout = 65_000;

  if (env.ENABLE_CRON) {
    startNotificationJob();
  }

  let shuttingDown = false;

  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;

    logger.info({ signal }, 'Arret en cours...');

    stopNotificationJob();

    const forceExit = setTimeout(() => {
      logger.error('Arret force apres expiration du delai');
      process.exit(1);
    }, 10_000);
    forceExit.unref();

    await new Promise<void>((resolve) => {
      server.close(() => resolve());
    });

    await prisma.$disconnect().catch((error: unknown) => {
      logger.error({ error }, 'Echec de la deconnexion Prisma');
    });

    logger.info('Arret termine');
    process.exit(0);
  };

  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));

  process.on('unhandledRejection', (reason) => {
    logger.error({ reason }, 'Promesse rejetee non geree');
  });

  process.on('uncaughtException', (error) => {
    logger.fatal({ error }, 'Exception non capturee, arret du processus');
    void shutdown('uncaughtException');
  });
}

main().catch((error: unknown) => {
  logger.fatal({ error }, 'Impossible de demarrer l API');
  process.exit(1);
});
