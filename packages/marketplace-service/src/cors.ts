import type { RequestHandler } from 'express';

/**
 * CORS for the read-only endpoints (`/v1/reviews/config`, `/v1/sellers/*`), so browser dashboards
 * (marketplace-ui) can read them. Their data is public — chain-derived terms and reputation — so
 * the default allows any origin. `POST /v1/reviews/envelopes` is deliberately not covered: buyer
 * tools call it server-side, and a browser has no business requesting envelopes cross-origin.
 *
 * `allowed`: `['*']`, or exact origins (`https://dash.example`). Anything else gets no CORS headers,
 * so the browser blocks the read.
 */
export function readOnlyCors(allowed: string[]): RequestHandler {
  const any = allowed.includes('*');
  const origins = new Set(allowed.map((o) => o.replace(/\/+$/, '').toLowerCase()));

  return (req, res, next) => {
    const origin = req.headers.origin;
    if (any) {
      res.setHeader('Access-Control-Allow-Origin', '*');
    } else if (origin && origins.has(origin.toLowerCase())) {
      res.setHeader('Access-Control-Allow-Origin', origin);
      res.setHeader('Vary', 'Origin');
    }

    if (req.method === 'OPTIONS') {
      res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
      res.setHeader('Access-Control-Max-Age', '600');
      res.status(204).end();
      return;
    }
    next();
  };
}
