-- Migration: Create review_sms_log table
-- This table logs all SMS attempts for idempotency and tracking

CREATE TABLE IF NOT EXISTS review_sms_log (
  booking_id BIGINT PRIMARY KEY,
  phone_e164 VARCHAR(20) NOT NULL,
  stashpoint_id BIGINT NOT NULL,
  message TEXT NOT NULL,
  template_version VARCHAR(50) DEFAULT '1.0',
  textmagic_message_id VARCHAR(100),
  status VARCHAR(20) NOT NULL CHECK (status IN ('sent', 'failed')),
  sent_at TIMESTAMP,
  error TEXT,
  created_at TIMESTAMP NOT NULL DEFAULT NOW()
);

-- Indexes for querying
CREATE INDEX IF NOT EXISTS idx_review_sms_log_phone_e164 ON review_sms_log(phone_e164);
CREATE INDEX IF NOT EXISTS idx_review_sms_log_stashpoint_id ON review_sms_log(stashpoint_id);
CREATE INDEX IF NOT EXISTS idx_review_sms_log_created_at ON review_sms_log(created_at);
CREATE INDEX IF NOT EXISTS idx_review_sms_log_status ON review_sms_log(status);

COMMENT ON TABLE review_sms_log IS 'Logs all SMS review requests sent to customers';
COMMENT ON COLUMN review_sms_log.booking_id IS 'Primary key - ensures idempotency (one SMS per booking)';
COMMENT ON COLUMN review_sms_log.phone_e164 IS 'Normalized E.164 phone number';
COMMENT ON COLUMN review_sms_log.status IS 'sent or failed';
COMMENT ON COLUMN review_sms_log.textmagic_message_id IS 'TextMagic API message ID for tracking';

