import { Prisma } from '@prisma/client';

/** Montant monetaire (Decimal Prisma, 2 decimales). */
export type Money = Prisma.Decimal;

export const D = (value: Prisma.Decimal.Value): Money => new Prisma.Decimal(value);

export const ZERO: Money = D(0);

export const round2 = (value: Prisma.Decimal.Value): Money =>
  D(value).toDecimalPlaces(2, Prisma.Decimal.ROUND_HALF_UP);

export const add = (a: Prisma.Decimal.Value, b: Prisma.Decimal.Value): Money => round2(D(a).plus(D(b)));

export const sub = (a: Prisma.Decimal.Value, b: Prisma.Decimal.Value): Money => round2(D(a).minus(D(b)));

export const mul = (a: Prisma.Decimal.Value, b: Prisma.Decimal.Value): Money => round2(D(a).times(D(b)));

export const sum = (values: Prisma.Decimal.Value[]): Money =>
  round2(values.reduce<Money>((total, value) => total.plus(D(value)), ZERO));

export const isNegative = (value: Prisma.Decimal.Value): boolean => D(value).isNegative();

export const isPositive = (value: Prisma.Decimal.Value): boolean => D(value).greaterThan(0);

export const toNumber = (value: Prisma.Decimal.Value): number => Number(D(value).toFixed(2));

export const formatMoney = (value: Prisma.Decimal.Value, currency = 'XOF'): string =>
  `${toNumber(value).toLocaleString('fr-FR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} ${currency}`;

/** Arrondi "banquier" evite : on arrondit toujours au centime superieur pour les prix de vente. */
export const ceil2 = (value: Prisma.Decimal.Value): Money =>
  D(value).toDecimalPlaces(2, Prisma.Decimal.ROUND_CEIL);
