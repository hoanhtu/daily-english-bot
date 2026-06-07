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

    // Create unique constraint to prevent duplicate submissions per user per day
    await pool.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS idx_submissions_unique_daily
        ON submissions(user_id, submission_date) WHERE is_valid = 1;
    `);
    console.log('✅ idx_submissions_unique_daily index created');

    console.log('\n🎉 All migrations completed successfully!');
  } catch (err) {
    console.error('❌ Migration failed:', err.message);
  } finally {
    await pool.end();
  }
}

migrate();