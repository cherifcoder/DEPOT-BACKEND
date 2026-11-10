import compression from 'compression';
import cors from 'cors';
import express from 'express';
import helmet from 'helmet';
import { pinoHttp } from 'pino-http';
import { env } from './env.js';
import { logger } from './lib/logger.js';
import { ensureStorage, uploadRoot } from './lib/storage.js';
import { globalLimiter } from './middleware/rateLimit.js';
import { auditMutations } from './middleware/audit.js';
import { errorHandler, notFoundHandler } from './middleware/error.js';
import { authRouter } from './modules/auth/auth.routes.js';
import { usersRouter } from './modules/users/user.routes.js';
import { productsRouter } from './modules/products/product.routes.js';
import { suppliersRouter } from './modules/suppliers/supplier.routes.js';
import { purchasesRouter } from './modules/purchases/purchase.routes.js';
import { clientsRouter } from './modules/clients/client.routes.js';
import { salesRouter } from './modules/sales/sale.routes.js';
import { lossesRouter } from './modules/losses/loss.routes.js';
import { expensesRouter } from './modules/expenses/expense.routes.js';
import { receiptsRouter } from './modules/receipts/receipt.routes.js';
import { deliveriesRouter } from './modules/deliveries/delivery.routes.js';
import { reportsRouter } from './modules/reports/report.routes.js';
import { exportsRouter } from './modules/reports/export.routes.js';
import { auditRouter } from './modules/audit/audit.routes.js';
import { notificationsRouter } from './modules/notifications/notification.routes.js';
import { settingsRouter } from './modules/settings/setting.routes.js';
import { uploadsRouter } from './modules/uploads/upload.routes.js';
import { syncRouter } from './modules/sync/sync.routes.js';

export function createApp() {
  void ensureStorage();

  const app = express();

  app.set('trust proxy', 1);
  app.disable('x-powered-by');

  app.use(
    helmet({
      crossOriginResourcePolicy: { policy: 'cross-origin' },
      contentSecurityPolicy: false,
    }),
  );
  app.use(cors({ origin: env.corsOrigins, credentials: true }));
  app.use(compression());
  app.use(express.json({ limit: '12mb' }));
  app.use(express.urlencoded({ extended: true, limit: '12mb' }));
  app.use(
    pinoHttp({
      logger,
      autoLogging: { ignore: (req) => req.url === '/health' },
      customLogLevel: (_req, res, error) => (error || res.statusCode >= 500 ? 'error' : 'info'),
      serializers: {
        req: (req) => ({
          method: req.method,
          url: req.url,
          remoteAddress: req.remoteAddress,
        }),
        res: (res) => ({ statusCode: res.statusCode }),
      },
    }),
  );

  app.use('/files', express.static(uploadRoot, { maxAge: '7d', fallthrough: false }));

  app.get('/health', (_req, res) => {
    res.json({ status: 'ok', service: 'depot-boissons-api', time: new Date().toISOString() });
  });

  app.use('/api', globalLimiter, auditMutations);

  app.use('/api/auth', authRouter);
  app.use('/api/users', usersRouter);
  app.use('/api/products', productsRouter);
  app.use('/api/suppliers', suppliersRouter);
  app.use('/api/purchases', purchasesRouter);
  app.use('/api/clients', clientsRouter);
  app.use('/api/sales', salesRouter);
  app.use('/api/losses', lossesRouter);
  app.use('/api/expenses', expensesRouter);
  app.use('/api/receipts', receiptsRouter);
  app.use('/api/deliveries', deliveriesRouter);
  app.use('/api/reports', reportsRouter);
  app.use('/api/exports', exportsRouter);
  app.use('/api/audit-logs', auditRouter);
  app.use('/api/notifications', notificationsRouter);
  app.use('/api/settings', settingsRouter);
  app.use('/api/uploads', uploadsRouter);
  app.use('/api/sync', syncRouter);

  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}
