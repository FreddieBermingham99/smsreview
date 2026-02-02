import { Request, Response } from 'express';
import { readPool } from '../db/postgres';
import { normalizePhone } from '../utils';
import { isOptedOut } from '../sqlite';
import { getHiveboxPreviousHourPickups, HiveboxBookingRow } from './query';
import { runHiveboxReminderJob } from './service';
import { getSMSLogs, getLatestJobRunSummary, SMSLog, JobRunSummary } from '../sqlite';

const FEATURE_NAME = 'hivebox_pickup_reminder';

/**
 * Check if phone number is UK (+44 or starts with 07)
 */
function isUKNumber(e164: string, originalPhone: string | null | undefined): boolean {
  if (e164.startsWith('+44')) return true;
  if (!originalPhone) return false;
  return originalPhone.trim().startsWith('07');
}

/**
 * Create API routes for Hivebox reminders
 */
export function createHiveboxRoutes(app: any): void {
  // Preview endpoint - shows what would be sent right now
  app.get('/api/hivebox/preview', async (_req: Request, res: Response) => {
    try {
      const client = await readPool.connect();
      try {
        const bookings = await getHiveboxPreviousHourPickups(client);
        
        // Batch fetch all opt-outs
        const { getAllOptOuts } = await import('../sqlite');
        const allOptOuts = getAllOptOuts(10000);
        const optOutSet = new Set(allOptOuts.map(o => o.phone_e164));
        
        const enriched = bookings.map((booking: HiveboxBookingRow) => {
          const normalized = normalizePhone(booking.phone_number);
          const phoneE164 = normalized?.e164;
          
          let status = 'eligible';
          let reason = null;
          
          if (!normalized) {
            status = 'skipped_invalid_phone';
            reason = 'Invalid phone number format';
          } else if (!isUKNumber(normalized.e164, booking.phone_number)) {
            status = 'skipped_non_uk';
            reason = 'Non-UK phone number';
          } else if (phoneE164 && optOutSet.has(phoneE164)) {
            status = 'skipped_opted_out';
            reason = 'Phone number is opted out';
          }
          
          return {
            ...booking,
            phone_e164: phoneE164 || null,
            status,
            reason,
            is_opted_out: phoneE164 ? optOutSet.has(phoneE164) : false,
          };
        });
        
        res.json(enriched);
      } finally {
        client.release();
      }
    } catch (error: any) {
      console.error('[API] Error fetching Hivebox preview:', error);
      res.status(500).json({ error: 'Internal server error', message: error.message });
    }
  });

  // Run job endpoint
  app.post('/api/hivebox/run', async (req: Request, res: Response) => {
    try {
      const dryRunParam = req.query.dry_run || req.body.dry_run;
      const dryRun: boolean = (dryRunParam === 'true' || dryRunParam === true) ? true : false;
      
      const client = await readPool.connect();
      try {
        const stats = await runHiveboxReminderJob(client, dryRun);
        res.json({
          success: true,
          dryRun,
          stats,
        });
      } finally {
        client.release();
      }
    } catch (error: any) {
      console.error('[API] Error running Hivebox job:', error);
      res.status(500).json({ 
        error: 'Internal server error', 
        message: error.message || String(error) 
      });
    }
  });

  // Get logs
  app.get('/api/hivebox/logs', async (req: Request, res: Response) => {
    try {
      const limit = parseInt(req.query.limit as string) || 100;
      const logs = getSMSLogs(FEATURE_NAME, limit);
      res.json(logs);
    } catch (error: any) {
      console.error('[API] Error fetching Hivebox logs:', error);
      res.status(500).json({ error: 'Internal server error', message: error.message });
    }
  });

  // Get stats
  app.get('/api/hivebox/stats', async (_req: Request, res: Response) => {
    try {
      const latestRun = getLatestJobRunSummary(FEATURE_NAME);
      const { getAllOptOuts } = await import('../sqlite');
      const optOuts = getAllOptOuts(10000);
      
      res.json({
        latestRun,
        totalOptOuts: optOuts.length,
      });
    } catch (error: any) {
      console.error('[API] Error fetching Hivebox stats:', error);
      res.status(500).json({ error: 'Internal server error', message: error.message });
    }
  });
}

