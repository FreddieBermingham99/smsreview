import { parsePhoneNumber, isValidPhoneNumber, AsYouType } from 'libphonenumber-js';
import type { CountryCode } from 'libphonenumber-js';

/**
 * Normalize phone number to E.164 format
 * Returns null if phone is invalid or cannot be normalized
 */
export function normalizePhone(
  phone: string | null | undefined,
  defaultCountry: CountryCode = 'GB'
): { e164: string; reason?: string } | null {
  if (!phone) {
    return null;
  }

  const cleaned = phone.trim().replace(/\s+/g, '');

  if (!cleaned) {
    return null;
  }

  try {
    // Try to parse as-is
    if (isValidPhoneNumber(cleaned, defaultCountry)) {
      const parsed = parsePhoneNumber(cleaned, defaultCountry);
      return { e164: parsed.number };
    }

    // Try with default country code if it looks like a local number
    const withCountry = `+${defaultCountry === 'GB' ? '44' : '1'}${cleaned.replace(/^\+/, '')}`;
    if (isValidPhoneNumber(withCountry)) {
      const parsed = parsePhoneNumber(withCountry);
      return { e164: parsed.number };
    }

    return null;
  } catch (error) {
    // If parsing fails, return null
    return null;
  }
}

/**
 * Format phone for display (not E.164)
 */
export function formatPhoneForDisplay(phone: string): string {
  try {
    const parsed = parsePhoneNumber(phone);
    return parsed.formatInternational();
  } catch {
    return phone;
  }
}

