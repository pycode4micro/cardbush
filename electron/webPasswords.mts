import { randomBytes, scrypt as scryptCallback, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';

const scrypt = promisify(scryptCallback);
export async function hashWebPassword(password: string) {
  const salt = randomBytes(16), key = await scrypt(password, salt, 32) as Buffer;
  return `scrypt$16384$8$1$${salt.toString('hex')}$${key.toString('hex')}`;
}
export async function verifyWebPassword(password: string, encoded: string) {
  const parts = encoded.split('$');
  if (parts.length !== 6 || parts.slice(0, 4).join('$') !== 'scrypt$16384$8$1' || !/^[a-f0-9]{32}$/i.test(parts[4]) || !/^[a-f0-9]{64}$/i.test(parts[5])) return false;
  return timingSafeEqual(await scrypt(password, Buffer.from(parts[4], 'hex'), 32) as Buffer, Buffer.from(parts[5], 'hex'));
}
