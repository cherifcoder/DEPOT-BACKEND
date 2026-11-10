import dayjs from 'dayjs';
import utc from 'dayjs/plugin/utc.js';
import customParseFormat from 'dayjs/plugin/customParseFormat.js';

dayjs.extend(utc);
dayjs.extend(customParseFormat);

export { dayjs };

export type Period = 'day' | 'week' | 'month' | 'year' | 'custom' | 'all';

export interface DateRange {
  from: Date;
  to: Date;
}

export interface RangeQuery {
  from?: string;
  to?: string;
  period?: Period;
}

/**
 * Construit une plage de dates inclusive a partir des filtres de l'API.
 * Les bornes `from`/`to` sont interpretees en UTC (journee complete pour `to`).
 */
export function parseRange(query: RangeQuery, defaultPeriod: Period = 'month'): DateRange {
  const now = dayjs.utc();

  if (query.from || query.to) {
    const from = query.from ? dayjs.utc(query.from) : dayjs.utc('2000-01-01');
    const to = query.to ? dayjs.utc(query.to).endOf('day') : now.endOf('day');
    if (!from.isValid() || !to.isValid()) {
      throw new Error('Plage de dates invalide (format attendu: YYYY-MM-DD)');
    }
    if (from.isAfter(to)) {
      throw new Error('La date de debut doit preceder la date de fin');
    }
    return { from: from.startOf('day').toDate(), to: to.toDate() };
  }

  switch (query.period ?? defaultPeriod) {
    case 'day':
      return { from: now.startOf('day').toDate(), to: now.endOf('day').toDate() };
    case 'week':
      return { from: now.startOf('week').toDate(), to: now.endOf('week').toDate() };
    case 'year':
      return { from: now.startOf('year').toDate(), to: now.endOf('year').toDate() };
    case 'all':
      return { from: dayjs.utc('2000-01-01').startOf('day').toDate(), to: now.endOf('day').toDate() };
    case 'custom':
    case 'month':
    default:
      return { from: now.startOf('month').toDate(), to: now.endOf('month').toDate() };
  }
}

export function startOfDay(date: Date | string): Date {
  return dayjs.utc(date).startOf('day').toDate();
}

export function endOfDay(date: Date | string): Date {
  return dayjs.utc(date).endOf('day').toDate();
}

export function formatDate(date: Date | string, pattern = 'DD/MM/YYYY'): string {
  return dayjs.utc(date).format(pattern);
}

export function formatDateTime(date: Date | string): string {
  return dayjs.utc(date).format('DD/MM/YYYY HH:mm');
}

/** Cle de regroupement temporel utilisee par les rapports. */
export function groupKey(date: Date, granularity: 'day' | 'week' | 'month'): string {
  const d = dayjs.utc(date);
  if (granularity === 'week') return d.startOf('week').format('YYYY-MM-DD');
  if (granularity === 'month') return d.format('YYYY-MM');
  return d.format('YYYY-MM-DD');
}
