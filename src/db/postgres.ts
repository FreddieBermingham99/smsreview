import "dotenv/config";

import { Pool } from "pg";

if (!process.env.DATABASE_READ_URL) {
  throw new Error("DATABASE_READ_URL is not set");
}

console.log("[DB] Creating Postgres pool with SSL override");

// Remove sslmode from connection string if present, we'll set SSL via Pool config
let connectionString = process.env.DATABASE_READ_URL;
// Remove sslmode parameter (handles both ?sslmode= and &sslmode=)
connectionString = connectionString.replace(/[?&]sslmode=[^&]*/gi, (match) => {
  return match.startsWith('?') ? '?' : '';
});
// Clean up double ? or trailing &
connectionString = connectionString.replace(/\?&/g, '?').replace(/[?&]$/, '');

export const readPool = new Pool({
  connectionString: connectionString,
  ssl: {
    rejectUnauthorized: false,
  },
  connectionTimeoutMillis: 10_000,
});

