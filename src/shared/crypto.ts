import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

/** AES-256-GCM envelope for credentials at rest: `v1.<iv>.<tag>.<ciphertext>` (base64url). */
export class SecretBox {
  private readonly key: Buffer;
  constructor(base64Key: string) {
    this.key = Buffer.from(base64Key, 'base64');
    if (this.key.length !== 32) throw new Error('Encryption key must be 32 bytes');
  }

  seal(value: unknown, aad: string): string {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.key, iv);
    cipher.setAAD(Buffer.from(aad));
    const ct = Buffer.concat([cipher.update(JSON.stringify(value), 'utf8'), cipher.final()]);
    return ['v1', iv, cipher.getAuthTag(), ct].map((p) => (typeof p === 'string' ? p : p.toString('base64url'))).join('.');
  }

  /** `aad` binds a ciphertext to its row (tenant + provider) so blobs cannot be swapped between tenants. */
  open<T>(envelope: string, aad: string): T {
    const [version, iv, tag, ct] = envelope.split('.');
    if (version !== 'v1' || !iv || !tag || !ct) throw new Error('Unsupported secret envelope');
    const decipher = createDecipheriv('aes-256-gcm', this.key, Buffer.from(iv, 'base64url'));
    decipher.setAAD(Buffer.from(aad));
    decipher.setAuthTag(Buffer.from(tag, 'base64url'));
    const pt = Buffer.concat([decipher.update(Buffer.from(ct, 'base64url')), decipher.final()]);
    return JSON.parse(pt.toString('utf8')) as T;
  }
}
