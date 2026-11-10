import { Router } from 'express';
import { authenticate, requireAdmin, requireRoles } from '../../middleware/auth.js';
import { idParam, parseBody, parseQuery, setAudit, setAuditEntity } from '../../http.js';
import { parseRange } from '../../lib/dates.js';
import {
  archiveClient,
  clientListQuerySchema,
  clientSchema,
  createClient,
  getClient,
  getClientStatement,
  listClients,
  topClients,
  updateClient,
} from './client.service.js';

export const clientsRouter = Router();
clientsRouter.use(authenticate);

clientsRouter.get('/', async (req, res) => {
  res.json(await listClients(parseQuery(clientListQuerySchema, req)));
});

clientsRouter.get('/top', requireAdmin(), async (req, res) => {
  const { from, to } = parseRange(req.query as Record<string, string>, 'month');
  res.json({ data: await topClients(from, to, Math.min(Number(req.query.limit ?? 10), 50)) });
});

clientsRouter.get('/:id', async (req, res) => {
  res.json(await getClient(idParam(req)));
});

clientsRouter.get('/:id/statement.pdf', async (req, res) => {
  const pdf = await getClientStatement(idParam(req), req.query as Record<string, string>);
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', 'inline; filename="releve-client.pdf"');
  res.send(pdf);
});

clientsRouter.post('/', requireRoles('VENDEUR', 'COMPTABLE'), async (req, res) => {
  const client = await createClient(parseBody(clientSchema, req));
  setAuditEntity(res, client.id);
  setAudit(res, { action: 'CREATE', entity: 'clients', entityId: client.id, after: client });
  res.status(201).json(client);
});

clientsRouter.patch('/:id', requireRoles('VENDEUR', 'COMPTABLE'), async (req, res) => {
  const id = idParam(req);
  const before = await getClient(id);
  const client = await updateClient(id, parseBody(clientSchema.partial(), req));
  setAudit(res, {
    action: 'UPDATE',
    entity: 'clients',
    entityId: id,
    before: { name: before.name, phone: before.phone, creditLimit: before.creditLimit, isActive: before.isActive },
    after: { name: client.name, phone: client.phone, creditLimit: client.creditLimit, isActive: client.isActive },
  });
  res.json(client);
});

clientsRouter.delete('/:id', requireRoles('VENDEUR', 'COMPTABLE'), async (req, res) => {
  const id = idParam(req);
  const before = await getClient(id);
  await archiveClient(id);
  setAudit(res, { action: 'DELETE', entity: 'clients', entityId: id, before: { name: before.name } });
  res.status(204).send();
});
