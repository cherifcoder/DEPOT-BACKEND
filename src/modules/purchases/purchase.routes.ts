import { Router } from 'express';
import { authenticate, requireRoles } from '../../middleware/auth.js';
import { idParam, parseBody, parseQuery, requireUser, setAudit, setAuditEntity } from '../../http.js';
import {
  createPurchase,
  createPurchaseSchema,
  getPurchase,
  listPurchases,
  purchaseListQuerySchema,
} from './purchase.service.js';

export const purchasesRouter = Router();
purchasesRouter.use(authenticate);

purchasesRouter.get('/', async (req, res) => {
  res.json(await listPurchases(parseQuery(purchaseListQuerySchema, req)));
});

purchasesRouter.get('/:id', async (req, res) => {
  res.json(await getPurchase(idParam(req)));
});

purchasesRouter.post('/', requireRoles('COMPTABLE'), async (req, res) => {
  const actor = requireUser(req);
  const { purchase, created } = await createPurchase(parseBody(createPurchaseSchema, req), actor.id);

  setAuditEntity(res, purchase.id);
  setAudit(res, {
    action: 'CREATE',
    entity: 'purchases',
    entityId: purchase.id,
    after: {
      reference: purchase.reference,
      supplier: purchase.supplier.name,
      totalAmount: purchase.totalAmount,
      transportFees: purchase.transportFees,
      items: purchase.items.map((item) => ({ productId: item.productId, quantity: item.quantity, unitCost: item.unitCost })),
    },
    metadata: { idempotentReplay: !created },
  });

  res.status(created ? 201 : 200).json({ purchase, created });
});
