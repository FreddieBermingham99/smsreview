import "dotenv/config";

import * as cron from 'node-cron';
import { DateTime } from 'luxon';
import { readPool } from './db/postgres';
import { runJob } from './job';
import { createWebhookApp } from './webhook';
import { config } from './config';
import { getOptOutDb, closeOptOutDb } from './sqlite';
import { getReviewLinksMap } from './review-links';
import { setupHiveboxScheduler } from './hiveboxReminders/scheduler';

async function main() {
  // Initialize SQLite database
  getOptOutDb();
  console.log('[MAIN] SQLite opt-out database initialized');

  // Load review links CSV
  try {
    const reviewLinksMap = getReviewLinksMap();
    console.log(`[MAIN] Loaded review links for ${reviewLinksMap.size} cities`);
  } catch (error: any) {
    console.warn('[MAIN] Warning: Could not load review links CSV:', error.message);
    console.warn('[MAIN] Review links CSV should be at: data/review-links.csv');
  }

  try {
    // Start webhook server
    const app = createWebhookApp();
    const server = app.listen(config.webhookPort, () => {
      console.log(`[SERVER] Webhook server listening on port ${config.webhookPort}`);
      console.log(`[SERVER] Health check: http://localhost:${config.webhookPort}/health`);
      console.log(`[SERVER] Dashboard: http://localhost:${config.webhookPort}/`);
    });

    // Run job immediately if requested
    if (config.runJob) {
      const client = await readPool.connect();
      try {
        await runJob(client);
      } finally {
        client.release();
      }
    }

    // Schedule daily job at 10:00 AM London time
    // Cron format: minute hour day month day-of-week
    // '0 10 * * *' = every day at 10:00 AM
    const cronSchedule = `${config.jobMinute} ${config.jobHour} * * *`;
    console.log(`[SCHEDULER] Setting up daily job to run at ${config.jobHour}:${String(config.jobMinute).padStart(2, '0')} ${config.timezone}`);
    console.log(`[SCHEDULER] Cron schedule: ${cronSchedule}`);
    
    cron.schedule(cronSchedule, async () => {
      const now = DateTime.now().setZone(config.timezone);
      console.log(`[SCHEDULER] Scheduled job triggered at ${now.toISO()}`);
      
      try {
        const client = await readPool.connect();
        try {
          await runJob(client);
        } finally {
          client.release();
        }
      } catch (error: any) {
        console.error('[SCHEDULER] Error running scheduled job:', error);
      }
    }, {
      timezone: config.timezone,
    });

    console.log('[SCHEDULER] Daily scheduler started. Job will run automatically at the scheduled time.');
    
    // Setup Hivebox reminder scheduler (runs every hour at :02)
    setupHiveboxScheduler();
    
    console.log('[SCHEDULER] Server will keep running to handle webhooks and scheduled jobs.');

    // Keep server running
  } catch (error: any) {
    console.error('[MAIN] Fatal error:', error);
    await readPool.end();
    closeOptOutDb();
    process.exit(1);
  }
}

// Handle graceful shutdown
process.on('SIGTERM', async () => {
  console.log('[MAIN] SIGTERM received, shutting down gracefully');
  await readPool.end();
  closeOptOutDb();
  process.exit(0);
});

process.on('SIGINT', async () => {
  console.log('[MAIN] SIGINT received, shutting down gracefully');
  await readPool.end();
  closeOptOutDb();
  process.exit(0);
});

main().catch((error) => {
  console.error('[MAIN] Unhandled error:', error);
  process.exit(1);
});

