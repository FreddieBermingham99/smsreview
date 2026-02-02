-- Migration: Create sms_opt_out table
-- This table tracks phone numbers that have opted out of SMS

CREATE TABLE IF NOT EXISTS sms_opt_out (
  phone_e164 VARCHAR(20) PRIMARY KEY,
  opted_out_at TIMESTAMP NOT NULL DEFAULT NOW(),
  source VARCHAR(100) NOT NULL,
  last_inbound_text TEXT,
  created_at TIMESTAMP NOT NULL DEFAULT NOW()
);

-- Index for quick lookups
CREATE INDEX IF NOT EXISTS idx_sms_opt_out_opted_out_at ON sms_opt_out(opted_out_at);

COMMENT ON TABLE sms_opt_out IS 'Phone numbers that have opted out of SMS marketing';
COMMENT ON COLUMN sms_opt_out.phone_e164 IS 'Primary key - normalized E.164 phone number';
COMMENT ON COLUMN sms_opt_out.source IS 'Source of opt-out (e.g., inbound_sms_stop, manual, etc.)';
COMMENT ON COLUMN sms_opt_out.last_inbound_text IS 'Last inbound SMS text that triggered opt-out (if applicable)';

