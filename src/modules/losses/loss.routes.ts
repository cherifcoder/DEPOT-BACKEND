import { Router } from 'express';
import { authenticate, requireAdmin, requireRoles } from '../../middleware/auth.js';
import { idParam, parseBody, parseQuery, requireUser, setAudit, setAuditEntity } from '../../http.js';
import {
  createLoss,
  createLossSchema,
  deleteLoss,
  listLosses,
  lossListQuerySchema,
  lossSummary,
} from './loss.service.js';

export const lossesRouter = Router();
lossesRouter.use(authenticate);

lossesRouter.get('/', async (req, res) => {
  res.json(await listLosses(parseQuery(lossListQuerySchema, req)));
});

lossesRouter.get('/summary', async (req, res) => {
  res.json(await lossSummary(req.query as Record<string, string>));
});

lossesRouter.post('/', requireRoles('VENDEUR', 'COMPTABLE'), async (req, res) => {
  const actor = requireUser(req);
  const { loss, created } = await createLoss(parseBody(createLossSchema, req), actor.id);

  setAuditEntity(res, loss.id);
  setAudit(res, {
    action: 'CREATE',
    entity: 'losses',
    entityId: loss.id,
    after: {
      reference: loss.reference,
      product: loss.product.name,
      quantity: loss.quantity,
      reason: loss.reason,
      totalCost: loss.totalCost,
    },
    metadata: { idempotentReplay: !created },
  });

  res.status(created ? 201 : 200).json({ loss, created });
});

lossesRouter.delete('/:id', requireAdmin(), async (req, res) => {
  const id = idParam(req);
  const loss = await deleteLoss(id);
  setAudit(res, {
    action: 'DELETE',
    entity: 'losses',
    entityId: id,
    before: { reference: loss.reference, product: loss.product.name, quantity: loss.quantity, totalCost: loss.totalCost },
    metadata: { operation: 'cancel_loss', stockRestored: true },
  });
  res.status(204).send();
});
