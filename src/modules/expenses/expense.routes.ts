import { Router } from 'express';
import { z } from 'zod';
import { authenticate, requireAdmin, requireRoles } from '../../middleware/auth.js';
import { idParam, parseBody, parseQuery, requireUser, setAudit } from '../../http.js';
import {
  createExpense,
  createExpenseCategory,
  createExpenseSchema,
  deleteExpense,
  deleteExpenseCategory,
  expenseCategorySchema,
  expenseSummary,
  listExpenseCategories,
  listExpenses,
  listExpenseQuerySchema,
  updateExpense,
  updateExpenseCategory,
} from './expense.service.js';

const updateCategorySchema = expenseCategorySchema.partial().extend({
  isArchived: z.boolean().optional(),
});

export const expensesRouter = Router();
expensesRouter.use(authenticate);

// -------------------------------------------------------- Categories de charges
expensesRouter.get('/categories', async (req, res) => {
  res.json({ data: await listExpenseCategories(req.query.includeArchived === 'true') });
});

expensesRouter.post('/categories', requireRoles('COMPTABLE'), async (req, res) => {
  const category = await createExpenseCategory(parseBody(expenseCategorySchema, req));
  setAudit(res, { action: 'CREATE', entity: 'expense_categories', entityId: category.id, after: category });
  res.status(201).json(category);
});

expensesRouter.patch('/categories/:id', requireRoles('COMPTABLE'), async (req, res) => {
  const id = idParam(req);
  const category = await updateExpenseCategory(id, parseBody(updateCategorySchema, req));
  setAudit(res, { action: 'UPDATE', entity: 'expense_categories', entityId: id, after: category });
  res.json(category);
});

expensesRouter.delete('/categories/:id', requireAdmin(), async (req, res) => {
  const id = idParam(req);
  await deleteExpenseCategory(id);
  setAudit(res, { action: 'DELETE', entity: 'expense_categories', entityId: id });
  res.status(204).send();
});

// ------------------------------------------------------------------ Depenses
expensesRouter.get('/', async (req, res) => {
  res.json(await listExpenses(parseQuery(listExpenseQuerySchema, req)));
});

expensesRouter.get('/summary', async (req, res) => {
  res.json(await expenseSummary(req.query as Record<string, string>));
});

expensesRouter.post('/', requireRoles('COMPTABLE'), async (req, res) => {
  const actor = requireUser(req);
  const { expense, created } = await createExpense(parseBody(createExpenseSchema, req), actor.id);
  setAudit(res, {
    action: 'CREATE',
    entity: 'expenses',
    entityId: expense.id,
    after: { description: expense.description, amount: expense.amount, category: expense.category.name },
    metadata: { idempotentReplay: !created },
  });
  res.status(created ? 201 : 200).json({ expense, created });
});

expensesRouter.patch('/:id', requireRoles('COMPTABLE'), async (req, res) => {
  const id = idParam(req);
  const expense = await updateExpense(id, parseBody(createExpenseSchema.partial(), req));
  setAudit(res, {
    action: 'UPDATE',
    entity: 'expenses',
    entityId: id,
    after: { description: expense.description, amount: expense.amount },
  });
  res.json(expense);
});

expensesRouter.delete('/:id', requireRoles('COMPTABLE'), async (req, res) => {
  const id = idParam(req);
  const expense = await deleteExpense(id);
  setAudit(res, {
    action: 'DELETE',
    entity: 'expenses',
    entityId: id,
    before: { description: expense.description, amount: expense.amount, date: expense.expenseDate },
  });
  res.status(204).send();
});
