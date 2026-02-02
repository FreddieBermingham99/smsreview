# stasher-review-sms

A production-ready service that sends daily SMS requests for Google reviews to Stasher customers who picked up their bags the previous day.

## Features

- ✅ Sends SMS via TextMagic API
- ✅ Idempotent (never sends duplicate SMS for same booking)
- ✅ Opt-out handling (STOP keywords)
- ✅ Phone number normalization (E.164 format)
- ✅ Rate limiting to avoid API throttling
- ✅ DRY_RUN mode for testing
- ✅ Webhook server for inbound SMS and delivery status
- ✅ Comprehensive logging and error handling
- ✅ Timezone-aware (Europe/London)

## Setup

### 1. Install Dependencies

```bash
npm install
```

### 2. Build TypeScript

```bash
npm run build
```

### 3. Run Database Migrations

```bash
psql $DATABASE_URL -f migrations/001_create_review_sms_log.sql
psql $DATABASE_URL -f migrations/002_create_sms_opt_out.sql
```

Or use your preferred migration tool.

### 4. Environment Variables

Create a `.env` file or set these environment variables:

```bash
# Required
DATABASE_URL=postgresql://user:password@host:5432/database
TEXTMAGIC_USERNAME=your_textmagic_username
TEXTMAGIC_API_KEY=your_textmagic_api_key

# Optional
TEXTMAGIC_SENDER=Stasher          # Custom sender ID (optional)
SMS_DELAY_MS=200                  # Delay between SMS sends (default: 200ms)
PORT=4010                         # Used by hosting platforms (Railway, Render); else WEBHOOK_PORT
WEBHOOK_PORT=4010                 # Webhook server port when PORT not set (default: 4010)
WEBHOOK_SECRET=                   # Optional webhook secret for validation
DRY_RUN=false                     # Set to true to test without sending
RUN_JOB=false                     # Set to true to run job on startup
```

## Usage

### Dry Run (Test Mode)

Test what the job would do without sending any SMS or writing to the database:

```bash
npm run job:dry-run
```

Or:

```bash
DRY_RUN=true RUN_JOB=true npm start
```

### Run Job Manually

Run the job once (sends SMS and logs to database):

```bash
npm run job
```

Or:

```bash
RUN_JOB=true npm start
```

### Start Webhook Server

Start the webhook server to receive inbound SMS and delivery status callbacks:

```bash
npm start
```

The server will listen on port 4010 (or `PORT` / `WEBHOOK_PORT` if set).

**Endpoints:**
- `GET /health` - Health check
- `POST /webhook/inbound` - Receive inbound SMS (for STOP handling)
- `POST /webhook/delivery` - Receive delivery status callbacks

### Run Both Job and Server

Start the server and run the job:

```bash
RUN_JOB=true npm start
```

## Hosting Online

To run the app 24/7 so the webhook and scheduled jobs always run, see **[DEPLOY.md](DEPLOY.md)**. It covers:

- **Railway** – recommended; always-on, supports volumes for opt-out DB
- **Render** – use a paid plan for 24/7 (free tier sleeps)
- **Docker** – run on any VPS (DigitalOcean, Linode, etc.) with a reverse proxy and HTTPS

The app uses `PORT` when set (e.g. by Railway/Render) and supports optional `OPT_OUT_DB_PATH` for persisting the SQLite opt-out database.

## Scheduling (Daily at 10:00 London Time)

### Option 1: Cron (Recommended)

Add to your crontab:

```bash
# Run daily at 10:00 AM London time
0 10 * * * cd /path/to/stasher-review-sms && /usr/bin/node dist/index.js RUN_JOB=true >> /var/log/stasher-review-sms.log 2>&1
```

Note: Ensure your cron environment has:
- `DATABASE_URL` set
- `TEXTMAGIC_USERNAME` and `TEXTMAGIC_API_KEY` set
- Node.js in PATH or use full path to node

### Option 2: Systemd Timer (Linux)

Create `/etc/systemd/system/stasher-review-sms.service`:

```ini
[Unit]
Description=Stasher Review SMS Job
After=network.target

[Service]
Type=oneshot
Environment="DATABASE_URL=postgresql://..."
Environment="TEXTMAGIC_USERNAME=..."
Environment="TEXTMAGIC_API_KEY=..."
Environment="RUN_JOB=true"
WorkingDirectory=/path/to/stasher-review-sms
ExecStart=/usr/bin/node dist/index.js
User=your-user
```

Create `/etc/systemd/system/stasher-review-sms.timer`:

```ini
[Unit]
Description=Run Stasher Review SMS daily at 10:00 London time

[Timer]
OnCalendar=Europe/London:10:00
Persistent=true

[Install]
WantedBy=timers.target
```

Enable and start:

```bash
sudo systemctl enable stasher-review-sms.timer
sudo systemctl start stasher-review-sms.timer
```

## Configuration

### Schema Customization

If your database schema differs from the defaults, edit `src/config.ts`:

```typescript
export const SCHEMA: SchemaConfig = {
  bookings: {
    table: 'bookings',
    id: 'id',
    pickedUpAt: 'picked_up_at',        // Change if your column name differs
    stashpointId: 'stashpoint_id',
    customerPhone: 'customer_phone',
  },
  stashpoints: {
    table: 'stashpoints',
    id: 'id',
    name: 'name',
    googleReviewUrl: 'google_review_url',  // Change if your column name differs
  },
};
```

### SMS Message Template

Edit the message template in `src/config.ts`:

```typescript
export const SMS_TEMPLATE = (stashpointName: string, reviewLink: string): string => {
  return `Thanks for using Stasher at ${stashpointName} yesterday 🙌 Would you mind leaving a quick Google review? ${reviewLink} Reply STOP to opt out.`;
};
```

## TextMagic Webhook Configuration

Configure TextMagic webhooks to point to your server:

1. **Inbound SMS**: Set webhook URL to `https://your-domain.com/webhook/inbound`
2. **Delivery Status**: Set webhook URL to `https://your-domain.com/webhook/delivery`

The webhook server handles:
- **STOP keywords**: `STOP`, `STOPALL`, `UNSUBSCRIBE`, `CANCEL`, `END`, `QUIT`
- **Opt-in keywords** (optional): `START`, `YES`, `UNSTOP`

## Compliance & Opt-Out

### Automatic Opt-Out

The service automatically opts out customers who reply with STOP keywords. These phone numbers are stored in `sms_opt_out` table and will never receive SMS again.

### Manual Opt-Out

To manually opt out a phone number:

```sql
INSERT INTO sms_opt_out (phone_e164, source, opted_out_at)
VALUES ('+44123456789', 'manual', NOW())
ON CONFLICT (phone_e164) DO NOTHING;
```

### Opt-In (Re-subscribe)

To remove an opt-out:

```sql
DELETE FROM sms_opt_out WHERE phone_e164 = '+44123456789';
```

## Monitoring & Logs

The service logs:
- Counts: found, eligible, skipped (with reasons), sent, failed
- Each SMS sent (with TextMagic message ID)
- Errors with booking ID and phone number
- Opt-out events

Check logs for:
- Job execution summary
- Individual SMS delivery status
- Opt-out events

## Troubleshooting

### "DATABASE_URL is required"

Ensure `DATABASE_URL` environment variable is set.

### "TEXTMAGIC_USERNAME and TEXTMAGIC_API_KEY are required"

Set these environment variables. In DRY_RUN mode, they're not required.

### SMS not sending

1. Check TextMagic account balance
2. Verify phone numbers are in E.164 format
3. Check for opt-outs: `SELECT * FROM sms_opt_out WHERE phone_e164 = '...'`
4. Check for existing sends: `SELECT * FROM review_sms_log WHERE booking_id = ...`

### Duplicate SMS sent

The service uses `booking_id` as primary key in `review_sms_log` to prevent duplicates. If duplicates occur, check:
- Multiple job runs at the same time (should use ON CONFLICT DO NOTHING)
- Database constraint issues

## Project Structure

```
stasher-review-sms/
├── src/
│   ├── config.ts          # Configuration and schema mapping
│   ├── db.ts              # PostgreSQL client
│   ├── textmagic.ts       # TextMagic API wrapper
│   ├── job.ts             # Core job logic
│   ├── webhook.ts         # Webhook server for inbound SMS
│   ├── utils.ts           # Phone normalization utilities
│   └── index.ts           # Main entry point
├── migrations/
│   ├── 001_create_review_sms_log.sql
│   └── 002_create_sms_opt_out.sql
├── package.json
├── tsconfig.json
└── README.md
```

## License

ISC

