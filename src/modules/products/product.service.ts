import { z } from 'zod';
import { randomInt } from 'node:crypto';
import { ApiError } from '../../lib/errors.js';
import { prisma } from '../../lib/prisma.js';
import { applyStockChange } from '../../lib/stock.js';
import { serializableTransaction } from '../../lib/transaction.js';
import { moneySchema, uuidSchema } from '../../http.js';

const unitSchema = z.enum(['BOUTEILLE', 'CASIER', 'PACK', 'CARTON', 'FUT', 'AUTRE']);

export const productListQuerySchema = z.object({
  search: z.string().trim().max(120).optional(),
  categoryId: uuidSchema.optional(),
  lowStock: z.enum(['true', 'false']).optional(),
  isActive: z.enum(['true', 'false']).optional(),
  page: z.coerce.number().int().min(1).optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
  sort: z.enum(['name', 'stockQty', 'createdAt', 'salePriceDetail']).optional(),
  order: z.enum(['asc', 'desc']).optional(),
});

export const createProductSchema = z.object({
  sku: z.string().trim().min(2).max(50).optional(),
  name: z.string().trim().min(2, 'Nom requis').max(150),
  description: z.string().trim().max(2000).optional().nullable(),
  categoryId: uuidSchema.optional().nullable(),
  imageUrl: z.string().trim().max(500).optional().nullable(),
  unit: unitSchema.optional().default('BOUTEILLE'),
  volumeCl: z.coerce.number().int().positive().max(100_000).optional().nullable(),
  unitsPerPack: z.coerce.number().int().positive().max(10_000).optional().default(1),
  costPrice: moneySchema.optional().default(0),
  salePriceGros: moneySchema.optional().default(0),
  salePriceDetail: moneySchema.optional().default(0),
  minStockQty: z.coerce.number().int().min(0).max(1_000_000).optional().default(0),
  initialStockQty: z.coerce.number().int().min(0).max(1_000_000).optional().default(0),
  isActive: z.boolean().optional().default(true),
});

export const updateProductSchema = createProductSchema.omit({ initialStockQty: true }).partial();

export const adjustStockSchema = z.object({
  delta: z.coerce.number().int().refine((value) => value !== 0, 'La variation ne peut pas etre nulle'),
  note: z.string().trim().min(3, 'Un motif est requis').max(500),
});

export const productCategorySchema = z.object({
  name: z.string().trim().min(2).max(80),
  description: z.string().trim().max(500).optional().nullable(),
});

function slugify(value: string): string {
  return value
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 18);
}

async function generateSku(name: string): Promise<string> {
  const base = slugify(name) || 'PROD';
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const sku = `${base}-${randomInt(1000, 9999)}`;
    const exists = await prisma.product.findUnique({ where: { sku }, select: { id: true } });
    if (!exists) return sku;
  }
  return `${base}-${Date.now().toString().slice(-6)}`;
}

export async function listProducts(query: z.infer<typeof productListQuerySchema>) {
  const page = query.page ?? 1;
  const limit = query.limit ?? 20;

  const where = {
    deletedAt: null,
    ...(query.search
      ? {
          OR: [
            { name: { contains: query.search, mode: 'insensitive' as const } },
            { sku: { contains: query.search, mode: 'insensitive' as const } },
            { description: { contains: query.search, mode: 'insensitive' as const } },
          ],
        }
      : {}),
    ...(query.categoryId ? { categoryId: query.categoryId } : {}),
    ...(query.isActive ? { isActive: query.isActive === 'true' } : {}),
    ...(query.lowStock === 'true'
      ? { stockQty: { lte: prisma.product.fields.minStockQty } }
      : {}),
  };

  const [total, products] = await Promise.all([
    prisma.product.count({ where }),
    prisma.product.findMany({
      where,
      include: { category: true },
      orderBy: { [query.sort ?? 'name']: query.order ?? 'asc' },
      skip: (page - 1) * limit,
      take: limit,
    }),
  ]);

  return {
    data: products,
    meta: { page, limit, total, totalPages: Math.max(1, Math.ceil(total / limit)) },
  };
}

export async function getProduct(id: string) {
  const product = await prisma.product.findFirst({
    where: { id, deletedAt: null },
    include: { category: true },
  });
  if (!product) throw ApiError.notFound('Produit introuvable');
  return product;
}

export async function createProduct(input: z.infer<typeof createProductSchema>, userId: string) {
  const { initialStockQty, ...data } = input;

  if (data.categoryId) {
    const category = await prisma.productCategory.findUnique({ where: { id: data.categoryId } });
    if (!category) throw ApiError.badRequest('Categorie introuvable');
  }

  const sku = data.sku ?? (await generateSku(data.name));
  const existing = await prisma.product.findUnique({ where: { sku }, select: { id: true } });
  if (existing) throw ApiError.conflict('Ce code article (SKU) existe deja');

  const product = await serializableTransaction(async (tx) => {
    const created = await tx.product.create({
      data: {
        sku,
        name: data.name,
        description: data.description ?? null,
        categoryId: data.categoryId ?? null,
        imageUrl: data.imageUrl ?? null,
        unit: data.unit ?? 'BOUTEILLE',
        volumeCl: data.volumeCl ?? null,
        unitsPerPack: data.unitsPerPack ?? 1,
        costPrice: data.costPrice ?? 0,
        salePriceGros: data.salePriceGros ?? 0,
        salePriceDetail: data.salePriceDetail ?? 0,
        stockQty: 0,
        minStockQty: data.minStockQty ?? 0,
        isActive: data.isActive ?? true,
      },
    });

    if (initialStockQty && initialStockQty > 0) {
      await applyStockChange(tx, {
        productId: created.id,
        delta: initialStockQty,
        type: 'AJUSTEMENT',
        unitCost: created.costPrice,
        userId,
        note: 'Stock initial a la creation du produit',
        referenceType: 'product',
        referenceId: created.id,
      });
    }

    return tx.product.findUniqueOrThrow({ where: { id: created.id }, include: { category: true } });
  });

  return product;
}

export async function updateProduct(id: string, input: z.infer<typeof updateProductSchema>) {
  const product = await getProduct(id);

  if (input.categoryId) {
    const category = await prisma.productCategory.findUnique({ where: { id: input.categoryId } });
    if (!category) throw ApiError.badRequest('Categorie introuvable');
  }

  if (input.sku && input.sku !== product.sku) {
    const existing = await prisma.product.findUnique({ where: { sku: input.sku }, select: { id: true } });
    if (existing && existing.id !== id) throw ApiError.conflict('Ce code article (SKU) existe deja');
  }

  return prisma.product.update({
    where: { id },
    data: input,
    include: { category: true },
  });
}

export async function archiveProduct(id: string): Promise<void> {
  const product = await prisma.product.findFirst({ where: { id, deletedAt: null } });
  if (!product) throw ApiError.notFound('Produit introuvable');

  await prisma.product.update({
    where: { id },
    data: { isActive: false, deletedAt: new Date() },
  });
}

export async function adjustStock(id: string, input: z.infer<typeof adjustStockSchema>, userId: string) {
  await getProduct(id);

  return serializableTransaction(async (tx) => {
    await applyStockChange(tx, {
      productId: id,
      delta: input.delta,
      type: 'AJUSTEMENT',
      userId,
      note: input.note,
      referenceType: 'product',
      referenceId: id,
    });

    return tx.product.findUniqueOrThrow({ where: { id }, include: { category: true } });
  });
}

export async function listProductMovements(productId: string, page: number, limit: number) {
  const [total, movements] = await Promise.all([
    prisma.stockMovement.count({ where: { productId } }),
    prisma.stockMovement.findMany({
      where: { productId },
      include: { user: { select: { id: true, fullName: true } } },
      orderBy: { createdAt: 'desc' },
      skip: (page - 1) * limit,
      take: limit,
    }),
  ]);

  return {
    data: movements,
    meta: { page, limit, total, totalPages: Math.max(1, Math.ceil(total / limit)) },
  };
}

export async function listCategories() {
  return prisma.productCategory.findMany({
    orderBy: { name: 'asc' },
    include: { _count: { select: { products: true } } },
  });
}

export async function createCategory(input: z.infer<typeof productCategorySchema>) {
  return prisma.productCategory.create({ data: input });
}

export async function updateCategory(id: string, input: z.infer<typeof productCategorySchema>) {
  await prisma.productCategory.findUniqueOrThrow({ where: { id } });
  return prisma.productCategory.update({ where: { id }, data: input });
}

export async function deleteCategory(id: string): Promise<void> {
  await prisma.productCategory.delete({ where: { id } });
}
