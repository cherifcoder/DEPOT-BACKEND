import { describe, expect, it } from 'vitest';
import { D, add, formatMoney, isNegative, isPositive, mul, round2, sub, sum, toNumber } from './money.js';

describe('money helpers', () => {
  it('arrondit au centime le plus proche (half up)', () => {
    expect(toNumber(round2('12.345'))).toBe(12.35);
    expect(toNumber(round2('12.344'))).toBe(12.34);
    expect(toNumber(round2(-12.345))).toBe(-12.35);
  });

  it('additionne et soustrait sans derive flottante', () => {
    expect(toNumber(add(0.1, 0.2))).toBe(0.3);
    expect(toNumber(sub('1000.10', '0.10'))).toBe(1000);
  });

  it('multiplie et arrondit le resultat', () => {
    expect(toNumber(mul('19.99', 3))).toBe(59.97);
    expect(toNumber(mul('0.335', 2))).toBe(0.67);
  });

  it('somme une liste de montants', () => {
    expect(toNumber(sum(['100.25', '200.25', '0.50']))).toBe(301);
    expect(toNumber(sum([]))).toBe(0);
  });

  it('detecte le signe', () => {
    expect(isNegative('-1')).toBe(true);
    expect(isNegative('0')).toBe(false);
    expect(isPositive('0.01')).toBe(true);
    expect(isPositive(0)).toBe(false);
  });

  it('convertit en nombre a deux decimales', () => {
    expect(toNumber(D('1234.567'))).toBe(1234.57);
    expect(toNumber(D(7))).toBe(7);
  });

  it('formate en franc CFA', () => {
    expect(formatMoney('1500000')).toContain('1');
    expect(formatMoney('1500000')).toContain('XOF');
    expect(formatMoney('1500000', 'FCFA')).toContain('FCFA');
  });
});
