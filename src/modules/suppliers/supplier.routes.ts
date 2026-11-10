import { Router } from 'express';
import { authenticate, requireRoles } from '../../middleware/auth.js';
import { idParam, parseBody, parseQuery, setAudit, setAuditEntity } from '../../http.js';
import { parseRange } from '../../lib/dates.js';
import {
  archiveSupplier,
  createSupplier,
  getSupplier,
  listSuppliers,
  supplierListQuerySchema,
  supplierSchema,
  topSuppliers,
  updateSupplier,
} from './supplier.service.js';

export const suppliersRouter = Router();
suppliersRouter.use(authenticate);

suppliersRouter.get('/', async (req, res) => {
  res.json(await listSuppliers(parseQuery(supplierListQuerySchema, req)));
});

suppliersRouter.get('/top', async (req, res) => {
  const { from, to } = parseRange(req.query as Record<string, string>, 'month');
  res.json({ data: await topSuppliers(from, to, Number(req.query.limit ?? 10)) });
});

suppliersRouter.get('/:id', async (req, res) => {
  res.json(await getSupplier(idParam(req)));
});

suppliersRouter.post('/', requireRoles('COMPTABLE'), async (req, res) => {
  const supplier = await createSupplier(parseBody(supplierSchema, req));
  setAuditEntity(res, supplier.id);
  setAudit(res, { action: 'CREATE', entity: 'suppliers', entityId: supplier.id, after: supplier });
  res.status(201).json(supplier);
});

suppliersRouter.patch('/:id', requireRoles('COMPTABLE'), async (req, res) => {
  const id = idParam(req);
  const before = await getSupplier(id);
  const supplier = await updateSupplier(id, parseBody(supplierSchema.partial(), req));
  setAudit(res, {
    action: 'UPDATE',
    entity: 'suppliers',
    entityId: id,
    before: { name: before.name, phone: before.phone, isActive: before.isActive },
    after: { name: supplier.name, phone: supplier.phone, isActive: supplier.isActive },
  });
  res.json(supplier);
});

suppliersRouter.delete('/:id', requireRoles('COMPTABLE'), async (req, res) => {
  const id = idParam(req);
  const before = await getSupplier(id);
  await archiveSupplier(id);
  setAudit(res, {
    action: 'DELETE',
    entity: 'suppliers',
    entityId: id,
    before: { name: before.name },
  });
  res.status(204).send();
});
