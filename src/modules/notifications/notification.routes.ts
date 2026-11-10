import { Router } from 'express';
import { authenticate } from '../../middleware/auth.js';
import { idParam, parseBody, requireUser } from '../../http.js';
import {
  listNotifications,
  markAllNotificationsRead,
  markNotificationRead,
  pushTokenSchema,
  registerPushToken,
  removePushToken,
} from './notification.service.js';

export const notificationsRouter = Router();
notificationsRouter.use(authenticate);

notificationsRouter.get('/', async (req, res) => {
  const actor = requireUser(req);
  const page = Number(req.query.page ?? 1);
  const limit = Number(req.query.limit ?? 30);

  res.json(
    await listNotifications(actor.id, {
      page: Number.isFinite(page) && page > 0 ? page : 1,
      limit: Number.isFinite(limit) && limit > 0 ? limit : 30,
      unread: req.query.unread === 'true',
    }),
  );
});

notificationsRouter.patch('/:id/read', async (req, res) => {
  const actor = requireUser(req);
  res.locals.skipAudit = true;
  await markNotificationRead(actor.id, idParam(req));
  res.status(204).send();
});

notificationsRouter.post('/read-all', async (req, res) => {
  const actor = requireUser(req);
  res.locals.skipAudit = true;
  await markAllNotificationsRead(actor.id);
  res.status(204).send();
});

notificationsRouter.post('/push-tokens', async (req, res) => {
  const actor = requireUser(req);
  const input = parseBody(pushTokenSchema, req);
  res.locals.skipAudit = true;
  await registerPushToken(actor.id, input.token, input.platform);
  res.status(201).json({ success: true });
});

notificationsRouter.delete('/push-tokens', async (req, res) => {
  const actor = requireUser(req);
  res.locals.skipAudit = true;
  const { token } = parseBody(pushTokenSchema.pick({ token: true }), req);
  await removePushToken(actor.id, token);
  res.status(204).send();
});
