/**
 * Database migration script for Supabase PostgreSQL
 * Run: node src/migrate.js
 */
require('dotenv').config();
const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: {
    rejectUnauthorized: false
  }
});

async function migrate() {
  console.log('🚀 Running database migrations...');

  try {
    // Create users table
    await pool.query(`
      CREATE TABLE IF NOT EXISTS users (
        telegram_id BIGINT PRIMARY KEY,
        username TEXT,
        first_name TEXT,
        last_name TEXT,
        registered_at TIMESTAMPTZ DEFAULT NOW(),
        is_active INTEGER DEFAULT 1
      );
    `);
    console.log('✅ users table created');

    // Create submissions table
    await pool.query(`
      CREATE TABLE IF NOT EXISTS submissions (
        id BIGSERIAL PRIMARY KEY,
        user_id BIGINT NOT NULL REFERENCES users(telegram_id),
        submission_date DATE NOT NULL,
        file_id TEXT NOT NULL,
        file_type TEXT NOT NULL DEFAULT 'voice',
        file_unique_id TEXT,
        duration INTEGER DEFAULT 0,
        caption TEXT,
        submitted_at TIMESTAMPTZ DEFAULT NOW(),
        is_valid INTEGER DEFAULT 1,
        checked_by BIGINT REFERENCES users(telegram_id),
        checked_at TIMESTAMPTZ
      );
    `);
    console.log('✅ submissions table created');

    // Create penalties table
    await pool.query(`
      CREATE TABLE IF NOT EXISTS penalties (
        id BIGSERIAL PRIMARY KEY,
        user_id BIGINT NOT NULL REFERENCES users(telegram_id),
        penalty_date DATE NOT NULL,
        reason TEXT NOT NULL,
        created_at TIMESTAMPTZ DEFAULT NOW()
      );
    `);
    console.log('✅ penalties table created');

    // Create indexes
    await pool.query(`
      CREATE INDEX IF NOT EXISTS idx_submissions_user_date 
        ON submissions(user_id, submission_date);
    `);
    console.log('✅ idx_submissions_user_date index created');

    await pool.query(`
      CREATE INDEX IF NOT EXISTS idx_submissions_date 
        ON submissions(submission_date);
    `);
    console.log('✅ idx_submissions_date index created');

    await pool.query(`
      CREATE INDEX IF NOT EXISTS idx_penalties_user_date
        ON penalties(user_id, penalty_date);
    `);
    console.log('✅ idx_penalties_user_date index created');

    // ===== Multi-group support =====
    // Each submission/penalty belongs to a "scope" identified by chat_id:
    //   - a group/supergroup  -> the group's chat id (negative)
    //   - a private 1:1 chat   -> the user's own id (positive)
    // This keeps every group independent and 1:1 practice separate.

    // Add chat_id to submissions and backfill existing rows as personal (1:1) scope.
    await pool.query(`ALTER TABLE submissions ADD COLUMN IF NOT EXISTS chat_id BIGINT;`);
    await pool.query(`UPDATE submissions SET chat_id = user_id WHERE chat_id IS NULL;`);
    console.log('✅ submissions.chat_id added & backfilled');

    // Add chat_id to penalties and backfill the same way.
    await pool.query(`ALTER TABLE penalties ADD COLUMN IF NOT EXISTS chat_id BIGINT;`);
    await pool.query(`UPDATE penalties SET chat_id = user_id WHERE chat_id IS NULL;`);
    console.log('✅ penalties.chat_id added & backfilled');

    // Groups the bot has been added to
    await pool.query(`
      CREATE TABLE IF NOT EXISTS groups (
        chat_id BIGINT PRIMARY KEY,
        title TEXT,
        registered_at TIMESTAMPTZ DEFAULT NOW(),
        is_active INTEGER DEFAULT 1
      );
    `);
    console.log('✅ groups table created');

    // Which users participate in which group
    await pool.query(`
      CREATE TABLE IF NOT EXISTS group_members (
        chat_id BIGINT NOT NULL,
        telegram_id BIGINT NOT NULL,
        joined_at TIMESTAMPTZ DEFAULT NOW(),
        is_active INTEGER DEFAULT 1,
        PRIMARY KEY (chat_id, telegram_id)
      );
    `);
    console.log('✅ group_members table created');

    await pool.query(`
      CREATE INDEX IF NOT EXISTS idx_submissions_chat_date
        ON submissions(chat_id, submission_date);
    `);
    await pool.query(`
      CREATE INDEX IF NOT EXISTS idx_group_members_chat
        ON group_members(chat_id);
    `);
    console.log('✅ multi-group indexes created');

    // Replace the old per-user/day uniqueness with per-user/scope/day so a user
    // can submit once per group per day (and once in their 1:1 chat).
    await pool.query(`DROP INDEX IF EXISTS idx_submissions_unique_daily;`);
    await pool.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS idx_submissions_unique_daily_scope
        ON submissions(user_id, chat_id, submission_date) WHERE is_valid = 1;
    `);
    console.log('✅ idx_submissions_unique_daily_scope index created');

    console.log('\n🎉 All migrations completed successfully!');
  } catch (err) {
    console.error('❌ Migration failed:', err.message);
  } finally {
    await pool.end();
  }
}

migrate();