import { randomBytes } from 'node:crypto';

/** Generate an 8-hex-char pairing code (e.g. "a3f8b1c2"). */
export function generatePairingCode(): string {
  return randomBytes(4).toString('hex');
}
