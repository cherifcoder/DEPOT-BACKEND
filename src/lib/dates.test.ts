import { describe, expect, it } from 'vitest';
import { endOfDay, formatDate, groupKey, parseRange, startOfDay } from './dates.js';

describe('date helpers', () => {
  it('construit une plage personnalisee inclusive', () => {
    const { from, to } = parseRange({ from: '2026-01-01', to: '2026-01-31' });
    expect(from.toISOString()).toBe('2026-01-01T00:00:00.000Z');
    expect(to.toISOString()).toBe('2026-01-31T23:59:59.999Z');
  });

  it('refuse une plage inversee', () => {
    expect(() => parseRange({ from: '2026-02-01', to: '2026-01-01' })).toThrow(/preceder/);
  });

  it('refuse une date invalide', () => {
    expect(() => parseRange({ from: 'pas-une-date' })).toThrow(/invalide/);
  });

  it('calcule les bornes de journee en UTC', () => {
    expect(startOfDay('2026-03-15T18:42:00.000Z').toISOString()).toBe('2026-03-15T00:00:00.000Z');
    expect(endOfDay('2026-03-15T18:42:00.000Z').toISOString()).toBe('2026-03-15T23:59:59.999Z');
  });

  it('groupe par jour, semaine et mois', () => {
    const date = new Date('2026-03-15T12:00:00.000Z');
    expect(groupKey(date, 'day')).toBe('2026-03-15');
    expect(groupKey(date, 'week')).toBe('2026-03-15');
    expect(groupKey(date, 'month')).toBe('2026-03');
  });

  it('formate a la francaise', () => {
    expect(formatDate('2026-03-15T12:00:00.000Z')).toBe('15/03/2026');
    expect(formatDate('2026-03-15T12:00:00.000Z', 'YYYY-MM-DD')).toBe('2026-03-15');
  });
});
