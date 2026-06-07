const { Pool } = require('pg');
const moment = require('moment');

class DatabaseManager {
  constructor() {
    this.pool = null;
    this.ready = this.init();
  }

  async init() {
    try {
      this.pool = new Pool({
        connectionString: process.env.DATABASE_URL,
        ssl: {
          rejectUnauthorized: false
        },
        max: 5,
        idleTimeoutMillis: 30000,
        connectionTimeoutMillis: 10000
      });

      // Handle pool errors
      this.pool.on('error', (err) => {
        console.error('Database pool error:', err.message);
      });

      // Test connection
      const client = await this.pool.connect();
      await client.query('SELECT 1');
      client.release();

      console.log('✅ Connected to Supabase PostgreSQL');
    } catch (err) {
      console.error('❌ Database connection failed:', err.message);
      console.error('   Check your DATABASE_URL in .env file');
      throw err;
    }
  }

  async getPool() {
    if (!this.pool) {
      await this.init();
    }
    return this.pool;
  }

  async queryAll(sql, params = []) {
    const pool = await this.getPool();
    const result = await pool.query(sql, params);
    return result.rows;
  }

  async queryOne(sql, params = []) {
    const pool = await this.getPool();
    const result = await pool.query(sql, params);
    return result.rows.length > 0 ? result.rows[0] : null;
  }

  async run(sql, params = []) {
    const pool = await this.getPool();
    await pool.query(sql, params);
  }

  // Register or get user
  async registerUser(telegramId, username, firstName, lastName) {
    const existing = await this.queryOne('SELECT * FROM users WHERE telegram_id = $1', [telegramId]);
    if (existing) {
      await this.run(
        'UPDATE users SET username = $1, first_name = $2, last_name = $3, is_active = 1 WHERE telegram_id = $4',
        [username, firstName, lastName, telegramId]
      );
    } else {
      await this.run(
        'INSERT INTO users (telegram_id, username, first_name, last_name) VALUES ($1, $2, $3, $4)',
        [telegramId, username, firstName, lastName]
      );
    }
  }

  async getUser(telegramId) {
    return this.queryOne('SELECT * FROM users WHERE telegram_id = $1', [telegramId]);
  }

  async getAllActiveUsers() {
    return this.queryAll('SELECT * FROM users WHERE is_active = 1');
  }

  async deactivateUser(telegramId) {
    await this.run('UPDATE users SET is_active = 0 WHERE telegram_id = $1', [telegramId]);
  }

  // Submission management
  async recordSubmission(userId, fileId, fileType, duration, caption, date) {
    // Check if already submitted today
    const existing = await this.queryOne(
      'SELECT id FROM submissions WHERE user_id = $1 AND submission_date = $2 AND is_valid = 1',
      [userId, date]
    );

    if (existing) {
      return { success: false, message: 'You have already submitted today!' };
    }

    await this.run(
      'INSERT INTO submissions (user_id, submission_date, file_id, file_type, duration, caption) VALUES ($1, $2, $3, $4, $5, $6)',
      [userId, date, fileId, fileType, duration || 0, caption || null]
    );

    return { success: true, message: 'Submission recorded successfully!' };
  }

  async getTodaySubmissions(date) {
    return this.queryAll(`
      SELECT s.*, u.username, u.first_name, u.last_name
      FROM submissions s
      JOIN users u ON s.user_id = u.telegram_id
      WHERE s.submission_date = $1 AND s.is_valid = 1
      ORDER BY s.submitted_at ASC
    `, [date]);
  }

  async getUserSubmissions(userId, limit = 30) {
    return this.queryAll(`
      SELECT * FROM submissions 
      WHERE user_id = $1 AND is_valid = 1
      ORDER BY submission_date DESC
      LIMIT $2
    `, [userId, limit]);
  }

  async getSubmissionsInRange(userId, startDate, endDate) {
    return this.queryAll(`
      SELECT submission_date FROM submissions
      WHERE user_id = $1 AND submission_date >= $2 AND submission_date <= $3 AND is_valid = 1
      ORDER BY submission_date
    `, [userId, startDate, endDate]);
  }

  async getSubmissionCountForDate(userId, date) {
    const row = await this.queryOne(`
      SELECT COUNT(*) as count FROM submissions
      WHERE user_id = $1 AND submission_date = $2 AND is_valid = 1
    `, [userId, date]);
    return row ? parseInt(row.count) : 0;
  }

  // Penalty management
  async addPenalty(userId, penaltyDate, reason) {
    await this.run(
      'INSERT INTO penalties (user_id, penalty_date, reason) VALUES ($1, $2, $3)',
      [userId, penaltyDate, reason]
    );
  }

  async getUserPenalties(userId, limit = 20) {
    return this.queryAll(`
      SELECT * FROM penalties 
      WHERE user_id = $1
      ORDER BY penalty_date DESC
      LIMIT $2
    `, [userId, limit]);
  }

  async getPenaltyCount(userId) {
    const row = await this.queryOne('SELECT COUNT(*) as count FROM penalties WHERE user_id = $1', [userId]);
    return row ? parseInt(row.count) : 0;
  }

  // Stats
  async getUserStats(userId) {
    const totalSubmissions = await this.queryOne(`
      SELECT COUNT(*) as count FROM submissions 
      WHERE user_id = $1 AND is_valid = 1
    `, [userId]);
    
    const count = totalSubmissions ? parseInt(totalSubmissions.count) : 0;
    const totalPenalties = await this.getPenaltyCount(userId);
    
    const lastSubmission = await this.queryOne(`
      SELECT submission_date FROM submissions 
      WHERE user_id = $1 AND is_valid = 1
      ORDER BY submission_date DESC LIMIT 1
    `, [userId]);

    const currentStreak = await this.calculateStreak(userId);

    return {
      totalSubmissions: count,
      totalPenalties,
      lastSubmission: lastSubmission ? lastSubmission.submission_date : null,
      currentStreak
    };
  }

  async calculateStreak(userId) {
    const submissions = await this.queryAll(`
      SELECT submission_date::text as submission_date FROM submissions
      WHERE user_id = $1 AND is_valid = 1
      ORDER BY submission_date DESC
    `, [userId]);

    if (submissions.length === 0) return 0;

    // Allow 1 grace day in streak (user can skip 1 day)
    let streak = 0;
    let expectedDate = moment().tz(process.env.TIMEZONE || 'Asia/Saigon').format('YYYY-MM-DD');
    let gracesUsed = 0;

    for (const sub of submissions) {
      const subDate = String(sub.submission_date);
      if (subDate === expectedDate) {
        streak++;
        expectedDate = moment(expectedDate).subtract(1, 'day').format('YYYY-MM-DD');
      } else if (subDate === moment(expectedDate).subtract(1, 'day').format('YYYY-MM-DD') && gracesUsed === 0) {
        // Grace day: skipped 1 day, but submitted the day before that
        streak++;
        gracesUsed = 1;
        expectedDate = moment(expectedDate).subtract(2, 'day').format('YYYY-MM-DD');
      } else {
        break;
      }
    }

    return streak;
  }

  // Admin: get all users with today's status
  async getAllUsersWithTodayStatus(today) {
    return this.queryAll(`
      SELECT 
        u.telegram_id,
        u.username,
        u.first_name,
        u.last_name,
        u.is_active,
        s.id as submission_id,
        s.file_id,
        s.file_type,
        s.duration,
        s.submitted_at,
        p.id as penalty_id
      FROM users u
      LEFT JOIN submissions s ON u.telegram_id = s.user_id 
        AND s.submission_date = $1 AND s.is_valid = 1
      LEFT JOIN penalties p ON u.telegram_id = p.user_id 
        AND p.penalty_date = $2
      WHERE u.is_active = 1
      ORDER BY u.first_name ASC, u.username ASC
    `, [today, today]);
  }

  async close() {
    await this.pool.end();
  }
}

module.exports = DatabaseManager;