import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { createApp } from './app.js';

const app = createApp();

describe('application express', () => {
  it('expose un point de sante sans authentification', async () => {
    const response = await request(app).get('/health');
    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ status: 'ok', service: 'depot-boissons-api' });
    expect(typeof response.body.time).toBe('string');
  });

  it('renvoie une erreur 404 structuree', async () => {
    const response = await request(app).get('/api/route-inconnue');
    expect(response.status).toBe(404);
    expect(response.body.error).toMatchObject({ code: 'NOT_FOUND' });
  });

  it('refuse une route protegee sans jeton', async () => {
    const response = await request(app).get('/api/auth/me');
    expect(response.status).toBe(401);
    expect(response.body.error).toMatchObject({ code: 'UNAUTHORIZED' });
  });

  it('refuse un jeton invalide', async () => {
    const response = await request(app).get('/api/products').set('Authorization', 'Bearer invalide');
    expect(response.status).toBe(401);
  });

  it('rejette un corps JSON invalide sur la connexion', async () => {
    const response = await request(app).post('/api/auth/login').send({ email: 'pas-un-email' });
    expect(response.status).toBe(422);
    expect(response.body.error.code).toBe('VALIDATION_ERROR');
  });
});
