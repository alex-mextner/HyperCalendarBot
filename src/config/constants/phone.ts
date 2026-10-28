// src/config/constants/phone.ts
// Privacy-preserving phone formatting for logs and user-visible text.

import { parsePhoneNumber } from 'libphonenumber-js';

export function maskPhone(phoneE164: string): string {
  try {
    const parsed = parsePhoneNumber(phoneE164);
    if (!parsed.isValid()) return '+••• ••••';
    const last4 = phoneE164.slice(-4);
    return `+${parsed.countryCallingCode} ••• ${last4}`;
  } catch {
    return '+••• ••••';
  }
}
