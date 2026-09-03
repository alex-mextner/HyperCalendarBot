// src/services/location/address-context.ts
import { collapseToOneLine } from '../../utils/text.ts';
import type { AddressCache } from './address-cache.ts';

/**
 * Build address context string for system prompt.
 * Shows recent and frequent addresses for the user.
 */
export async function buildAddressContext(addressCache: AddressCache, userId: number): Promise<string> {
  const { recent, frequent } = await addressCache.getAddressContext(userId);

  if (recent.length === 0 && frequent.length === 0) return '';

  const lines: string[] = [];

  if (frequent.length > 0) {
    lines.push('Frequently used locations:');
    for (const f of frequent.slice(0, 15)) {
      lines.push(`- ${collapseToOneLine(f.resolvedAddress)} (used ${f.count}x)`);
    }
  }

  if (recent.length > 0) {
    lines.push('');
    lines.push('Recent locations:');
    const seen = new Set(frequent.map((f) => f.resolvedAddress));
    for (const r of recent.slice(0, 15)) {
      if (seen.has(r.resolvedAddress)) continue;
      lines.push(`- "${collapseToOneLine(r.input)}" → ${collapseToOneLine(r.resolvedAddress)}`);
      seen.add(r.resolvedAddress);
    }
  }

  return lines.join('\n');
}
