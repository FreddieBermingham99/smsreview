import express, { Request, Response } from 'express';
import multer from 'multer';
import * as fs from 'fs';
import * as path from 'path';
import { normalizePhone } from './utils';
import { config, SCHEMA, SMS_TEMPLATE } from './config';
import { getAllOptOuts, addOptOut, removeOptOut, searchOptOuts, isOptedOut } from './sqlite';
import { getReviewLinksMap, hasReviewLinks, reloadReviewLinks, getRandomReviewUrl } from './review-links';
import { readPool } from './db/postgres';
import { sendSMS } from './textmagic';
import { runJob } from './job';

const STOP_KEYWORDS = ['STOP', 'STOPALL', 'UNSUBSCRIBE', 'CANCEL', 'END', 'QUIT'];
const OPT_IN_KEYWORDS = ['START', 'YES', 'UNSTOP'];

/**
 * Handle inbound SMS webhook from TextMagic
 * TextMagic sends: { text, from, messageId, timestamp }
 */
export async function handleInboundSMS(
  text: string,
  from: string,
  messageId?: string
): Promise<{ action: 'opted_out' | 'opted_in' | 'none' }> {
  const normalized = normalizePhone(from);
  if (!normalized) {
    console.log(`[WEBHOOK] Received SMS from invalid phone: ${from}`);
    return { action: 'none' };
  }

  const upperText = text.trim().toUpperCase();

  // Check for opt-out keywords
  if (STOP_KEYWORDS.some(keyword => upperText.includes(keyword))) {
    addOptOut(normalized.e164, 'inbound_sms_stop', text);
    console.log(`[WEBHOOK] Opted out phone: ${normalized.e164} (source: inbound_sms_stop)`);
    return { action: 'opted_out' };
  }

  // Check for opt-in keywords (optional - if you want to support re-subscription)
  if (OPT_IN_KEYWORDS.some(keyword => upperText.includes(keyword))) {
    const removed = removeOptOut(normalized.e164);
    if (removed) {
      console.log(`[WEBHOOK] Opted in phone: ${normalized.e164}`);
      return { action: 'opted_in' };
    }
  }

  return { action: 'none' };
}

/**
 * Handle delivery status callback from TextMagic
 * TextMagic sends: { messageId, status, deliveryTime }
 */
export async function handleDeliveryStatus(
  messageId: string,
  status: string
): Promise<void> {
  // Just log delivery status (no database logging in read-only setup)
  console.log(`[WEBHOOK] Delivery status for message ${messageId}: ${status}`);
}

/**
 * Create Express app for webhook endpoints
 */
export function createWebhookApp(): express.Application {
  const app = express();
  
  // Import and setup Hivebox routes
  const { createHiveboxRoutes } = require('./hiveboxReminders/routes');
  createHiveboxRoutes(app);

  // Middleware
  app.use(express.json());
  app.use(express.urlencoded({ extended: true }));

  // Configure multer for file uploads
  const uploadDir = path.join(process.cwd(), 'data', 'uploads');
  if (!fs.existsSync(uploadDir)) {
    fs.mkdirSync(uploadDir, { recursive: true });
  }

  const upload = multer({ 
    dest: uploadDir,
    fileFilter: (_req, file, cb) => {
      if (file.mimetype === 'text/csv' || file.originalname.endsWith('.csv')) {
        cb(null, true);
      } else {
        cb(new Error('Only CSV files are allowed'));
      }
    },
    limits: { fileSize: 5 * 1024 * 1024 } // 5MB limit
  });

  // Health check
  app.get('/health', (_req: Request, res: Response) => {
    res.json({ status: 'ok', service: 'stasher-review-sms' });
  });

  // Database test endpoint
  app.get('/api/db-test', async (_req: Request, res: Response) => {
    try {
      const r = await readPool.query('SELECT 1 as ok');
      res.json(r.rows[0]);
    } catch (e: any) {
      console.error('[DB TEST FAIL]', e);
      res.status(500).json({ error: String(e) });
    }
  });

  // Dashboard API endpoints
  app.get('/api/stats', async (_req: Request, res: Response) => {
    try {
      // Stats from SQLite opt-outs only (no SMS logging in read-only DB)
      const optOuts = getAllOptOuts(10000); // Get all for count
      const reviewLinksMap = getReviewLinksMap();
      
      res.json({
        optOuts: optOuts.length,
        reviewLinksCities: reviewLinksMap.size,
        reviewLinksTotal: Array.from(reviewLinksMap.values()).reduce((sum, links) => sum + links.length, 0),
      });
    } catch (error: any) {
      console.error('[API] Error fetching stats:', error);
      res.status(500).json({ error: 'Internal server error', message: error.message });
    }
  });

  app.get('/api/opt-outs', async (req: Request, res: Response) => {
    try {
      const limit = parseInt(req.query.limit as string) || 100;
      const search = req.query.search as string;
      
      let optOuts;
      if (search) {
        optOuts = searchOptOuts(search, limit);
      } else {
        optOuts = getAllOptOuts(limit);
      }
      
      res.json(optOuts);
    } catch (error: any) {
      console.error('[API] Error fetching opt-outs:', error);
      res.status(500).json({ error: 'Internal server error', message: error.message });
    }
  });

  app.post('/api/opt-outs', async (req: Request, res: Response) => {
    try {
      const { phone, source, note } = req.body;
      
      if (!phone) {
        return res.status(400).json({ error: 'Phone number is required' });
      }
      
      const normalized = normalizePhone(phone);
      if (!normalized) {
        return res.status(400).json({ error: 'Invalid phone number format' });
      }
      
      addOptOut(normalized.e164, source || 'manual', note);
      res.json({ success: true, phone_e164: normalized.e164 });
    } catch (error: any) {
      console.error('[API] Error adding opt-out:', error);
      res.status(500).json({ error: 'Internal server error', message: error.message });
    }
  });

  app.delete('/api/opt-outs/:phone', async (req: Request, res: Response) => {
    try {
      const phone = req.params.phone;
      const normalized = normalizePhone(phone);
      
      if (!normalized) {
        return res.status(400).json({ error: 'Invalid phone number format' });
      }
      
      const removed = removeOptOut(normalized.e164);
      if (removed) {
        res.json({ success: true });
      } else {
        res.status(404).json({ error: 'Opt-out not found' });
      }
    } catch (error: any) {
      console.error('[API] Error removing opt-out:', error);
      res.status(500).json({ error: 'Internal server error', message: error.message });
    }
  });

  app.post('/api/review-links/upload', upload.single('csv'), async (req: Request, res: Response) => {
    try {
      if (!req.file) {
        return res.status(400).json({ error: 'No file uploaded' });
      }

      const csvPath = path.join(process.cwd(), 'data', 'review-links.csv');
      const uploadPath = req.file.path;

      // Ensure data directory exists
      const dataDir = path.dirname(csvPath);
      if (!fs.existsSync(dataDir)) {
        fs.mkdirSync(dataDir, { recursive: true });
      }

      // Move uploaded file to review-links.csv
      fs.copyFileSync(uploadPath, csvPath);
      fs.unlinkSync(uploadPath); // Delete temp file

      // Reload review links
      const map = reloadReviewLinks();

      res.json({ 
        success: true, 
        message: 'CSV uploaded and loaded successfully',
        cities: map.size,
        totalLinks: Array.from(map.values()).reduce((sum, links) => sum + links.length, 0)
      });
    } catch (error: any) {
      console.error('[API] Error uploading CSV:', error);
      res.status(500).json({ error: 'Internal server error', message: error.message });
    }
  });

  app.post('/api/test-sms', async (req: Request, res: Response) => {
    try {
      const { booking_id, phone_number, stashpoint_name, city, first_name } = req.body;
      
      if (!phone_number || !stashpoint_name || !city) {
        return res.status(400).json({ error: 'Missing required fields' });
      }

      // Normalize phone
      const normalized = normalizePhone(phone_number);
      if (!normalized) {
        return res.status(400).json({ error: 'Invalid phone number format' });
      }

      // Check if UK number (+44 or starts with 07)
      const isUKNumber = normalized.e164.startsWith('+44') || 
                          (phone_number && phone_number.trim().startsWith('07'));
      if (!isUKNumber) {
        return res.status(400).json({ error: 'Only UK phone numbers are supported. Phone must start with +44 or 07' });
      }

      // Get random review URL for this city (fallback to London if city has no links)
      let reviewUrl = null;
      let usedLondonFallback = false;
      
      if (hasReviewLinks(city)) {
        reviewUrl = getRandomReviewUrl(city, false);
      }
      
      // Fallback to London if city has no links
      if (!reviewUrl) {
        reviewUrl = getRandomReviewUrl('london', false);
        if (reviewUrl) {
          usedLondonFallback = true;
        }
      }
      
      if (!reviewUrl) {
        return res.status(400).json({ error: `No review links available for city: ${city} and London fallback also unavailable` });
      }

      // Create message
      const message = SMS_TEMPLATE(first_name || null, reviewUrl);

      // Send SMS
      const result = await sendSMS(normalized.e164, message);

      res.json({
        success: true,
        messageId: result.messageId,
        phone: normalized.e164,
        message: message,
        usedLondonFallback: usedLondonFallback,
      });
    } catch (error: any) {
      console.error('[API] Error sending test SMS:', error);
      console.error('[API] Error details:', {
        phone: req.body.phone_number,
        normalized: normalizePhone(req.body.phone_number),
        stashpoint: req.body.stashpoint_name,
        city: req.body.city,
        messageLength: SMS_TEMPLATE(req.body.stashpoint_name || '', 'test-url').length,
      });
      
      // Return more detailed error for validation failures
      if (error.code === 400) {
        return res.status(400).json({ 
          error: 'Validation Failed', 
          message: error.message || 'TextMagic API validation failed. Check phone number format and message content.',
          details: (error as any).details || error
        });
      }
      
      res.status(500).json({ 
        error: 'Internal server error', 
        message: error.message || String(error) 
      });
    }
  });

  app.get('/api/yesterday-bookings', async (_req: Request, res: Response) => {
    try {
      const client = await readPool.connect();
      try {
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
          WHERE b.${SCHEMA.bookings.pickedUpAt} >= (CURRENT_DATE - INTERVAL '1 day')::date
            AND b.${SCHEMA.bookings.pickedUpAt} < CURRENT_DATE::date
            AND u.${SCHEMA.users.phoneNumber} IS NOT NULL
            AND u.${SCHEMA.users.phoneNumber} <> ''
          ORDER BY b.${SCHEMA.bookings.id}
          LIMIT 1000
        `;

        const result = await client.query(query);
        
        // Batch fetch all opt-outs once (much faster than checking one by one)
        const allOptOuts = getAllOptOuts(10000); // Get all opt-outs (increase limit if needed)
        const optOutSet = new Set(allOptOuts.map(o => o.phone_e164));
        
        // Cache review link availability checks
        const londonHasLinks = hasReviewLinks('london');
        const cityLinkCache = new Map<string, boolean>();
        
        // Enrich with opt-out status and review link availability
        const enriched = result.rows.map((row: any) => {
          const normalized = normalizePhone(row.phone_number);
          const phoneE164 = normalized?.e164;
          
          // Check city links with caching
          const city = row.city || '';
          let cityHasLinks = cityLinkCache.get(city);
          if (cityHasLinks === undefined) {
            cityHasLinks = hasReviewLinks(city);
            cityLinkCache.set(city, cityHasLinks);
          }
          
          const canSend = cityHasLinks || londonHasLinks;
          
          return {
            ...row,
            customer_phone: row.phone_number,
            picked_up_at: row.pickup,
            is_opted_out: phoneE164 ? optOutSet.has(phoneE164) : false,
            has_review_link: canSend,
            city_has_links: cityHasLinks,
            will_use_london_fallback: !cityHasLinks && londonHasLinks,
          };
        });
        
        res.json(enriched);
      } finally {
        client.release();
      }
    } catch (error: any) {
      console.error('[API] Error fetching yesterday bookings:', error);
      console.error('[API] Error details:', error.message, error.stack);
      res.status(500).json({ error: 'Internal server error', message: error.message });
    }
  });

  // Manual job trigger endpoint
  app.post('/api/run-job', async (req: Request, res: Response) => {
    try {
      const { date } = req.body;
      
      // Validate date format if provided (YYYY-MM-DD)
      if (date && !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
        return res.status(400).json({ error: 'Invalid date format. Use YYYY-MM-DD' });
      }

      // Validate date is not in the future
      if (date) {
        const targetDate = new Date(date);
        const today = new Date();
        today.setHours(23, 59, 59, 999); // End of today
        if (targetDate > today) {
          return res.status(400).json({ error: 'Cannot send messages for future dates' });
        }
      }

      const client = await readPool.connect();
      try {
        const pickupDateLabel = date 
          ? `the day before ${date}`
          : 'yesterday';
        console.log(`[API] Manual job trigger requested for date: ${date || 'yesterday'} (will find pickups from ${pickupDateLabel})`);
        const stats = await runJob(client, date);
        
        res.json({
          success: true,
          selectedDate: date || 'yesterday',
          pickupDate: pickupDateLabel,
          stats: stats,
        });
      } finally {
        client.release();
      }
    } catch (error: any) {
      console.error('[API] Error running manual job:', error);
      res.status(500).json({ 
        error: 'Internal server error', 
        message: error.message || String(error) 
      });
    }
  });

  // Hivebox dashboard page
  app.get('/hivebox', (_req: Request, res: Response) => {
    res.send(createHiveboxDashboardHTML());
  });

  // Dashboard HTML
  app.get('/', (_req: Request, res: Response) => {
    res.send(`
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Stasher Review SMS Dashboard</title>
  <style>
    * {
      margin: 0;
      padding: 0;
      box-sizing: border-box;
    }
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Oxygen, Ubuntu, Cantarell, sans-serif;
      background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
      min-height: 100vh;
      padding: 20px;
    }
    .container {
      max-width: 1200px;
      margin: 0 auto;
    }
    header {
      background: white;
      padding: 30px;
      border-radius: 10px;
      box-shadow: 0 4px 6px rgba(0,0,0,0.1);
      margin-bottom: 30px;
    }
    h1 {
      color: #333;
      margin-bottom: 10px;
    }
    .subtitle {
      color: #666;
      font-size: 14px;
    }
    .stats-grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
      gap: 20px;
      margin-bottom: 30px;
    }
    .stat-card {
      background: white;
      padding: 25px;
      border-radius: 10px;
      box-shadow: 0 4px 6px rgba(0,0,0,0.1);
      text-align: center;
    }
    .stat-value {
      font-size: 36px;
      font-weight: bold;
      color: #667eea;
      margin-bottom: 5px;
    }
    .stat-label {
      color: #666;
      font-size: 14px;
      text-transform: uppercase;
      letter-spacing: 1px;
    }
    .section {
      background: white;
      padding: 30px;
      border-radius: 10px;
      box-shadow: 0 4px 6px rgba(0,0,0,0.1);
      margin-bottom: 30px;
    }
    .section h2 {
      color: #333;
      margin-bottom: 20px;
      font-size: 24px;
    }
    table {
      width: 100%;
      border-collapse: collapse;
    }
    th {
      background: #f8f9fa;
      padding: 12px;
      text-align: left;
      font-weight: 600;
      color: #333;
      border-bottom: 2px solid #e9ecef;
    }
    td {
      padding: 12px;
      border-bottom: 1px solid #e9ecef;
      color: #555;
    }
    tr:hover {
      background: #f8f9fa;
    }
    .status-badge {
      display: inline-block;
      padding: 4px 12px;
      border-radius: 12px;
      font-size: 12px;
      font-weight: 600;
      text-transform: uppercase;
    }
    .status-sent {
      background: #d4edda;
      color: #155724;
    }
    .status-failed {
      background: #f8d7da;
      color: #721c24;
    }
    .loading {
      text-align: center;
      padding: 40px;
      color: #666;
    }
    .refresh-btn {
      background: #667eea;
      color: white;
      border: none;
      padding: 10px 20px;
      border-radius: 5px;
      cursor: pointer;
      font-size: 14px;
      margin-bottom: 20px;
    }
    .refresh-btn:hover {
      background: #5568d3;
    }
    .phone-number {
      font-family: monospace;
      font-size: 13px;
    }
    .error-text {
      color: #dc3545;
      font-size: 12px;
      font-style: italic;
    }
    .collapsible-header {
      cursor: pointer;
      user-select: none;
      display: flex;
      justify-content: space-between;
      align-items: center;
    }
    .collapsible-header:hover {
      opacity: 0.8;
    }
    .collapse-icon {
      transition: transform 0.2s;
      font-size: 18px;
    }
    .collapsed .collapse-icon {
      transform: rotate(-90deg);
    }
    .collapsible-content {
      overflow: hidden;
      transition: max-height 0.3s ease-out;
    }
    .collapsed .collapsible-content {
      max-height: 0;
    }
    .search-input {
      padding: 8px;
      width: 100%;
      max-width: 400px;
      border: 1px solid #ddd;
      border-radius: 4px;
      margin-bottom: 15px;
      font-size: 14px;
    }
    .send-btn {
      background: #667eea;
      color: white;
      border: none;
      padding: 4px 12px;
      border-radius: 4px;
      cursor: pointer;
      font-size: 12px;
    }
    .send-btn:hover {
      background: #5568d3;
    }
    .send-btn:disabled {
      background: #ccc;
      cursor: not-allowed;
    }
    .job-trigger-section {
      background: #fff3cd;
      border: 2px solid #ffc107;
      padding: 20px;
      border-radius: 8px;
      margin-bottom: 20px;
    }
    .job-trigger-section h2 {
      color: #856404;
      margin-bottom: 15px;
    }
    .date-input-group {
      display: flex;
      gap: 10px;
      align-items: center;
      margin-bottom: 15px;
    }
    .date-input {
      padding: 8px 12px;
      border: 1px solid #ddd;
      border-radius: 4px;
      font-size: 14px;
    }
    .send-all-btn {
      background: #ffc107;
      color: #000;
      border: none;
      padding: 10px 24px;
      border-radius: 5px;
      cursor: pointer;
      font-size: 14px;
      font-weight: 600;
    }
    .send-all-btn:hover {
      background: #e0a800;
    }
    .send-all-btn:disabled {
      background: #ccc;
      cursor: not-allowed;
      color: #666;
    }
    .job-status {
      margin-top: 15px;
      padding: 12px;
      border-radius: 4px;
      display: none;
    }
    .job-status.success {
      background: #d4edda;
      color: #155724;
      border: 1px solid #c3e6cb;
    }
    .job-status.error {
      background: #f8d7da;
      color: #721c24;
      border: 1px solid #f5c6cb;
    }
    .job-status.info {
      background: #d1ecf1;
      color: #0c5460;
      border: 1px solid #bee5eb;
    }
    .job-stats {
      margin-top: 10px;
      font-size: 13px;
      line-height: 1.8;
    }
  </style>
</head>
<body>
  <div class="container">
    <header>
      <h1>📱 Stasher Review SMS Dashboard</h1>
      <p class="subtitle">Monitor SMS review requests and opt-outs</p>
    </header>

    <div class="stats-grid" id="stats">
      <div class="stat-card">
        <div class="stat-value" id="stat-optouts">-</div>
        <div class="stat-label">Opt-Outs</div>
      </div>
      <div class="stat-card">
        <div class="stat-value" id="stat-cities">-</div>
        <div class="stat-label">Cities with Links</div>
      </div>
      <div class="stat-card">
        <div class="stat-value" id="stat-links">-</div>
        <div class="stat-label">Total Review Links</div>
      </div>
    </div>

    <div class="section job-trigger-section">
      <h2>🚀 Manual Job Trigger</h2>
      <p style="color: #856404; margin-bottom: 15px; font-size: 14px;">
        Use this to manually send daily SMS messages. Useful if the scheduled job didn't run (e.g., server was down at 10am).<br>
        <strong>Note:</strong> Select the date you want to send messages for. The system will find customers who picked up their bags the day before that date. (e.g., selecting today finds customers who picked up yesterday)
      </p>
      <div class="date-input-group">
        <label for="job-date" style="font-weight: 600; color: #333;">Select Date:</label>
        <input type="date" id="job-date" class="date-input" max="">
        <button class="send-all-btn" onclick="triggerManualJob()" id="trigger-job-btn">
          Send All Messages
        </button>
      </div>
      <div id="job-status" class="job-status"></div>
    </div>

    <div class="section" id="yesterday-section">
      <div class="collapsible-header" onclick="toggleYesterdayBookings()">
        <h2 style="margin: 0;">Yesterday's Bookings</h2>
        <span class="collapse-icon" id="yesterday-collapse-icon">▼</span>
      </div>
      <div class="collapsible-content" id="yesterday-content">
        <div style="margin-top: 20px;">
          <button class="refresh-btn" onclick="loadData()">🔄 Refresh</button>
          <input type="text" id="yesterday-search" class="search-input" placeholder="Search by name, phone, city, or stashpoint..." onkeyup="filterYesterdayBookings()">
        </div>
        <div id="yesterday-container">
          <div class="loading">Loading...</div>
        </div>
      </div>
    </div>

    <div class="section">
      <h2>Review Links CSV</h2>
      <div style="margin-bottom: 20px;">
        <form id="csv-upload-form" enctype="multipart/form-data">
          <input type="file" id="csv-file" accept=".csv" style="padding: 8px; margin-right: 10px; border: 1px solid #ddd; border-radius: 4px;" required>
          <button type="submit" class="refresh-btn" style="background: #28a745;">Upload CSV</button>
        </form>
        <div id="csv-upload-status" style="margin-top: 10px;"></div>
      </div>
      <p style="color: #666; font-size: 14px;">
        Upload a CSV file with columns: <code>city</code>, <code>stashpoint_name</code> (optional), <code>google_review_url</code>
      </p>
    </div>

    <div class="section">
      <h2>Opt-Out Management</h2>
      <div style="margin-bottom: 20px;">
        <input type="text" id="optout-search" placeholder="Search by phone or note..." style="padding: 8px; width: 300px; margin-right: 10px; border: 1px solid #ddd; border-radius: 4px;" onkeyup="handleOptOutSearch(event)">
        <button class="refresh-btn" onclick="showAddOptOutForm()">+ Add Opt-Out</button>
      </div>
      <div id="add-optout-form" style="display: none; background: #f8f9fa; padding: 15px; border-radius: 5px; margin-bottom: 15px;">
        <input type="text" id="optout-phone" placeholder="Phone number (e.g., +44123456789)" style="padding: 8px; width: 250px; margin-right: 10px; border: 1px solid #ddd; border-radius: 4px;">
        <input type="text" id="optout-note" placeholder="Note (optional)" style="padding: 8px; width: 200px; margin-right: 10px; border: 1px solid #ddd; border-radius: 4px;">
        <button class="refresh-btn" onclick="addOptOut()" style="background: #28a745;">Add</button>
        <button class="refresh-btn" onclick="hideAddOptOutForm()" style="background: #6c757d;">Cancel</button>
      </div>
      <div id="optouts-container">
        <div class="loading">Loading...</div>
      </div>
    </div>
  </div>

  <script>
    async function loadStats() {
      try {
        const res = await fetch('/api/stats');
        if (!res.ok) {
          const error = await res.json().catch(() => ({ error: 'Unknown error' }));
          throw new Error(error.message || error.error || 'Failed to load stats');
        }
        const data = await res.json();
        if (data.error) {
          throw new Error(data.message || data.error);
        }
        document.getElementById('stat-optouts').textContent = data.optOuts || 0;
        document.getElementById('stat-cities').textContent = data.reviewLinksCities || 0;
        document.getElementById('stat-links').textContent = data.reviewLinksTotal || 0;
      } catch (error) {
        console.error('Error loading stats:', error);
        document.getElementById('stat-optouts').textContent = '?';
        document.getElementById('stat-cities').textContent = '?';
        document.getElementById('stat-links').textContent = '?';
      }
    }

    let allBookings = [];

    function renderBookingsTable(bookings) {
      const container = document.getElementById('yesterday-container');
      
      if (bookings.length === 0) {
        container.innerHTML = '<p style="color: #666; padding: 20px;">No bookings found.</p>';
        return;
      }

      container.innerHTML = \`
        <table id="yesterday-table">
          <thead>
            <tr>
              <th>Booking ID</th>
              <th>Name</th>
              <th>Phone</th>
              <th>Stashpoint</th>
              <th>City</th>
              <th>Picked Up At</th>
              <th>Status</th>
              <th>Actions</th>
            </tr>
          </thead>
          <tbody>
            \${bookings.map(booking => \`
              <tr data-booking-id="\${booking.booking_id}">
                <td>\${booking.booking_id}</td>
                <td>\${(booking.first_name || '') + ' ' + (booking.last_name || '') || '-'}</td>
                <td class="phone-number">\${booking.customer_phone || '-'}</td>
                <td>\${booking.stashpoint_name || '-'}</td>
                <td>\${booking.city || '-'}</td>
                <td>\${booking.pickup ? new Date(booking.pickup).toLocaleString() : '-'}</td>
                <td>
                  \${booking.is_opted_out ? 
                    '<span class="status-badge status-failed">Opted Out</span>' :
                    booking.has_review_link ?
                    (booking.will_use_london_fallback ?
                      '<span class="status-badge status-sent">Eligible (London)</span>' :
                      '<span class="status-badge status-sent">Eligible</span>') :
                    '<span class="status-badge status-failed">No Review Link</span>'
                  }
                </td>
                <td>
                  \${!booking.is_opted_out && booking.has_review_link && booking.customer_phone ?
                    \`<button class="send-btn" data-booking-id="\${booking.booking_id}" data-phone="\${String(booking.customer_phone || '').replace(/"/g, '&quot;')}" data-stashpoint="\${String(booking.stashpoint_name || '').replace(/"/g, '&quot;')}" data-city="\${String(booking.city || '').replace(/"/g, '&quot;')}" data-first-name="\${String(booking.first_name || '').replace(/"/g, '&quot;')}" id="send-btn-\${booking.booking_id}">Send Text</button>\` :
                    '-'
                  }
                </td>
              </tr>
            \`).join('')}
          </tbody>
        </table>
      \`;
    }

    function filterYesterdayBookings() {
      const searchTerm = document.getElementById('yesterday-search').value.toLowerCase().trim();
      
      if (!searchTerm) {
        renderBookingsTable(allBookings);
        return;
      }

      const filtered = allBookings.filter(booking => {
        const name = ((booking.first_name || '') + ' ' + (booking.last_name || '')).toLowerCase();
        const phone = (booking.customer_phone || '').toLowerCase();
        const stashpoint = (booking.stashpoint_name || '').toLowerCase();
        const city = (booking.city || '').toLowerCase();
        const bookingId = String(booking.booking_id);
        
        return name.includes(searchTerm) || 
               phone.includes(searchTerm) || 
               stashpoint.includes(searchTerm) || 
               city.includes(searchTerm) ||
               bookingId.includes(searchTerm);
      });

      renderBookingsTable(filtered);
    }

    function toggleYesterdayBookings() {
      const section = document.getElementById('yesterday-section');
      const content = document.getElementById('yesterday-content');
      const icon = document.getElementById('yesterday-collapse-icon');
      
      if (!section || !content || !icon) {
        console.error('Could not find yesterday bookings elements');
        return;
      }
      
      if (section.classList.contains('collapsed')) {
        section.classList.remove('collapsed');
        content.style.maxHeight = '2000px';
        icon.textContent = '▼';
      } else {
        section.classList.add('collapsed');
        content.style.maxHeight = '0';
        icon.textContent = '▶';
      }
    }

    function sendTestSMS(bookingId, phoneNumber, stashpointName, city, firstName) {
      const btn = document.getElementById(\`send-btn-\${bookingId}\`);
      if (!btn) {
        console.error('Button not found for booking:', bookingId);
        return;
      }
      
      const originalText = btn.textContent;
      btn.disabled = true;
      btn.textContent = 'Sending...';

      fetch('/api/test-sms', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          booking_id: bookingId,
          phone_number: phoneNumber,
          stashpoint_name: stashpointName,
          city: city,
          first_name: firstName || null,
        }),
      })
      .then(async (res) => {
        const data = await res.json();

        if (!res.ok) {
          // Format error message properly
          let errorMsg = data.message || data.error || 'Failed to send SMS';
          if (data.details) {
            if (typeof data.details === 'string') {
              errorMsg += ' - ' + data.details;
            } else if (data.details.errors || data.details.validation_errors) {
              const errors = data.details.errors || data.details.validation_errors;
              const errorParts = Object.entries(errors).map(([field, msgs]) => {
                const msgList = Array.isArray(msgs) ? msgs.join(', ') : String(msgs);
                return field + ': ' + msgList;
              });
              errorMsg += ' - ' + errorParts.join('; ');
            } else if (data.details.message) {
              errorMsg += ' - ' + data.details.message;
            }
          }
          throw new Error(errorMsg);
        }

        btn.textContent = 'Sent ✓';
        btn.style.background = '#28a745';
        setTimeout(() => {
          btn.textContent = originalText;
          btn.style.background = '';
          btn.disabled = false;
        }, 3000);
      })
      .catch((error) => {
        btn.textContent = 'Error';
        btn.style.background = '#dc3545';
        const errorMsg = error.message || String(error);
        alert('Error sending SMS: ' + errorMsg);
        setTimeout(() => {
          btn.textContent = originalText;
          btn.style.background = '';
          btn.disabled = false;
        }, 3000);
      });
    }
    
    // Event delegation for send buttons (works with dynamically generated buttons)
    document.addEventListener('click', function(e) {
      const btn = e.target.closest('.send-btn');
      if (btn && btn.dataset.bookingId) {
        e.preventDefault();
        sendTestSMS(
          btn.dataset.bookingId,
          btn.dataset.phone,
          btn.dataset.stashpoint,
          btn.dataset.city,
          btn.dataset.firstName
        );
      }
    });

    async function loadYesterdayBookings() {
      try {
        const res = await fetch('/api/yesterday-bookings');
        if (!res.ok) {
          const error = await res.json().catch(() => ({ error: 'Unknown error' }));
          throw new Error(error.message || error.error || 'Failed to load yesterday bookings');
        }
        const bookings = await res.json();
        
        if (!Array.isArray(bookings)) {
          throw new Error('Invalid response format');
        }
        
        allBookings = bookings;
        renderBookingsTable(bookings);
      } catch (error) {
        console.error('Error loading yesterday bookings:', error);
        document.getElementById('yesterday-container').innerHTML = 
          \`<p style="color: #dc3545; padding: 20px;">Error loading yesterday bookings: \${error.message || 'Unknown error'}. Check server console for details.</p>\`;
      }
    }

    async function loadOptOuts(searchTerm) {
      try {
        const url = searchTerm ? \`/api/opt-outs?search=\${encodeURIComponent(searchTerm)}\` : '/api/opt-outs?limit=100';
        const res = await fetch(url);
        if (!res.ok) {
          const error = await res.json().catch(() => ({ error: 'Unknown error' }));
          throw new Error(error.message || error.error || 'Failed to load opt-outs');
        }
        const optOuts = await res.json();
        const container = document.getElementById('optouts-container');
        
        if (!Array.isArray(optOuts)) {
          throw new Error('Invalid response format');
        }
        
        if (optOuts.length === 0) {
          container.innerHTML = '<p style="color: #666; padding: 20px;">No opt-outs found.</p>';
          return;
        }

        container.innerHTML = \`
          <table>
            <thead>
              <tr>
                <th>Phone</th>
                <th>Created At</th>
                <th>Source</th>
                <th>Note</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              \${optOuts.map(opt => \`
                <tr>
                  <td class="phone-number">\${opt.phone_e164}</td>
                  <td>\${new Date(opt.created_at).toLocaleString()}</td>
                  <td>\${opt.source}</td>
                  <td>\${opt.note || '-'}</td>
                  <td>
                    <button onclick="removeOptOut('\${opt.phone_e164}')" style="background: #dc3545; color: white; border: none; padding: 4px 12px; border-radius: 4px; cursor: pointer; font-size: 12px;">Remove</button>
                  </td>
                </tr>
              \`).join('')}
            </tbody>
          </table>
        \`;
      } catch (error) {
        console.error('Error loading opt-outs:', error);
        document.getElementById('optouts-container').innerHTML = 
          \`<p style="color: #dc3545; padding: 20px;">Error loading opt-outs: \${error.message || 'Unknown error'}. Check server console for details.</p>\`;
      }
    }

    function handleOptOutSearch(event) {
      if (event.key === 'Enter' || event.keyCode === 13) {
        const searchTerm = event.target.value.trim();
        loadOptOuts(searchTerm || null);
      }
    }

    function showAddOptOutForm() {
      document.getElementById('add-optout-form').style.display = 'block';
    }

    function hideAddOptOutForm() {
      document.getElementById('add-optout-form').style.display = 'none';
      document.getElementById('optout-phone').value = '';
      document.getElementById('optout-note').value = '';
    }

    async function addOptOut() {
      const phone = document.getElementById('optout-phone').value.trim();
      const note = document.getElementById('optout-note').value.trim();
      
      if (!phone) {
        alert('Please enter a phone number');
        return;
      }

      try {
        const res = await fetch('/api/opt-outs', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ phone, source: 'manual', note }),
        });

        if (!res.ok) {
          const error = await res.json();
          throw new Error(error.message || error.error || 'Failed to add opt-out');
        }

        hideAddOptOutForm();
        loadOptOuts(null);
        alert('Opt-out added successfully');
      } catch (error) {
        alert('Error adding opt-out: ' + error.message);
      }
    }

    async function removeOptOut(phone) {
      if (!confirm('Remove opt-out for ' + phone + '?')) {
        return;
      }

      try {
        const res = await fetch(\`/api/opt-outs/\${encodeURIComponent(phone)}\`, {
          method: 'DELETE',
        });

        if (!res.ok) {
          const error = await res.json();
          throw new Error(error.message || error.error || 'Failed to remove opt-out');
        }

        loadOptOuts(null);
        alert('Opt-out removed successfully');
      } catch (error) {
        alert('Error removing opt-out: ' + error.message);
      }
    }

    document.getElementById('csv-upload-form').addEventListener('submit', async (e) => {
      e.preventDefault();
      const fileInput = document.getElementById('csv-file');
      const statusDiv = document.getElementById('csv-upload-status');
      
      if (!fileInput.files || fileInput.files.length === 0) {
        statusDiv.innerHTML = '<p style="color: #dc3545;">Please select a CSV file</p>';
        return;
      }

      const formData = new FormData();
      formData.append('csv', fileInput.files[0]);

      statusDiv.innerHTML = '<p style="color: #666;">Uploading...</p>';

      try {
        const res = await fetch('/api/review-links/upload', {
          method: 'POST',
          body: formData,
        });

        const data = await res.json();

        if (!res.ok) {
          throw new Error(data.message || data.error || 'Upload failed');
        }

        statusDiv.innerHTML = \`<p style="color: #28a745;">✓ \${data.message || 'Upload successful'} - \${data.cities} cities, \${data.totalLinks} links loaded</p>\`;
        fileInput.value = '';
        
        // Reload stats to show updated counts
        loadStats();
      } catch (error) {
        statusDiv.innerHTML = \`<p style="color: #dc3545;">Error: \${error.message || 'Upload failed'}</p>\`;
      }
    });

    async function loadData() {
      await Promise.all([loadStats(), loadYesterdayBookings(), loadOptOuts(null)]);
    }

    // Set max date to today for date input
    document.addEventListener('DOMContentLoaded', function() {
      const dateInput = document.getElementById('job-date');
      if (dateInput) {
        const today = new Date().toISOString().split('T')[0];
        dateInput.setAttribute('max', today);
      }
    });

    async function triggerManualJob() {
      const dateInput = document.getElementById('job-date');
      const triggerBtn = document.getElementById('trigger-job-btn');
      const statusDiv = document.getElementById('job-status');
      
      if (!dateInput || !triggerBtn || !statusDiv) {
        console.error('Could not find job trigger elements');
        return;
      }

      const selectedDate = dateInput.value;
      
      if (!selectedDate) {
        statusDiv.className = 'job-status error';
        statusDiv.style.display = 'block';
        statusDiv.innerHTML = '<strong>Error:</strong> Please select a date.';
        return;
      }

      // Disable button and show loading
      triggerBtn.disabled = true;
      triggerBtn.textContent = 'Sending...';
      statusDiv.className = 'job-status info';
      statusDiv.style.display = 'block';
      statusDiv.innerHTML = '<strong>Running job...</strong> This may take a few minutes.';

      try {
        const response = await fetch('/api/run-job', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ date: selectedDate }),
        });

        const data = await response.json();

        if (!response.ok) {
          throw new Error(data.message || data.error || 'Failed to run job');
        }

        // Show success with stats
        statusDiv.className = 'job-status success';
        statusDiv.innerHTML = '<strong>✓ Job completed successfully!</strong>' +
          '<div class="job-stats">' +
          '<div><strong>Selected Date:</strong> ' + (data.selectedDate || data.date) + '</div>' +
          '<div><strong>Pickup Date:</strong> ' + (data.pickupDate || 'yesterday') + '</div>' +
          '<div><strong>Found:</strong> ' + data.stats.found + ' bookings</div>' +
          '<div><strong>Eligible:</strong> ' + data.stats.eligible + ' bookings</div>' +
          '<div><strong>Sent:</strong> ' + data.stats.sent + ' messages</div>' +
          '<div><strong>Failed:</strong> ' + data.stats.failed + ' messages</div>' +
          '<div style="margin-top: 8px; font-size: 12px; color: #666;">' +
          'Skipped: ' + data.stats.skippedNoPhone + ' no phone, ' +
          data.stats.skippedInvalidPhone + ' invalid phone, ' +
          data.stats.skippedNonUK + ' non-UK, ' +
          data.stats.skippedOptedOut + ' opted out, ' +
          data.stats.skippedNoReviewLink + ' no review link' +
          '</div>' +
          '</div>';
      } catch (error) {
        statusDiv.className = 'job-status error';
        statusDiv.innerHTML = '<strong>Error:</strong> ' + (error.message || 'Failed to run job');
      } finally {
        triggerBtn.disabled = false;
        triggerBtn.textContent = 'Send All Messages';
      }
    }

    // Load data on page load
    loadData();

    // Auto-refresh every 30 seconds
    setInterval(loadData, 30000);

    // Hivebox reminder functions
    async function loadHiveboxData() {
      await Promise.all([loadHiveboxStats(), loadHiveboxLogs()]);
    }

    async function loadHiveboxStats() {
      try {
        const res = await fetch('/api/hivebox/stats');
        if (!res.ok) throw new Error('Failed to load stats');
        const data = await res.json();
        
        // Calculate next run time (HH:02)
        const now = new Date();
        const nextRun = new Date(now);
        nextRun.setMinutes(2, 0, 0);
        if (nextRun <= now) {
          nextRun.setHours(nextRun.getHours() + 1);
        }
        document.getElementById('hivebox-next-run').textContent = nextRun.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', timeZone: 'Europe/London' });
        
        if (data.latestRun) {
          const status = data.latestRun.error ? 'Failed' : 'Success';
          document.getElementById('hivebox-last-status').textContent = status;
          document.getElementById('hivebox-last-status').style.color = data.latestRun.error ? '#dc3545' : '#28a745';
          
          const count = data.latestRun.sent_count || 0;
          document.getElementById('hivebox-last-count').textContent = count;
        } else {
          document.getElementById('hivebox-last-status').textContent = 'Never run';
          document.getElementById('hivebox-last-count').textContent = '0';
        }
      } catch (error) {
        console.error('Error loading Hivebox stats:', error);
      }
    }

    async function loadHiveboxLogs() {
      try {
        const res = await fetch('/api/hivebox/logs?limit=50');
        if (!res.ok) throw new Error('Failed to load logs');
        const logs = await res.json();
        
        if (!Array.isArray(logs)) {
          throw new Error('Invalid response format');
        }
        
        const container = document.getElementById('hivebox-logs-container');
        
        if (logs.length === 0) {
          container.innerHTML = '<p style="color: #666; padding: 20px;">No logs yet.</p>';
          return;
        }
        
        container.innerHTML = \`
          <table>
            <thead>
              <tr>
                <th>Time</th>
                <th>Booking ID</th>
                <th>Phone</th>
                <th>Pickup Time</th>
                <th>Status</th>
                <th>Error</th>
              </tr>
            </thead>
            <tbody>
              \${logs.map(log => \`
                <tr>
                  <td>\${new Date(log.created_at).toLocaleString()}</td>
                  <td>\${log.booking_id || '-'}</td>
                  <td class="phone-number">\${log.phone}</td>
                  <td>\${log.pickup_time ? new Date(log.pickup_time).toLocaleString() : '-'}</td>
                  <td>
                    \${log.status === 'sent' ? 
                      '<span class="status-badge status-sent">Sent</span>' :
                      log.status === 'skipped_opted_out' ?
                      '<span class="status-badge status-failed">Opted Out</span>' :
                      log.status === 'skipped_invalid_phone' ?
                      '<span class="status-badge status-failed">Invalid Phone</span>' :
                      log.status === 'skipped_non_uk' ?
                      '<span class="status-badge status-failed">Non-UK</span>' :
                      '<span class="status-badge status-failed">Failed</span>'
                    }
                  </td>
                  <td>\${log.error || '-'}</td>
                </tr>
              \`).join('')}
            </tbody>
          </table>
        \`;
      } catch (error) {
        console.error('Error loading Hivebox logs:', error);
        document.getElementById('hivebox-logs-container').innerHTML = 
          \`<p style="color: #dc3545; padding: 20px;">Error loading logs: \${error.message || 'Unknown error'}</p>\`;
      }
    }

    async function runHiveboxJob(dryRun) {
      const statusEl = document.getElementById('hivebox-status');
      const originalHTML = statusEl.innerHTML;
      
      statusEl.innerHTML = '<p style="color: #666;">Running job...</p>';
      
      try {
        const res = await fetch('/api/hivebox/run?dry_run=' + (dryRun ? 'true' : 'false'), {
          method: 'POST',
        });
        
        const data = await res.json();
        
        if (!res.ok) {
          throw new Error(data.message || data.error || 'Job failed');
        }
        
        alert(\`Job completed! \${dryRun ? '(Dry Run)' : ''}\nFetched: \${data.stats.fetched}\nSent: \${data.stats.sent}\nSkipped: \${data.stats.skippedOptedOut + data.stats.skippedInvalidPhone + data.stats.skippedNonUK}\nFailed: \${data.stats.failed}\`);
        
        // Reload data
        loadHiveboxData();
      } catch (error) {
        alert('Error running job: ' + error.message);
        statusEl.innerHTML = originalHTML;
      }
    }

    // Load Hivebox data on page load
    loadHiveboxData();
  </script>
</body>
</html>
    `);
  });

  // Inbound SMS webhook
  app.post('/webhook/inbound', async (req: Request, res: Response) => {
    try {
      const { text, from, messageId } = req.body;

      if (!text || !from) {
        return res.status(400).json({ error: 'Missing text or from field' });
      }

      const result = await handleInboundSMS(text, from, messageId);
      res.json({ success: true, action: result.action });
    } catch (error: any) {
      console.error('[WEBHOOK] Error handling inbound SMS:', error);
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // Delivery status webhook
  app.post('/webhook/delivery', async (req: Request, res: Response) => {
    try {
      const { messageId, status } = req.body;

      if (!messageId || !status) {
        return res.status(400).json({ error: 'Missing messageId or status field' });
      }

      await handleDeliveryStatus(messageId, status);
      res.json({ success: true });
    } catch (error: any) {
      console.error('[WEBHOOK] Error handling delivery status:', error);
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  return app;
}

/**
 * Create HTML for Hivebox dashboard page
 */
function createHiveboxDashboardHTML(): string {
  return `
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Hivebox Reminders - Stasher SMS Dashboard</title>
  <style>
    * {
      margin: 0;
      padding: 0;
      box-sizing: border-box;
    }
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Oxygen, Ubuntu, Cantarell, sans-serif;
      background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
      min-height: 100vh;
      padding: 20px;
    }
    .container {
      max-width: 1200px;
      margin: 0 auto;
    }
    header {
      background: white;
      padding: 30px;
      border-radius: 10px;
      box-shadow: 0 4px 6px rgba(0,0,0,0.1);
      margin-bottom: 30px;
    }
    h1 {
      color: #333;
      margin-bottom: 10px;
    }
    .subtitle {
      color: #666;
      font-size: 14px;
    }
    .section {
      background: white;
      padding: 30px;
      border-radius: 10px;
      box-shadow: 0 4px 6px rgba(0,0,0,0.1);
      margin-bottom: 30px;
    }
    .section h2 {
      color: #333;
      margin-bottom: 20px;
      font-size: 24px;
    }
    table {
      width: 100%;
      border-collapse: collapse;
    }
    th {
      background: #f8f9fa;
      padding: 12px;
      text-align: left;
      font-weight: 600;
      color: #333;
      border-bottom: 2px solid #e9ecef;
    }
    td {
      padding: 12px;
      border-bottom: 1px solid #e9ecef;
    }
    .status-badge {
      display: inline-block;
      padding: 4px 8px;
      border-radius: 4px;
      font-size: 12px;
      font-weight: 600;
    }
    .status-sent {
      background: #d4edda;
      color: #155724;
    }
    .status-failed {
      background: #f8d7da;
      color: #721c24;
    }
    .refresh-btn {
      background: #667eea;
      color: white;
      border: none;
      padding: 10px 20px;
      border-radius: 5px;
      cursor: pointer;
      font-size: 14px;
      font-weight: 600;
    }
    .refresh-btn:hover {
      background: #5568d3;
    }
    .phone-number {
      font-family: monospace;
      font-size: 13px;
    }
    .loading {
      text-align: center;
      padding: 40px;
      color: #666;
    }
  </style>
</head>
<body>
  <div class="container">
    <header>
      <h1>📦 Hivebox Locker Reminders</h1>
      <p class="subtitle">Sends hourly reminders to customers whose locker booking ended in the previous hour</p>
      <p style="margin-top: 10px;"><a href="/" style="color: #667eea; text-decoration: none;">← Back to Main Dashboard</a></p>
    </header>

    <div class="section">
      <h2>Job Control</h2>
      <div style="display: flex; gap: 10px; margin-bottom: 20px;">
        <button class="refresh-btn" onclick="runHiveboxJob(true)" style="background: #ffc107; color: #000;">Run Now (Dry Run)</button>
        <button class="refresh-btn" onclick="runHiveboxJob(false)" style="background: #28a745;">Run Now (Send)</button>
        <button class="refresh-btn" onclick="loadHiveboxData()">🔄 Refresh</button>
      </div>
      <div id="hivebox-status" style="margin-bottom: 15px;">
        <div style="display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: 15px;">
          <div style="background: #f8f9fa; padding: 15px; border-radius: 5px;">
            <div style="font-size: 24px; font-weight: bold; color: #667eea;" id="hivebox-next-run">-</div>
            <div style="font-size: 12px; color: #666;">Next Run Time</div>
          </div>
          <div style="background: #f8f9fa; padding: 15px; border-radius: 5px;">
            <div style="font-size: 24px; font-weight: bold; color: #28a745;" id="hivebox-last-status">-</div>
            <div style="font-size: 12px; color: #666;">Last Run Status</div>
          </div>
          <div style="background: #f8f9fa; padding: 15px; border-radius: 5px;">
            <div style="font-size: 24px; font-weight: bold; color: #667eea;" id="hivebox-last-count">-</div>
            <div style="font-size: 12px; color: #666;">Last Run Count</div>
          </div>
        </div>
      </div>
    </div>

    <div class="section">
      <h2>Recent Logs</h2>
      <div id="hivebox-logs-container">
        <div class="loading">Loading...</div>
      </div>
    </div>
  </div>

  <script>
    async function loadHiveboxData() {
      await Promise.all([loadHiveboxStats(), loadHiveboxLogs()]);
    }

    async function loadHiveboxStats() {
      try {
        const res = await fetch('/api/hivebox/stats');
        if (!res.ok) throw new Error('Failed to load stats');
        const data = await res.json();
        
        // Calculate next run time (HH:02)
        const now = new Date();
        const nextRun = new Date(now);
        nextRun.setMinutes(2, 0, 0);
        if (nextRun <= now) {
          nextRun.setHours(nextRun.getHours() + 1);
        }
        document.getElementById('hivebox-next-run').textContent = nextRun.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', timeZone: 'Europe/London' });
        
        if (data.latestRun) {
          const status = data.latestRun.error ? 'Failed' : 'Success';
          document.getElementById('hivebox-last-status').textContent = status;
          document.getElementById('hivebox-last-status').style.color = data.latestRun.error ? '#dc3545' : '#28a745';
          
          const count = data.latestRun.sent_count || 0;
          document.getElementById('hivebox-last-count').textContent = count;
        } else {
          document.getElementById('hivebox-last-status').textContent = 'Never run';
          document.getElementById('hivebox-last-count').textContent = '0';
        }
      } catch (error) {
        console.error('Error loading Hivebox stats:', error);
      }
    }

    async function loadHiveboxLogs() {
      try {
        const res = await fetch('/api/hivebox/logs?limit=50');
        if (!res.ok) throw new Error('Failed to load logs');
        const logs = await res.json();
        
        if (!Array.isArray(logs)) {
          throw new Error('Invalid response format');
        }
        
        const container = document.getElementById('hivebox-logs-container');
        
        if (logs.length === 0) {
          container.innerHTML = '<p style="color: #666; padding: 20px;">No logs yet.</p>';
          return;
        }
        
        container.innerHTML = \`
          <table>
            <thead>
              <tr>
                <th>Time</th>
                <th>Booking ID</th>
                <th>Phone</th>
                <th>Pickup Time</th>
                <th>Status</th>
                <th>Error</th>
              </tr>
            </thead>
            <tbody>
              \${logs.map(log => \`
                <tr>
                  <td>\${new Date(log.created_at).toLocaleString()}</td>
                  <td>\${log.booking_id || '-'}</td>
                  <td class="phone-number">\${log.phone}</td>
                  <td>\${log.pickup_time ? new Date(log.pickup_time).toLocaleString() : '-'}</td>
                  <td>
                    \${log.status === 'sent' ? 
                      '<span class="status-badge status-sent">Sent</span>' :
                      log.status === 'skipped_opted_out' ?
                      '<span class="status-badge status-failed">Opted Out</span>' :
                      log.status === 'skipped_invalid_phone' ?
                      '<span class="status-badge status-failed">Invalid Phone</span>' :
                      log.status === 'skipped_non_uk' ?
                      '<span class="status-badge status-failed">Non-UK</span>' :
                      '<span class="status-badge status-failed">Failed</span>'
                    }
                  </td>
                  <td>\${log.error || '-'}</td>
                </tr>
              \`).join('')}
            </tbody>
          </table>
        \`;
      } catch (error) {
        console.error('Error loading Hivebox logs:', error);
        document.getElementById('hivebox-logs-container').innerHTML = 
          \`<p style="color: #dc3545; padding: 20px;">Error loading logs: \${error.message || 'Unknown error'}</p>\`;
      }
    }

    async function runHiveboxJob(dryRun) {
      const statusEl = document.getElementById('hivebox-status');
      const originalHTML = statusEl.innerHTML;
      
      statusEl.innerHTML = '<p style="color: #666;">Running job...</p>';
      
      try {
        const res = await fetch('/api/hivebox/run?dry_run=' + (dryRun ? 'true' : 'false'), {
          method: 'POST',
        });
        
        const data = await res.json();
        
        if (!res.ok) {
          throw new Error(data.message || data.error || 'Job failed');
        }
        
        alert(\`Job completed! \${dryRun ? '(Dry Run)' : ''}\nFetched: \${data.stats.fetched}\nSent: \${data.stats.sent}\nSkipped: \${data.stats.skippedOptedOut + data.stats.skippedInvalidPhone + data.stats.skippedNonUK}\nFailed: \${data.stats.failed}\`);
        
        // Reload data
        loadHiveboxData();
      } catch (error) {
        alert('Error running job: ' + error.message);
        statusEl.innerHTML = originalHTML;
      }
    }

    // Load data on page load
    loadHiveboxData();
    
    // Auto-refresh every 30 seconds
    setInterval(loadHiveboxData, 30000);
  </script>
</body>
</html>
  `;
}

