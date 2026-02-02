# Hosting Stasher Review SMS Online

This app needs to run 24/7 so that:
- The **webhook server** can receive inbound SMS (STOP) and delivery callbacks from TextMagic
- The **daily job** runs at 10:00 London time
- The **Hivebox hourly job** runs every hour

Use one of the options below. All require a **public URL** so TextMagic can reach your webhooks.

---

## Option 1: Railway (Recommended)

[Railway](https://railway.app) keeps the app running and supports volumes for SQLite.

1. **Create a project** at [railway.app](https://railway.app) and connect your Git repo (or deploy from CLI).

2. **Add a PostgreSQL database** (if you don’t have one yet) in Railway, or use an existing external Postgres. Copy the connection URL.

3. **Set environment variables** in Railway → your service → Variables:

   | Variable | Required | Example |
   |----------|----------|--------|
   | `DATABASE_URL` or `DATABASE_READ_URL` | Yes | `postgresql://user:pass@host:5432/db` |
   | `TEXTMAGIC_USERNAME` | Yes | your TextMagic login |
   | `TEXTMAGIC_API_KEY` | Yes | your TextMagic API key |
   | `PORT` | Set by Railway | (auto) |
   | `TEXTMAGIC_SENDER` | No | `Stasher` |
   | `SMS_DELAY_MS` | No | `200` |
   | `WEBHOOK_SECRET` | No | optional |

4. **Deploy**  
   - **From GitHub**: Push to your repo; Railway builds and deploys.  
   - **With Docker**: In Railway, set *Build* to use the repo’s `Dockerfile`.  
   - **Without Docker**: Set *Build Command* to `npm ci && npm run build`, *Start Command* to `node dist/index.js`, *Root Directory* to your app folder.

5. **Persist opt-outs (SQLite)**  
   In Railway → your service → *Volumes*, add a volume and mount it at `/app/data`.  
   Optionally set `OPT_OUT_DB_PATH=/app/data/optouts.db` so the opt-out DB lives on the volume.

6. **Get your URL**  
   Railway gives you a URL like `https://your-app.up.railway.app`.  
   In TextMagic, set:
   - Inbound SMS webhook: `https://your-app.up.railway.app/webhook/inbound`
   - Delivery status webhook: `https://your-app.up.railway.app/webhook/delivery`

7. **Review links CSV**  
   Upload `data/review-links.csv` via the dashboard (after first deploy), or set `REVIEW_LINKS_CSV` to a path where you’ve placed the file (e.g. via a volume).

---

## Option 2: Render

[Render](https://render.com) can host the app as a Web Service. The free tier **sleeps after 15 minutes**, so cron and webhooks stop. Use a **paid plan** for 24/7.

1. **New Web Service** → Connect your repo.

2. **Build & run**  
   - **Runtime**: Node  
   - **Build Command**: `npm ci && npm run build`  
   - **Start Command**: `node dist/index.js`  
   Or use **Docker** and select your `Dockerfile`.

3. **Environment**  
   Add the same variables as in the Railway table (Render sets `PORT` automatically).

4. **Persistent disk (paid)**  
   Add a disk and mount it (e.g. `/data`). Set `OPT_OUT_DB_PATH=/data/optouts.db` so opt-outs survive deploys.

5. **Public URL**  
   Use the Render URL (e.g. `https://your-app.onrender.com`) for TextMagic webhooks as above.

---

## Option 3: Docker (VPS or any host)

You can run the app in Docker on any server (DigitalOcean, Linode, AWS EC2, etc.).

1. **Build and run** (replace `your-app` and env values):

   ```bash
   docker build -t stasher-review-sms .
   docker run -d --name stasher-review-sms \
     -p 4010:4010 \
     -e DATABASE_URL="postgresql://..." \
     -e TEXTMAGIC_USERNAME="..." \
     -e TEXTMAGIC_API_KEY="..." \
     -v stasher-data:/app/data \
     --restart unless-stopped \
     stasher-review-sms
   ```

2. **Use a reverse proxy** (e.g. Caddy or Nginx) with HTTPS and point your domain to this server. Then set TextMagic webhooks to `https://yourdomain.com/webhook/inbound` and `.../webhook/delivery`.

3. **Optional env for SQLite path**  
   If you mount a volume at `/app/data`, the default path is `data/optouts.db` under `/app`, so it will use the volume. To be explicit:  
   `-e OPT_OUT_DB_PATH=/app/data/optouts.db`

---

## Environment variables summary

| Variable | Description |
|----------|-------------|
| `DATABASE_URL` or `DATABASE_READ_URL` | PostgreSQL connection string (required) |
| `TEXTMAGIC_USERNAME` | TextMagic account username (required unless DRY_RUN) |
| `TEXTMAGIC_API_KEY` | TextMagic API key (required unless DRY_RUN) |
| `PORT` | Set by Railway/Render; app uses this for the HTTP server |
| `WEBHOOK_PORT` | Used only if `PORT` is not set (default 4010) |
| `OPT_OUT_DB_PATH` | Path for SQLite opt-out DB (default: `data/optouts.db`) |
| `REVIEW_LINKS_CSV` | Path to review links CSV (default: `data/review-links.csv`) |
| `TEXTMAGIC_SENDER` | Sender ID (optional) |
| `SMS_DELAY_MS` | Delay between SMS (default 200) |
| `DRY_RUN` | `true` = no SMS sent |
| `RUN_JOB` | `true` = run daily job once on startup |

---

## After going live

1. **TextMagic**  
   Set Inbound and Delivery webhook URLs to your public base URL + `/webhook/inbound` and `/webhook/delivery`.

2. **Dashboard**  
   Open `https://your-app-url/` to use the manual job trigger, opt-out list, and review links upload.

3. **Health**  
   Use `GET /health` for uptime checks.
