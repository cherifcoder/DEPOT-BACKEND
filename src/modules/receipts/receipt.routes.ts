import { Router } from 'express';
import { authenticate, requireAdmin, requireRoles } from '../../middleware/auth.js';
import { idParam, parseBody, parseQuery, requireUser, setAudit } from '../../http.js';
import {
  createManualReceipt,
  deleteManualReceipt,
  listReceipts,
  manualReceiptSchema,
  receiptListQuerySchema,
  receiptSummary,
} from './receipt.service.js';

export const receiptsRouter = Router();
receiptsRouter.use(authenticate);

receiptsRouter.get('/', async (req, res) => {
  res.json(await listReceipts(parseQuery(receiptListQuerySchema, req)));
});

receiptsRouter.get('/summary', async (req, res) => {
  res.json(await receiptSummary(req.query as Record<string, string>));
});

receiptsRouter.post('/', requireRoles('COMPTABLE'), async (req, res) => {
  const actor = requireUser(req);
  const { receipt, created } = await createManualReceipt(parseBody(manualReceiptSchema, req), actor.id);
  setAudit(res, {
    action: 'CREATE',
    entity: 'receipts',
    entityId: receipt.id,
    after: { label: receipt.label, amount: receipt.amount, source: receipt.source },
    metadata: { idempotentReplay: !created },
  });
  res.status(created ? 201 : 200).json({ receipt, created });
});

receiptsRouter.delete('/:id', requireAdmin(), async (req, res) => {
  const id = idParam(req);
  const receipt = await deleteManualReceipt(id);
  setAudit(res, {
    action: 'DELETE',
    entity: 'receipts',
    entityId: id,
    before: { label: receipt.label, amount: receipt.amount, source: receipt.source },
  });
  res.status(204).send();
});
