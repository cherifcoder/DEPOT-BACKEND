import { describe, expect, it } from 'vitest';
import { toNumber } from './money.js';
import { weightedAverageCost } from './stock.js';

describe('weightedAverageCost', () => {
  it('pondere le cout par les quantites en stock', () => {
    // 10 unites a 1 000 + 10 unites a 2 000 => 1 500
    expect(toNumber(weightedAverageCost(10, '1000', 10, '2000'))).toBe(1500);
  });

  it('retourne le cout entrant lorsque le stock est vide', () => {
    expect(toNumber(weightedAverageCost(0, '0', 5, '1250.50'))).toBe(1250.5);
  });

  it('ignore un stock negatif', () => {
    expect(toNumber(weightedAverageCost(-4, '800', 4, '1200'))).toBe(1200);
  });

  it('retourne le cout entrant si quantite totale nulle', () => {
    expect(toNumber(weightedAverageCost(0, '999', 0, '1500'))).toBe(1500);
  });

  it('arrondit au centime', () => {
    // (3 * 1 000 + 1 * 1 000.01) / 4 = 1 000.0025 -> 1 000
    expect(toNumber(weightedAverageCost(3, '1000', 1, '1000.01'))).toBe(1000);
    // (2 * 1 000 + 1 * 1 000.05) / 3 = 1 000.0166... -> 1 000.02
    expect(toNumber(weightedAverageCost(2, '1000', 1, '1000.05'))).toBe(1000.02);
  });
});
