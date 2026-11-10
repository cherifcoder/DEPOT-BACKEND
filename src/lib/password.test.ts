import { describe, expect, it } from 'vitest';
import { hashPassword, sha256, verifyPassword } from './password.js';

describe('password helpers', () => {
  it('verifie un mot de passe correct', async () => {
    const hash = await hashPassword('MotDePasse@2026');
    expect(hash).not.toBe('MotDePasse@2026');
    await expect(verifyPassword('MotDePasse@2026', hash)).resolves.toBe(true);
  });

  it('refuse un mot de passe incorrect', async () => {
    const hash = await hashPassword('MotDePasse@2026');
    await expect(verifyPassword('motdepasse@2026', hash)).resolves.toBe(false);
  });

  it('produit un SHA-256 stable', () => {
    expect(sha256('depot')).toBe('ba0465f49ae13d97b28eb70a177528f460656aced7699ff1db1fddfdba8eca1e');
    expect(sha256('depot')).toHaveLength(64);
  });
});
