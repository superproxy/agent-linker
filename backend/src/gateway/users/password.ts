import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import { MIN_PASSWORD_LENGTH } from '@linkagent/shared';

/**
 * 密码哈希：scrypt + 每用户随机 salt（Node 内置 crypto，无第三方依赖）。
 * 落盘格式：`scrypt$<saltHex>$<hashHex>`，keylen=64。
 */

const KEYLEN = 64;
const SALT_BYTES = 16;
const PREFIX = 'scrypt';

export function hashPassword(password: string): string {
  const salt = randomBytes(SALT_BYTES);
  const derived = scryptSync(password, salt, KEYLEN);
  return `${PREFIX}$${salt.toString('hex')}$${derived.toString('hex')}`;
}

export function verifyPassword(password: string, stored: string): boolean {
  const parts = stored.split('$');
  if (parts.length !== 3 || parts[0] !== PREFIX) return false;
  const salt = Buffer.from(parts[1]!, 'hex');
  const expected = Buffer.from(parts[2]!, 'hex');
  if (expected.length !== KEYLEN) return false;
  const actual = scryptSync(password, salt, KEYLEN);
  return timingSafeEqual(actual, expected);
}

/** 密码规则：长度 ≥ MIN_PASSWORD_LENGTH（与 shared 常量一致） */
export function validatePassword(password: string): string | null {
  if (typeof password !== 'string' || password.length < MIN_PASSWORD_LENGTH) {
    return `密码长度至少 ${MIN_PASSWORD_LENGTH} 位`;
  }
  return null;
}

/** 首次访问生成的管理员口令（足够长，避免弱默认值） */
export function generateAdminPassword(): string {
  return randomBytes(18).toString('base64url');
}
