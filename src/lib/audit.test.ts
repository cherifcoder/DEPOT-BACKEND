import { describe, expect, it } from 'vitest';
import { sanitizeAuditPayload } from './audit.js';

describe('sanitizeAuditPayload', () => {
  it('masque les champs sensibles', () => {
    const payload = sanitizeAuditPayload({
      email: 'admin@depot.app',
      password: 'secret',
      refreshToken: 'abc',
      nested: { authorization: 'Bearer x', role: 'ADMIN' },
    }) as Record<string, unknown>;

    expect(payload.email).toBe('admin@depot.app');
    expect(payload.password).toBeUndefined();
    expect(payload.refreshToken).toBeUndefined();
    expect(payload.nested).toEqual({ role: 'ADMIN' });
  });

  it('tronque les longues chaines et les medias base64', () => {
    const longText = sanitizeAuditPayload('x'.repeat(2000)) as string;
    expect(longText.length).toBeLessThan(2000);
    expect(longText).toContain('[tronque]');

    const media = sanitizeAuditPayload(`data:image/png;base64,${'A'.repeat(50)}`) as string;
    expect(media).toBe('[media base64 tronque]');
  });

  it('convertit les dates et les bigint', () => {
    const payload = sanitizeAuditPayload({ at: new Date('2026-10-23T10:00:00.000Z'), count: 10n }) as Record<
      string,
      unknown
    >;
    expect(payload.at).toBe('2026-10-23T10:00:00.000Z');
    expect(payload.count).toBe('10');
  });

  it('limite la profondeur', () => {
    const deep = { a: { b: { c: { d: { e: { f: { g: { h: 1 } } } } } } } };
    expect(JSON.stringify(sanitizeAuditPayload(deep))).toContain('profondeur maximale');
  });

  it('conserve null et undefined', () => {
    expect(sanitizeAuditPayload(null)).toBeNull();
    expect(sanitizeAuditPayload(undefined)).toBeUndefined();
  });
});
