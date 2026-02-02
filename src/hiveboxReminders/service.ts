import { PoolClient } from 'pg';
import { DateTime } from 'luxon';
import { config } from '../config';
import { normalizePhone } from '../utils';
import { isOptedOut, logSMS, createJobRunSummary, updateJobRunSummary } from '../sqlite';
import { sendSMS, RateLimitedSMS } from '../textmagic';
import { getHiveboxPreviousHourPickups, HiveboxBookingRow } from './query';

export interface HiveboxJobStats {
  fetched: number;
  sent: number;
  skippedOptedOut: number;
  skippedInvalidPhone: number;
  skippedNonUK: number;
  failed: number;
}

const FEATURE_NAME = 'hivebox_pickup_reminder';

/**
 * Create SMS message for Hivebox reminder
 */
function createHiveboxMessage(firstName: string | null | undefined): string {
  const greeting = firstName && firstName.trim() ? `Hi ${firstName.trim()}` : 'Hi there';
  return `${greeting}

Your locker booking with Stasher ended an hour ago. If you have picked up your items, thank you! Otherwise, please do so or contact Support.`;
}

/**
 * Check if phone number is UK (+44 or starts with 07)
 */
function isUKNumber(e164: string, originalPhone: string | null | undefined): boolean {
  if (e164.startsWith('+44')) return true;
  if (!originalPhone) return false;
  return originalPhone.trim().startsWith('07');
}

/**
 * Run Hivebox reminder job once
 */
export async function runHiveboxReminderJob(
  client: PoolClient,
  dryRun: boolean = false
): Promise<HiveboxJobStats> {
  const isDryRun = Boolean(dryRun);
  const stats: HiveboxJobStats = {
    fetched: 0,
    sent: 0,
    skippedOptedOut: 0,
    skippedInvalidPhone: 0,
    skippedNonUK: 0,
    failed: 0,
  };

  const startedAt = DateTime.now().setZone(config.timezone).toISO();
  if (!startedAt) {
    throw new Error('Failed to get current time');
  }
  const jobRunId = createJobRunSummary({
    feature: FEATURE_NAME,
    started_at: startedAt,
    finished_at: null,
    fetched_count: 0,
    sent_count: 0,
    skipped_count: 0,
    failed_count: 0,
    error: null,
  });

  console.log(`[HIVEBOX] Starting job at ${startedAt} (dryRun: ${isDryRun})`);

  try {
    // Fetch bookings from previous hour
    const bookings = await getHiveboxPreviousHourPickups(client);
    stats.fetched = bookings.length;
    updateJobRunSummary(jobRunId, { fetched_count: stats.fetched });

    console.log(`[HIVEBOX] Found ${stats.fetched} Hivebox bookings from previous hour`);

    if (bookings.length === 0) {
      const finishedAt = DateTime.now().setZone(config.timezone).toISO();
      updateJobRunSummary(jobRunId, { finished_at: finishedAt });
      console.log(`[HIVEBOX] No recipients, job complete`);
      return stats;
    }

    // Process each booking
    const rateLimitedSMS = new RateLimitedSMS(config.smsDelayMs);

    for (const booking of bookings) {
      // Normalize phone
      const normalized = normalizePhone(booking.phone_number);
      if (!normalized) {
        stats.skippedInvalidPhone++;
        logSMS({
          feature: FEATURE_NAME,
          booking_id: booking.booking_id,
          phone: booking.phone_number || 'unknown',
          pickup_time: booking.pickup ? new Date(booking.pickup).toISOString() : null,
          status: 'skipped_invalid_phone',
          error: 'Invalid phone number format',
        });
        continue;
      }

      // Check if UK number
      if (!isUKNumber(normalized.e164, booking.phone_number)) {
        stats.skippedNonUK++;
        logSMS({
          feature: FEATURE_NAME,
          booking_id: booking.booking_id,
          phone: normalized.e164,
          pickup_time: booking.pickup ? new Date(booking.pickup).toISOString() : null,
          status: 'skipped_non_uk',
          error: 'Non-UK phone number',
        });
        continue;
      }

      // Check opt-out
      if (isOptedOut(normalized.e164)) {
        stats.skippedOptedOut++;
        logSMS({
          feature: FEATURE_NAME,
          booking_id: booking.booking_id,
          phone: normalized.e164,
          pickup_time: booking.pickup ? new Date(booking.pickup).toISOString() : null,
          status: 'skipped_opted_out',
          error: null,
        });
        continue;
      }

      // Create message
      const message = createHiveboxMessage(booking.first_name);

      // Send SMS (or dry run)
      try {
        if (isDryRun) {
          console.log(`[HIVEBOX] [DRY RUN] Would send to ${normalized.e164} for booking ${booking.booking_id}: ${message}`);
          stats.sent++;
        } else {
          const result = await rateLimitedSMS.send(normalized.e164, message);
          console.log(`[HIVEBOX] Sent SMS to ${normalized.e164} for booking ${booking.booking_id} (TextMagic ID: ${result.messageId})`);
          stats.sent++;
        }

        logSMS({
          feature: FEATURE_NAME,
          booking_id: booking.booking_id,
          phone: normalized.e164,
          pickup_time: booking.pickup ? new Date(booking.pickup).toISOString() : null,
          status: 'sent',
          error: null,
        });
      } catch (error: any) {
        stats.failed++;
        const errorMessage = error.message || String(error);
        console.error(`[HIVEBOX] Failed to send SMS to ${normalized.e164} for booking ${booking.booking_id}: ${errorMessage}`);
        
        logSMS({
          feature: FEATURE_NAME,
          booking_id: booking.booking_id,
          phone: normalized.e164,
          pickup_time: booking.pickup ? new Date(booking.pickup).toISOString() : null,
          status: 'failed',
          error: errorMessage,
        });
      }
    }

    const finishedAt = DateTime.now().setZone(config.timezone).toISO();
    const skippedTotal = stats.skippedOptedOut + stats.skippedInvalidPhone + stats.skippedNonUK;
    updateJobRunSummary(jobRunId, {
      finished_at: finishedAt,
      sent_count: stats.sent,
      skipped_count: skippedTotal,
      failed_count: stats.failed,
    });

    console.log(`[HIVEBOX] Job complete. Sent: ${stats.sent}, Skipped: ${skippedTotal}, Failed: ${stats.failed}`);
    return stats;
  } catch (error: any) {
    const errorMessage = error.message || String(error);
    console.error(`[HIVEBOX] Job error: ${errorMessage}`);
    const finishedAt = DateTime.now().setZone(config.timezone).toISO();
    updateJobRunSummary(jobRunId, {
      finished_at: finishedAt,
      error: errorMessage,
    });
    throw error;
  }
}

