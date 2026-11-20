import type { Request, Response } from 'express';
import { readOnlyCors } from '../src/cors.js';

function run(allowed: string[], method: string, origin?: string) {
  const headers: Record<string, string> = {};
  const res = {
    setHeader: (k: string, v: string) => (headers[k] = v),
    status: jest.fn().mockReturnThis(),
    end: jest.fn(),
  } as unknown as Response;
  const next = jest.fn();
  readOnlyCors(allowed)({ method, headers: origin ? { origin } : {} } as Request, res, next);
  return { headers, res, next };
}

describe('readOnlyCors', () => {
  it('allows any origin with *', () => {
    const { headers, next } = run(['*'], 'GET', 'https://dash.example');
    expect(headers['Access-Control-Allow-Origin']).toBe('*');
    expect(next).toHaveBeenCalled();
  });

  it('echoes a listed origin and varies on it', () => {
    const { headers } = run(['https://dash.example/'], 'GET', 'https://DASH.example');
    expect(headers['Access-Control-Allow-Origin']).toBe('https://DASH.example');
    expect(headers.Vary).toBe('Origin');
  });

  it('sends no CORS headers to an unlisted origin', () => {
    const { headers, next } = run(['https://dash.example'], 'GET', 'https://evil.example');
    expect(headers['Access-Control-Allow-Origin']).toBeUndefined();
    expect(next).toHaveBeenCalled();
  });

  it('answers preflight with 204 and GET only', () => {
    const { headers, res, next } = run(['*'], 'OPTIONS', 'https://dash.example');
    expect(res.status).toHaveBeenCalledWith(204);
    expect(headers['Access-Control-Allow-Methods']).toBe('GET, OPTIONS');
    expect(next).not.toHaveBeenCalled();
  });
});
