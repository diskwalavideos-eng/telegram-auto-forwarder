import { pool } from "@workspace/db";
import { logger } from "../lib/logger";

export async function initializeTelegramDatabase(): Promise<void> {
  await pool.query(`
    -- 1. Channels Table
    CREATE TABLE IF NOT EXISTS telegram_channels (
      id SERIAL PRIMARY KEY,
      user_id BIGINT NOT NULL,
      kind TEXT NOT NULL CHECK (kind IN ('SOURCE', 'TARGET')),
      telegram_id TEXT NOT NULL,
      username TEXT,
      title TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    -- 2. Forwarding Rules Table (Supports Custom Interval & Multiple Fixed Times)
    CREATE TABLE IF NOT EXISTS forwarding_rules (
      id SERIAL PRIMARY KEY,
      user_id BIGINT NOT NULL,
      source_channel_id INTEGER NOT NULL REFERENCES telegram_channels(id) ON DELETE CASCADE,
      target_channel_id INTEGER NOT NULL REFERENCES telegram_channels(id) ON DELETE CASCADE,
      start_mode TEXT NOT NULL,
      start_value TEXT,
      next_message_id INTEGER,
      last_forwarded_message_id INTEGER,
      message_count INTEGER NOT NULL DEFAULT 10,
      schedule_type TEXT NOT NULL CHECK (schedule_type IN ('INTERVAL', 'FIXED')),
      interval_minutes INTEGER,
      fixed_times JSONB NOT NULL DEFAULT '[]'::jsonb,
      timezone TEXT NOT NULL DEFAULT 'Asia/Kolkata',
      next_run_at TIMESTAMPTZ,
      status TEXT NOT NULL DEFAULT 'PAUSED' CHECK (status IN ('ACTIVE', 'PAUSED')),
      total_forwarded INTEGER NOT NULL DEFAULT 0,
      total_failed INTEGER NOT NULL DEFAULT 0,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    -- 3. Forwarding History Table
    CREATE TABLE IF NOT EXISTS forwarding_history (
      id SERIAL PRIMARY KEY,
      rule_id INTEGER NOT NULL REFERENCES forwarding_rules(id) ON DELETE CASCADE,
      source_message_id INTEGER NOT NULL,
      target_message_id INTEGER,
      status TEXT NOT NULL CHECK (status IN ('SUCCESS', 'FAILED')),
      error TEXT,
      attempted_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE (rule_id, source_message_id)
    );

    -- 4. Error Logs Table
    CREATE TABLE IF NOT EXISTS telegram_bot_errors (
      id SERIAL PRIMARY KEY,
      rule_id INTEGER REFERENCES forwarding_rules(id) ON DELETE SET NULL,
      error_type TEXT NOT NULL,
      message TEXT NOT NULL,
      retryable BOOLEAN NOT NULL DEFAULT FALSE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    -- 5. Bot Settings Table
    CREATE TABLE IF NOT EXISTS bot_settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );

    -- 6. Channel Mappings Table
    CREATE TABLE IF NOT EXISTS channel_mappings (
      id SERIAL PRIMARY KEY,
      user_id BIGINT NOT NULL,
      source_channel_id INTEGER NOT NULL REFERENCES telegram_channels(id) ON DELETE CASCADE,
      target_channel_id INTEGER NOT NULL REFERENCES telegram_channels(id) ON DELETE CASCADE,
      schedule_type TEXT NOT NULL DEFAULT 'INTERVAL' CHECK (schedule_type IN ('INTERVAL', 'FIXED')),
      custom_hours NUMERIC(5, 2) NOT NULL DEFAULT 4.00,
      fixed_times JSONB NOT NULL DEFAULT '[]'::jsonb,
      custom_posts INTEGER NOT NULL DEFAULT 10,
      start_at TIMESTAMPTZ,
      timezone TEXT NOT NULL DEFAULT 'Asia/Kolkata',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    -- 7. User Subscriptions Table
    CREATE TABLE IF NOT EXISTS user_subscriptions (
      telegram_id BIGINT PRIMARY KEY,
      username TEXT,
      full_name TEXT,
      status TEXT NOT NULL DEFAULT 'PENDING',
      requested_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    -- 8. Automated Migration Block for Columns and Types
    DO $$ 
    BEGIN
      -- Handle message_count column
      IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'forwarding_rules' AND column_name = 'messageCount') THEN
        ALTER TABLE forwarding_rules RENAME COLUMN "messageCount" TO message_count;
      ELSIF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'forwarding_rules' AND column_name = 'batch_size') THEN
        ALTER TABLE forwarding_rules RENAME COLUMN batch_size TO message_count;
      END IF;

      IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'forwarding_rules' AND column_name = 'message_count') THEN
        ALTER TABLE forwarding_rules ADD COLUMN message_count INTEGER NOT NULL DEFAULT 10;
      END IF;

      -- Handle schedule_type & fixed_times in channel_mappings
      IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'channel_mappings' AND column_name = 'schedule_type') THEN
        ALTER TABLE channel_mappings ADD COLUMN schedule_type TEXT NOT NULL DEFAULT 'INTERVAL';
      END IF;

      IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'channel_mappings' AND column_name = 'fixed_times') THEN
        ALTER TABLE channel_mappings ADD COLUMN fixed_times JSONB NOT NULL DEFAULT '[]'::jsonb;
      END IF;

      -- Ensure BIGINT user_id across tables
      IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'forwarding_rules' AND column_name = 'user_id') THEN
        ALTER TABLE forwarding_rules ADD COLUMN user_id BIGINT;
      END IF;
      ALTER TABLE forwarding_rules ALTER COLUMN user_id TYPE BIGINT;

      IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'telegram_channels' AND column_name = 'user_id') THEN
        ALTER TABLE telegram_channels ADD COLUMN user_id BIGINT;
      END IF;
      ALTER TABLE telegram_channels ALTER COLUMN user_id TYPE BIGINT;

      IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'channel_mappings' AND column_name = 'user_id') THEN
        ALTER TABLE channel_mappings ADD COLUMN user_id BIGINT;
      END IF;
      ALTER TABLE channel_mappings ALTER COLUMN user_id TYPE BIGINT;

      -- Ensure default values for audit fields
      IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'forwarding_rules' AND column_name = 'total_failed') THEN
        ALTER TABLE forwarding_rules ADD COLUMN total_failed INTEGER NOT NULL DEFAULT 0;
      END IF;

      IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'forwarding_rules' AND column_name = 'total_forwarded') THEN
        ALTER TABLE forwarding_rules ADD COLUMN total_forwarded INTEGER NOT NULL DEFAULT 0;
      END IF;

      IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'forwarding_rules' AND column_name = 'updated_at') THEN
        ALTER TABLE forwarding_rules ADD COLUMN updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW();
      END IF;
    END $$;

    -- 9. Remove obsolete constraints and recreate multi-user indexes
    ALTER TABLE telegram_channels DROP CONSTRAINT IF EXISTS telegram_channels_kind_telegram_id_key;
    ALTER TABLE telegram_channels DROP CONSTRAINT IF EXISTS telegram_channels_kind_telegram_id_unique;
    ALTER TABLE channel_mappings DROP CONSTRAINT IF EXISTS channel_mappings_source_channel_id_target_channel_id_key;
    ALTER TABLE channel_mappings DROP CONSTRAINT IF EXISTS channel_mappings_source_channel_id_target_channel_id_unique;

    CREATE UNIQUE INDEX IF NOT EXISTS idx_telegram_channels_user_kind_peer 
    ON telegram_channels (user_id, kind, telegram_id);

    CREATE UNIQUE INDEX IF NOT EXISTS idx_channel_mappings_user_source_target 
    ON channel_mappings (user_id, source_channel_id, target_channel_id);
  `);
  logger.info("Telegram forwarding database initialized with multi-schedule support");
}