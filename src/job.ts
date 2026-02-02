import { DateTime } from 'luxon';
import { PoolClient } from 'pg';
import { config, SCHEMA, SMS_TEMPLATE } from './config';
import { sendSMS, RateLimitedSMS } from './textmagic';
import { normalizePhone } from './utils';
import { isOptedOut } from './sqlite';
import { getRandomReviewUrl, hasReviewLinks } from './review-links';

export interface JobStats {
  found: number;
  eligible: number;
  skippedNoPhone: number;
  skippedInvalidPhone: number;
  skippedOptedOut: number;
  skippedNoReviewLink: number;
  skippedNonUK: number;
  sent: number;
  failed: number;
}

interface BookingRow {
  booking_id: number;
  stashpoint_name: string;
  city: string | null;
  phone_number: string | null;
  first_name: string | null;
  last_name: string | null;
  pickup: Date;
}

/**
 * Get bookings that were picked up on a specific date (Europe/London timezone)
 * @param client - Database client
 * @param targetDate - Optional date string (YYYY-MM-DD). If provided, finds pickups from (targetDate - 1 day). If not provided, defaults to yesterday
 */
async function getYesterdayPickups(client: PoolClient, targetDate?: string): Promise<BookingRow[]> {
  // If targetDate is provided, find pickups from the day before that date
  // Otherwise use yesterday
  const dateCondition = targetDate 
    ? `b.${SCHEMA.bookings.pickedUpAt}::date = ($1::date - INTERVAL '1 day')`
    : `b.${SCHEMA.bookings.pickedUpAt}::date = (CURRENT_DATE - INTERVAL '1 day')`;
  
  const query = `
    SELECT 
      u.${SCHEMA.users.firstName},
      u.${SCHEMA.users.lastName},
      u.${SCHEMA.users.phoneNumber},
      b.${SCHEMA.bookings.id} AS booking_id,
      b.${SCHEMA.bookings.pickedUpAt} AS pickup,
      sp.${SCHEMA.stashpoints.businessName} AS stashpoint_name,
      l.${SCHEMA.locations.name} AS city
    FROM ${SCHEMA.bookings.table} b
    JOIN ${SCHEMA.customers.table} c ON b.${SCHEMA.bookings.customerId} = c.${SCHEMA.customers.id}
    JOIN ${SCHEMA.users.table} u ON c.${SCHEMA.customers.userId} = u.${SCHEMA.users.id}
    JOIN ${SCHEMA.stashpoints.table} sp ON b.${SCHEMA.bookings.stashpointId} = sp.${SCHEMA.stashpoints.id}
    LEFT JOIN ${SCHEMA.locations.table} l ON sp.${SCHEMA.stashpoints.nearestCityId} = l.${SCHEMA.locations.id}
    WHERE ${dateCondition}
      AND u.${SCHEMA.users.phoneNumber} IS NOT NULL
      AND u.${SCHEMA.users.phoneNumber} <> ''
      AND b.cancelled = false
  `;

  const result = targetDate 
    ? await client.query(query, [targetDate])
    : await client.query(query);
  return result.rows;
}

/**
 * Main job logic: query, filter, send SMS
 * @param client - Database client
 * @param targetDate - Optional date string (YYYY-MM-DD). If not provided, defaults to yesterday
 */
export async function runJob(client: PoolClient, targetDate?: string): Promise<JobStats> {
  const stats: JobStats = {
    found: 0,
    eligible: 0,
    skippedNoPhone: 0,
    skippedInvalidPhone: 0,
    skippedOptedOut: 0,
    skippedNoReviewLink: 0,
    skippedNonUK: 0,
    sent: 0,
    failed: 0,
  };

  const dateLabel = targetDate 
    ? `the day before ${targetDate} (selected date: ${targetDate})`
    : 'yesterday';
  console.log(`[JOB] Starting at ${DateTime.now().setZone(config.timezone).toISO()}`);
  console.log(`[JOB] Looking for pickups from ${dateLabel} (Europe/London timezone)`);
  console.log(`[JOB] DRY_RUN mode: ${config.dryRun}`);

  // Get pickups for the target date (already filtered for phone numbers in SQL)
  const bookings = await getYesterdayPickups(client, targetDate);
  stats.found = bookings.length;
  const pickupDateLabel = targetDate 
    ? `the day before ${targetDate}`
    : 'yesterday';
  console.log(`[JOB] Found ${stats.found} bookings picked up on ${pickupDateLabel} with phone numbers`);

  if (bookings.length === 0) {
    return stats;
  }

  // Process each booking
  const rateLimitedSMS = new RateLimitedSMS(config.smsDelayMs);
  const eligibleBookings: Array<BookingRow & { phoneE164: string; reviewUrl: string }> = [];

  // First pass: filter and validate
  for (const booking of bookings) {
    // Check phone exists (should already be filtered, but double-check)
    if (!booking.phone_number) {
      stats.skippedNoPhone++;
      continue;
    }

    // Normalize phone
    const normalized = normalizePhone(booking.phone_number);
    if (!normalized) {
      stats.skippedInvalidPhone++;
      console.log(`[JOB] Skipping booking ${booking.booking_id}: invalid phone "${booking.phone_number}"`);
      continue;
    }

    // Check if UK number (+44 or starts with 07)
    const isUKNumber = normalized.e164.startsWith('+44') || 
                        (booking.phone_number && booking.phone_number.trim().startsWith('07'));
    if (!isUKNumber) {
      stats.skippedNonUK++;
      console.log(`[JOB] Skipping booking ${booking.booking_id}: non-UK phone number (${normalized.e164})`);
      continue;
    }

    // Check opt-out (from SQLite)
    if (isOptedOut(normalized.e164)) {
      stats.skippedOptedOut++;
      continue;
    }

    // Get random review URL for this city (fallback to London if city has no links)
    let reviewUrl = null;
    let usedLondonFallback = false;
    
    if (booking.city && hasReviewLinks(booking.city)) {
      reviewUrl = getRandomReviewUrl(booking.city, false);
    }
    
    // Fallback to London if city has no links
    if (!reviewUrl) {
      reviewUrl = getRandomReviewUrl('london', false);
      if (reviewUrl) {
        usedLondonFallback = true;
        console.log(`[JOB] Using London fallback for booking ${booking.booking_id} (city: "${booking.city || 'unknown'}")`);
      }
    }
    
    if (!reviewUrl) {
      stats.skippedNoReviewLink++;
      console.log(`[JOB] Skipping booking ${booking.booking_id}: no review links available (city: "${booking.city || 'unknown'}", London fallback also unavailable)`);
      continue;
    }

    // Eligible!
    eligibleBookings.push({
      ...booking,
      phoneE164: normalized.e164,
      reviewUrl,
    });
    stats.eligible++;
  }

  console.log(`[JOB] Eligible: ${stats.eligible}`);
  console.log(`[JOB] Skipped - no phone: ${stats.skippedNoPhone}, invalid phone: ${stats.skippedInvalidPhone}, non-UK: ${stats.skippedNonUK}, opted out: ${stats.skippedOptedOut}, no review link: ${stats.skippedNoReviewLink}`);

  // Second pass: send SMS (with rate limiting)
  for (const booking of eligibleBookings) {
    const message = SMS_TEMPLATE(booking.first_name, booking.reviewUrl);

    try {
      const result = await rateLimitedSMS.send(booking.phoneE164, message);

      stats.sent++;
      console.log(`[JOB] Sent SMS to ${booking.phoneE164} for booking ${booking.booking_id} (TextMagic ID: ${result.messageId}, City: ${booking.city})`);
    } catch (error: any) {
      const errorMessage = error.message || String(error);
      const errorCode = error.code || 'UNKNOWN';

      stats.failed++;
      console.error(`[JOB] Failed to send SMS to ${booking.phoneE164} for booking ${booking.booking_id}: [${errorCode}] ${errorMessage}`);
    }
  }

  console.log(`[JOB] Completed. Sent: ${stats.sent}, Failed: ${stats.failed}`);
  return stats;
}
