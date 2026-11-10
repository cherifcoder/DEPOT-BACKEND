import { Router } from 'express';
import { authenticate, requireAdmin } from '../../middleware/auth.js';
import { idParam, parseQuery } from '../../http.js';
import { auditFilters, auditListQuerySchema, getAuditLog, listAuditLogs } from './audit.service.js';

export const auditRouter = Router();
auditRouter.use(authenticate, requireAdmin());

auditRouter.get('/', async (req, res) => {
  res.json(await listAuditLogs(parseQuery(auditListQuerySchema, req)));
});

auditRouter.get('/filters', async (_req, res) => {
  res.json(await auditFilters());
});

auditRouter.get('/:id', async (req, res) => {
  res.json(await getAuditLog(idParam(req)));
});
