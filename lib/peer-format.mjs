import { createHash } from 'node:crypto';

export function sanitizePeerPart(value, fallback = 'peer') {
  const text = String(value || '').toLowerCase()
    .replace(/[^a-z0-9._-]/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 32);
  return text || fallback;
}

export function shortHash(value) {
  return createHash('sha1').update(String(value)).digest('hex').slice(0, 8);
}
