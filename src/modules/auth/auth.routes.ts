import { Router } from 'express';
import { authenticate } from '../../middleware/auth.js';
import { loginLimiter } from '../../middleware/rateLimit.js';
import { parseBody, requireUser } from '../../http.js';
import {
  changePassword,
  changePasswordSchema,
  getMe,
  login,
  loginSchema,
  logout,
  logoutSchema,
  refresh,
  refreshSchema,
} from './auth.service.js';

export const authRouter = Router();

authRouter.post('/login', loginLimiter, async (req, res) => {
  const result = await login(parseBody(loginSchema, req), req);
  res.json(result);
});

authRouter.post('/refresh', async (req, res) => {
  const result = await refresh(parseBody(refreshSchema, req), req);
  res.json(result);
});

authRouter.use(authenticate);

authRouter.get('/me', async (req, res) => {
  const user = requireUser(req);
  res.json({ user: await getMe(user.id) });
});

authRouter.post('/logout', async (req, res) => {
  const user = requireUser(req);
  await logout(user.id, parseBody(logoutSchema, req), req);
  res.status(204).send();
});

authRouter.post('/change-password', async (req, res) => {
  const user = requireUser(req);
  await changePassword(user.id, parseBody(changePasswordSchema, req));
  res.status(204).send();
});
