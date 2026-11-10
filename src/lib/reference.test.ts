import { describe, expect, it } from 'vitest';
import { makeReference, randomPassword, randomToken } from './reference.js';

describe('reference helpers', () => {
  it('genere une reference lisible et datee', () => {
    const reference = makeReference('VTE', new Date('2026-10-23T09:00:00.000Z'));
    expect(reference).toMatch(/^VTE-20261023-[A-Z2-9]{5}$/);
  });

  it('genere des references differentes', () => {
    const first = makeReference('LIV');
    const second = makeReference('LIV');
    expect(first).not.toBe(second);
  });

  it('genere un jeton hexadecimal de la bonne taille', () => {
    const token = randomToken(16);
    expect(token).toMatch(/^[0-9a-f]{32}$/);
  });

  it('genere un mot de passe conforme aux regles', () => {
    const password = randomPassword(16);
    expect(password).toHaveLength(16);
    expect(password).toMatch(/[a-z]/);
    expect(password).toMatch(/[A-Z]/);
    expect(password).toMatch(/[2-9]/);
    expect(password).toMatch(/[!@#$%&*]/);
  });
});
