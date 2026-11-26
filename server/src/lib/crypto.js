import crypto from 'node:crypto';

export const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');

/** Key format: gw_<12 hex id>_<43 char base64url secret> (256 bits of entropy in the secret). */
export function newApiKey() {
  const keyId = crypto.randomBytes(6).toString('hex');
  const secret = crypto.randomBytes(32).toString('base64url');
  return { keyId, secret, plaintext: `gw_${keyId}_${secret}` };
}

export function parseApiKey(s) {
  const m = /^gw_([0-9a-f]{12})_([A-Za-z0-9_-]{43})$/.exec(typeof s === 'string' ? s : '');
  return m ? { keyId: m[1], secret: m[2] } : null;
}

/** Keyed hash so a leaked database alone cannot be used to verify guesses. High-entropy secret, so no slow KDF is needed. */
export const hashSecret = (secret, pepper) => crypto.createHmac('sha256', pepper).update(secret).digest('hex');

/** Constant-time comparison for strings of any length (hash first to equalise length). */
export function safeEqual(a, b) {
  const ha = crypto.createHash('sha256').update(String(a)).digest();
  const hb = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(ha, hb);
}

/** AES-256-GCM. `aad` binds the ciphertext to a tenant so entries cannot be replayed across tenants. */
export function encrypt(plain, key, aad = '') {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', key, iv);
  c.setAAD(Buffer.from(aad));
  const ct = Buffer.concat([c.update(plain, 'utf8'), c.final()]);
  return Buffer.concat([iv, c.getAuthTag(), ct]).toString('base64');
}

export function decrypt(b64, key, aad = '') {
  const b = Buffer.from(b64, 'base64');
  const d = crypto.createDecipheriv('aes-256-gcm', key, b.subarray(0, 12));
  d.setAAD(Buffer.from(aad));
  d.setAuthTag(b.subarray(12, 28));
  return Buffer.concat([d.update(b.subarray(28)), d.final()]).toString('utf8');
}
