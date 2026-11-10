import { Router } from 'express';
import { authenticate, requireAdmin } from '../../middleware/auth.js';
import { parseQuery } from '../../http.js';
import {
  dashboard,
  inventoryReport,
  receivablesReport,
  reportQuerySchema,
  salesReport,
} from './report.service.js';

export const reportsRouter = Router();
reportsRouter.use(authenticate);

reportsRouter.get('/dashboard', requireAdmin(), async (req, res) => {
  res.json(await dashboard(parseQuery(reportQuerySchema, req)));
});

reportsRouter.get('/sales', requireAdmin(), async (req, res) => {
  res.json(await salesReport(parseQuery(reportQuerySchema, req)));
});

reportsRouter.get('/receivables', requireAdmin(), async (_req, res) => {
  res.json(await receivablesReport());
});

reportsRouter.get('/inventory', async (_req, res) => {
  res.json(await inventoryReport());
});
