import { Router } from 'express';
import { authenticate, requireAdmin } from '../../middleware/auth.js';
import { idParam, parseBody, parseQuery, requireUser, setAudit, setAuditEntity } from '../../http.js';
import {
  createUser,
  createUserSchema,
  getUser,
  listUsers,
  listUsersQuerySchema,
  resetPasswordSchema,
  resetUserPassword,
  revokeUserSessions,
  updateUser,
  updateUserSchema,
} from './user.service.js';

export const usersRouter = Router();

usersRouter.use(authenticate, requireAdmin());

usersRouter.get('/', async (req, res) => {
  const result = await listUsers(parseQuery(listUsersQuerySchema, req));
  res.json(result);
});

usersRouter.get('/:id', async (req, res) => {
  res.json(await getUser(idParam(req)));
});

usersRouter.post('/', async (req, res) => {
  const input = parseBody(createUserSchema, req);
  const user = await createUser(input);
  setAuditEntity(res, user.id);
  setAudit(res, {
    action: 'CREATE',
    entity: 'users',
    entityId: user.id,
    after: { email: user.email, fullName: user.fullName, roles: user.roles },
  });
  res.status(201).json(user);
});

usersRouter.patch('/:id', async (req, res) => {
  const id = idParam(req);
  const actor = requireUser(req);
  const before = await getUser(id);
  const user = await updateUser(id, parseBody(updateUserSchema, req), actor.id);
  setAudit(res, {
    action: 'UPDATE',
    entity: 'users',
    entityId: id,
    before: { fullName: before.fullName, email: before.email, roles: before.roles, isActive: before.isActive },
    after: { fullName: user.fullName, email: user.email, roles: user.roles, isActive: user.isActive },
  });
  res.json(user);
});

usersRouter.delete('/:id', async (req, res) => {
  const id = idParam(req);
  const actor = requireUser(req);
  if (id === actor.id) {
    res.status(400).json({ error: { code: 'BAD_REQUEST', message: 'Vous ne pouvez pas supprimer votre compte' } });
    return;
  }
  const before = await getUser(id);
  await updateUser(id, { isActive: false }, actor.id);
  setAudit(res, {
    action: 'DELETE',
    entity: 'users',
    entityId: id,
    before: { fullName: before.fullName, email: before.email, roles: before.roles },
  });
  res.status(204).send();
});

usersRouter.post('/:id/password', async (req, res) => {
  const id = idParam(req);
  const input = parseBody(resetPasswordSchema, req);
  const result = await resetUserPassword(id, input.newPassword);
  setAudit(res, {
    action: 'EXECUTE',
    entity: 'users',
    entityId: id,
    metadata: { operation: 'password_reset', generated: Boolean(result.generatedPassword) },
  });
  res.json(result);
});

usersRouter.post('/:id/revoke-sessions', async (req, res) => {
  const id = idParam(req);
  await revokeUserSessions(id);
  setAudit(res, {
    action: 'EXECUTE',
    entity: 'users',
    entityId: id,
    metadata: { operation: 'revoke_sessions' },
  });
  res.status(204).send();
});
