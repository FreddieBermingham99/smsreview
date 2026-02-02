import * as cron from 'node-cron';
import { DateTime } from 'luxon';
import { readPool } from '../db/postgres';
import { config } from '../config';
import { runHiveboxReminderJob } from './service';

/**
 * Setup scheduler for Hivebox reminders
 * Runs every hour at 2 minutes past (HH:02) Europe/London time
 */
export function setupHiveboxScheduler(): void {
  // Cron: "2 * * * *" = minute 2, every hour
  const cronSchedule = '2 * * * *';
  console.log(`[HIVEBOX SCHEDULER] Setting up hourly job at :02 past each hour (${config.timezone})`);
  console.log(`[HIVEBOX SCHEDULER] Cron schedule: ${cronSchedule}`);
  
  cron.schedule(cronSchedule, async () => {
    const now = DateTime.now().setZone(config.timezone);
    console.log(`[HIVEBOX SCHEDULER] Scheduled job triggered at ${now.toISO()}`);
    
    try {
      const client = await readPool.connect();
      try {
        await runHiveboxReminderJob(client, false);
      } finally {
        client.release();
      }
    } catch (error: any) {
      console.error('[HIVEBOX SCHEDULER] Error running scheduled job:', error);
    }
  }, {
    timezone: config.timezone,
  });

  // Calculate next run time for display
  const now = DateTime.now().setZone(config.timezone);
  let nextRun = now.set({ minute: 2, second: 0, millisecond: 0 });
  if (nextRun <= now) {
    nextRun = nextRun.plus({ hours: 1 });
  }
  console.log(`[HIVEBOX SCHEDULER] Next run scheduled for: ${nextRun.toISO()}`);
}

