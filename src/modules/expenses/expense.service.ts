import { z } from 'zod';
import { Prisma } from '@prisma/client';
import { ApiError } from '../../lib/errors.js';
import { prisma } from '../../lib/prisma.js';
import { parseRange, dayjs, type Period } from '../../lib/dates.js';
import { dateSchema, moneySchema, optionalText, uuidSchema } from '../../http.js';

export const expenseCategorySchema = z.object({
  name: z.string().trim().min(2, 'Nom requis').max(80),
  description: z.string().trim().max(500).optional().nullable(),
});

export const createExpenseSchema = z.object({
  categoryId: uuidSchema,
  amount: moneySchema.refine((value) => value > 0, 'Le montant doit etre superieur a zero'),
  description: z.string().trim().min(3, 'Description requise').max(500),
  expenseDate: dateSchema.optional(),
  attachmentUrl: z.string().trim().max(500).optional().nullable(),
  clientRef: z.string().trim().min(1).max(120).optional().nullable(),
});

export const listExpenseQuerySchema = z.object({
  categoryId: uuidSchema.optional(),
  search: z.string().trim().max(120).optional(),
  from: z.string().optional(),
  to: z.string().optional(),
  period: z.enum(['day', 'week', 'month', 'year', 'custom', 'all']).optional(),
  page: z.coerce.number().int().min(1).optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
});

export async function listExpenseCategories(includeArchived = false) {
  return prisma.expenseCategory.findMany({
    where: includeArchived ? {} : { isArchived: false },
    orderBy: { name: 'asc' },
    include: { _count: { select: { expenses: true } } },
  });
}

export async function createExpenseCategory(input: z.infer<typeof expenseCategorySchema>) {
  return prisma.expenseCategory.create({ data: input });
}

export async function updateExpenseCategory(
  id: string,
  input: Partial<z.infer<typeof expenseCategorySchema>> & { isArchived?: boolean },
) {
  await prisma.expenseCategory.findUniqueOrThrow({ where: { id } });
  return prisma.expenseCategory.update({ where: { id }, data: input });
}

export async function deleteExpenseCategory(id: string) {
  const expenses = await prisma.expense.count({ where: { categoryId: id } });
  if (expenses > 0) {
    throw ApiError.conflict(
      'Cette categorie contient des depenses : archivez-la plutot que de la supprimer',
      { expenses },
    );
  }
  await prisma.expenseCategory.delete({ where: { id } });
}

const expenseInclude = {
  category: { select: { id: true, name: true } },
  user: { select: { id: true, fullName: true } },
} satisfies Prisma.ExpenseInclude;

export async function listExpenses(query: z.infer<typeof listExpenseQuerySchema>) {
  const page = query.page ?? 1;
  const limit = query.limit ?? 20;
  const hasRange = Boolean(query.from || query.to || query.period);
  const range = hasRange ? parseRange(query) : null;

  const where: Prisma.ExpenseWhereInput = {
    ...(query.categoryId ? { categoryId: query.categoryId } : {}),
    ...(query.search ? { description: { contains: query.search, mode: 'insensitive' } } : {}),
    ...(range ? { expenseDate: { gte: range.from, lte: range.to } } : {}),
  };

  const [total, expenses] = await Promise.all([
    prisma.expense.count({ where }),
    prisma.expense.findMany({
      where,
      include: expenseInclude,
      orderBy: { expenseDate: 'desc' },
      skip: (page - 1) * limit,
      take: limit,
    }),
  ]);

  return {
    data: expenses,
    meta: { page, limit, total, totalPages: Math.max(1, Math.ceil(total / limit)) },
  };
}

export async function createExpense(input: z.infer<typeof createExpenseSchema>, actorId: string) {
  if (input.clientRef) {
    const existing = await prisma.expense.findUnique({ where: { clientRef: input.clientRef }, include: expenseInclude });
    if (existing) return { expense: existing, created: false };
  }

  const category = await prisma.expenseCategory.findUnique({ where: { id: input.categoryId } });
  if (!category) throw ApiError.badRequest('Categorie de depense introuvable');
  if (category.isArchived) throw ApiError.badRequest('Cette categorie est archivee');

  const expense = await prisma.expense.create({
    data: {
      categoryId: category.id,
      amount: input.amount,
      description: input.description,
      expenseDate: input.expenseDate ? dayjs.utc(input.expenseDate).toDate() : new Date(),
      attachmentUrl: input.attachmentUrl ?? null,
      userId: actorId,
      clientRef: input.clientRef ?? null,
    },
    include: expenseInclude,
  });

  return { expense, created: true };
}

export async function updateExpense(id: string, input: Partial<z.infer<typeof createExpenseSchema>>) {
  await prisma.expense.findUniqueOrThrow({ where: { id } });
  return prisma.expense.update({
    where: { id },
    data: {
      ...input,
      expenseDate: input.expenseDate ? dayjs.utc(input.expenseDate).toDate() : undefined,
    },
    include: expenseInclude,
  });
}

export async function deleteExpense(id: string) {
  const expense = await prisma.expense.findUnique({ where: { id }, include: expenseInclude });
  if (!expense) throw ApiError.notFound('Depense introuvable');
  await prisma.expense.delete({ where: { id } });
  return expense;
}

export async function expenseSummary(query: { from?: string; to?: string; period?: Period }) {
  const range = parseRange(query, 'month');
  const where: Prisma.ExpenseWhereInput = { expenseDate: { gte: range.from, lte: range.to } };

  const [totals, byCategory] = await Promise.all([
    prisma.expense.aggregate({ where, _sum: { amount: true }, _count: { _all: true } }),
    prisma.expense.groupBy({
      by: ['categoryId'],
      where,
      _sum: { amount: true },
      _count: { _all: true },
      orderBy: { _sum: { amount: 'desc' } },
    }),
  ]);

  const categories = await prisma.expenseCategory.findMany({
    where: { id: { in: byCategory.map((entry) => entry.categoryId) } },
    select: { id: true, name: true, isArchived: true },
  });
  const byId = new Map(categories.map((category) => [category.id, category]));

  return {
    range,
    totalAmount: totals._sum.amount ?? 0,
    count: totals._count._all,
    byCategory: byCategory.map((entry) => ({
      category: byId.get(entry.categoryId) ?? { id: entry.categoryId, name: 'Categorie supprimee', isArchived: false },
      amount: entry._sum.amount ?? 0,
      count: entry._count._all,
    })),
  };
}
