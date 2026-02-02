import Database from 'better-sqlite3';
import * as path from 'path';
import * as fs from 'fs';

const DB_PATH = process.env.OPT_OUT_DB_PATH || path.join(process.cwd(), 'data', 'optouts.db');

// Ensure data directory exists
const dataDir = path.dirname(DB_PATH);
if (!fs.existsSync(dataDir)) {
  fs.mkdirSync(dataDir, { recursive: true });
}

let db: Database.Database | null = null;

export function getOptOutDb(): Database.Database {
  if (!db) {
    db = new Database(DB_PATH);
    
    // Create opt-out table if it doesn't exist
    db.exec(`
      CREATE TABLE IF NOT EXISTS sms_opt_out (
        phone_e164 TEXT PRIMARY KEY,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        source TEXT NOT NULL,
        note TEXT
      );
      
      CREATE INDEX IF NOT EXISTS idx_sms_opt_out_created_at ON sms_opt_out(created_at);
    `);
    
    // Initialize SMS logging tables
    initSMSLogTable();
    initJobRunSummaryTable();
  }
  
  return db;
}

export function closeOptOutDb(): void {
  if (db) {
    db.close();
    db = null;
  }
}

// Opt-out operations
export interface OptOut {
  phone_e164: string;
  created_at: string;
  source: string;
  note: string | null;
}

export function addOptOut(phoneE164: string, source: string, note?: string): void {
  const db = getOptOutDb();
  const stmt = db.prepare(`
    INSERT INTO sms_opt_out (phone_e164, source, note)
    VALUES (?, ?, ?)
    ON CONFLICT(phone_e164) DO UPDATE SET
      source = excluded.source,
      note = excluded.note,
      created_at = datetime('now')
  `);
  stmt.run(phoneE164, source, note || null);
}

export function removeOptOut(phoneE164: string): boolean {
  const db = getOptOutDb();
  const stmt = db.prepare('DELETE FROM sms_opt_out WHERE phone_e164 = ?');
  const result = stmt.run(phoneE164);
  return result.changes > 0;
}

export function isOptedOut(phoneE164: string): boolean {
  const db = getOptOutDb();
  const stmt = db.prepare('SELECT 1 FROM sms_opt_out WHERE phone_e164 = ? LIMIT 1');
  const row = stmt.get(phoneE164);
  return !!row;
}

export function getAllOptOuts(limit: number = 100): OptOut[] {
  const db = getOptOutDb();
  const stmt = db.prepare('SELECT * FROM sms_opt_out ORDER BY created_at DESC LIMIT ?');
  return stmt.all(limit) as OptOut[];
}

export function searchOptOuts(query: string, limit: number = 100): OptOut[] {
  const db = getOptOutDb();
  const searchTerm = `%${query}%`;
  const stmt = db.prepare(`
    SELECT * FROM sms_opt_out 
    WHERE phone_e164 LIKE ? OR note LIKE ?
    ORDER BY created_at DESC 
    LIMIT ?
  `);
  return stmt.all(searchTerm, searchTerm, limit) as OptOut[];
}

// SMS Send Logging
export interface SMSLog {
  id?: number;
  feature: string;
  booking_id: string | number | null;
  phone: string;
  pickup_time: string | null;
  status: 'sent' | 'skipped_opted_out' | 'skipped_invalid_phone' | 'skipped_non_uk' | 'failed';
  error: string | null;
  created_at: string;
}

export function initSMSLogTable(): void {
  const db = getOptOutDb();
  db.exec(`
    CREATE TABLE IF NOT EXISTS sms_send_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      feature TEXT NOT NULL,
      booking_id TEXT,
      phone TEXT NOT NULL,
      pickup_time TEXT,
      status TEXT NOT NULL,
      error TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    
    CREATE INDEX IF NOT EXISTS idx_sms_log_feature ON sms_send_log(feature);
    CREATE INDEX IF NOT EXISTS idx_sms_log_created_at ON sms_send_log(created_at);
    CREATE INDEX IF NOT EXISTS idx_sms_log_booking_id ON sms_send_log(booking_id);
  `);
}

export function logSMS(log: Omit<SMSLog, 'id' | 'created_at'>): void {
  const db = getOptOutDb();
  const stmt = db.prepare(`
    INSERT INTO sms_send_log (feature, booking_id, phone, pickup_time, status, error)
    VALUES (?, ?, ?, ?, ?, ?)
  `);
  stmt.run(
    log.feature,
    log.booking_id ? String(log.booking_id) : null,
    log.phone,
    log.pickup_time ?? null,
    log.status,
    log.error ?? null
  );
}

export function getSMSLogs(feature: string, limit: number = 100): SMSLog[] {
  const db = getOptOutDb();
  const stmt = db.prepare(`
    SELECT * FROM sms_send_log 
    WHERE feature = ?
    ORDER BY created_at DESC 
    LIMIT ?
  `);
  return stmt.all(feature, limit) as SMSLog[];
}

// Job Run Summary Logging
export interface JobRunSummary {
  id?: number;
  feature: string;
  started_at: string;
  finished_at: string | null;
  fetched_count: number;
  sent_count: number;
  skipped_count: number;
  failed_count: number;
  error: string | null;
}

export function initJobRunSummaryTable(): void {
  const db = getOptOutDb();
  db.exec(`
    CREATE TABLE IF NOT EXISTS job_run_summary (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      feature TEXT NOT NULL,
      started_at TEXT NOT NULL,
      finished_at TEXT,
      fetched_count INTEGER NOT NULL DEFAULT 0,
      sent_count INTEGER NOT NULL DEFAULT 0,
      skipped_count INTEGER NOT NULL DEFAULT 0,
      failed_count INTEGER NOT NULL DEFAULT 0,
      error TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    
    CREATE INDEX IF NOT EXISTS idx_job_run_feature ON job_run_summary(feature);
    CREATE INDEX IF NOT EXISTS idx_job_run_started_at ON job_run_summary(started_at);
  `);
}

export function createJobRunSummary(summary: Omit<JobRunSummary, 'id'>): number {
  const db = getOptOutDb();
  const stmt = db.prepare(`
    INSERT INTO job_run_summary (feature, started_at, finished_at, fetched_count, sent_count, skipped_count, failed_count, error)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const result = stmt.run(
    summary.feature,
    summary.started_at,
    summary.finished_at || null,
    summary.fetched_count,
    summary.sent_count,
    summary.skipped_count,
    summary.failed_count,
    summary.error || null
  );
  return Number(result.lastInsertRowid);
}

export function updateJobRunSummary(id: number, updates: Partial<Omit<JobRunSummary, 'id' | 'feature'>>): void {
  const db = getOptOutDb();
  const fields: string[] = [];
  const values: any[] = [];
  
  if (updates.finished_at !== undefined) {
    fields.push('finished_at = ?');
    values.push(updates.finished_at);
  }
  if (updates.sent_count !== undefined) {
    fields.push('sent_count = ?');
    values.push(updates.sent_count);
  }
  if (updates.skipped_count !== undefined) {
    fields.push('skipped_count = ?');
    values.push(updates.skipped_count);
  }
  if (updates.failed_count !== undefined) {
    fields.push('failed_count = ?');
    values.push(updates.failed_count);
  }
  if (updates.error !== undefined) {
    fields.push('error = ?');
    values.push(updates.error);
  }
  
  if (fields.length === 0) return;
  
  values.push(id);
  const stmt = db.prepare(`UPDATE job_run_summary SET ${fields.join(', ')} WHERE id = ?`);
  stmt.run(...values);
}

export function getLatestJobRunSummary(feature: string): JobRunSummary | null {
  const db = getOptOutDb();
  const stmt = db.prepare(`
    SELECT * FROM job_run_summary 
    WHERE feature = ?
    ORDER BY started_at DESC 
    LIMIT 1
  `);
  const result = stmt.get(feature) as JobRunSummary | undefined;
  return result || null;
}


