import type { Prisma, StockMovementType } from '@prisma/client';
import { ApiError } from './errors.js';
import { D, round2, type Money } from './money.js';
import type { Tx } from './transaction.js';

export interface StockChangeInput {
  productId: string;
  /** Variation signee : +10 pour une entree, -3 pour une sortie. */
  delta: number;
  type: StockMovementType;
  userId: string;
  unitCost?: Prisma.Decimal.Value;
  referenceType?: string;
  referenceId?: string;
  note?: string;
  allowNegative?: boolean;
}

export interface StockChangeResult {
  productId: string;
  name: string;
  stockQty: number;
}

/**
 * Applique une variation de stock et journalise le mouvement correspondant.
 * A executer imperativement dans une transaction.
 */
export async function applyStockChange(tx: Tx, input: StockChangeInput): Promise<StockChangeResult> {
  const product = await tx.product.findUnique({
    where: { id: input.productId },
    select: { id: true, name: true, stockQty: true, costPrice: true },
  });

  if (!product) throw ApiError.notFound(`Produit introuvable (${input.productId})`);

  const nextQty = product.stockQty + input.delta;

  if (nextQty < 0 && !input.allowNegative) {
    throw ApiError.conflict(
      `Stock insuffisant pour "${product.name}" : disponible ${product.stockQty}, demande ${Math.abs(input.delta)}`,
      { productId: product.id, available: product.stockQty, requested: Math.abs(input.delta) },
    );
  }

  const updated = await tx.product.update({
    where: { id: product.id },
    data: { stockQty: nextQty },
    select: { id: true, name: true, stockQty: true },
  });

  await tx.stockMovement.create({
    data: {
      productId: product.id,
      type: input.type,
      quantity: input.delta,
      unitCost: input.unitCost !== undefined ? D(input.unitCost) : product.costPrice,
      balanceAfter: nextQty,
      referenceType: input.referenceType,
      referenceId: input.referenceId,
      note: input.note,
      userId: input.userId,
    },
  });

  return { productId: updated.id, name: updated.name, stockQty: updated.stockQty };
}

/**
 * Cout moyen pondere apres une entree de marchandise.
 * newCost = (stockActuel * coutActuel + quantiteEntrante * coutUnitaire) / (stockActuel + quantiteEntrante)
 */
export function weightedAverageCost(
  currentQty: number,
  currentCost: Prisma.Decimal.Value,
  incomingQty: number,
  incomingUnitCost: Prisma.Decimal.Value,
): Money {
  const totalQty = Math.max(0, currentQty) + incomingQty;
  if (totalQty <= 0) return round2(incomingUnitCost);

  const currentValue = D(currentCost).times(Math.max(0, currentQty));
  const incomingValue = D(incomingUnitCost).times(incomingQty);

  return round2(currentValue.plus(incomingValue).div(totalQty));
}

export interface PurchaseStockInput {
  productId: string;
  quantity: number;
  /** Cout unitaire "landed" (frais de transport inclus). */
  unitCost: Prisma.Decimal.Value;
  userId: string;
  purchaseId: string;
}

/** Entree d'achat : met a jour le stock, le cout moyen et le mouvement. */
export async function applyPurchaseStock(tx: Tx, input: PurchaseStockInput): Promise<StockChangeResult> {
  const product = await tx.product.findUnique({
    where: { id: input.productId },
    select: { stockQty: true, costPrice: true },
  });

  if (!product) throw ApiError.notFound(`Produit introuvable (${input.productId})`);

  const newCost = weightedAverageCost(product.stockQty, product.costPrice, input.quantity, input.unitCost);

  await tx.product.update({
    where: { id: input.productId },
    data: { costPrice: newCost },
  });

  return applyStockChange(tx, {
    productId: input.productId,
    delta: input.quantity,
    type: 'ACHAT',
    unitCost: input.unitCost,
    referenceType: 'purchase',
    referenceId: input.purchaseId,
    userId: input.userId,
  });
}
