const { Pool } = require('pg');
// moment-timezone (not plain moment) so `.tz(...)` works regardless of module
// load order — several methods here rely on it.
const moment = require('moment-timezone');

class DatabaseManager {
  constructor() {
    this.pool = null;
    this.ready = this.init();
  }

  async init() {
    try {
      // Parse DATABASE_URL manually to avoid URL encoding issues
      const dbUrl = process.env.DATABASE_URL || '';
      
      this.pool = new Pool({
        connectionString: dbUrl,
        ssl: {
          rejectUnauthorized: false
        },
        max: 2,
        idleTimeoutMillis: 60000,
        connectionTimeoutMillis: 15000,
        keepAlive: true
      });

      this.pool.on('error', (err) => {
        console.error('Database pool error:', err.message);
      });

      // Test connection with retry
      let connected = false;
      for (let attempt = 1; attempt <= 3; attempt++) {
        try {
          const client = await this.pool.connect();
          await client.query('SELECT 1');
          client.release();
          connected = true;
          console.log('✅ Connected to Supabase PostgreSQL');
          break;
        } catch (err) {
          console.error(`❌ Connection attempt ${attempt}/3 failed:`, err.message);
          if (attempt < 3) await new Promise(r => setTimeout(r, 2000));
        }
      }

      if (!connected) {
        throw new Error('Could not connect to database after 3 attempts');
      }
    } catch (err) {
      console.error('❌ Database initialization failed:', err.message);
      throw err;
    }
  }

  async query(sql, params = []) {
    try {
      const result = await this.pool.query(sql, params);
      return result;
    } catch (err) {
      // Try to reconnect once
      console.error('Query error, reconnecting...', err.message);
      await this.init();
      const result = await this.pool.query(sql, params);
      return result;
    }
  }

  async queryAll(sql, params = []) {
    const result = await this.query(sql, params);
    return result.rows;
  }

  async queryOne(sql, params = []) {
    const result = await this.query(sql, params);
    return result.rows.length > 0 ? result.rows[0] : null;
  }

  async run(sql, params = []) {
    await this.query(sql, params);
  }

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

  // ===== Group / membership tracking =====

  async registerGroup(chatId, title) {
    await this.run(`
      INSERT INTO groups (chat_id, title, is_active) VALUES ($1, $2, 1)
      ON CONFLICT (chat_id) DO UPDATE SET title = EXCLUDED.title, is_active = 1
    `, [chatId, title || null]);
  }

  async getAllGroups() {
    return this.queryAll('SELECT * FROM groups WHERE is_active = 1');
  }

  // Quiet mode: when on, the bot doesn't confirm submissions or post the daily
  // topic in this chat (it still warns about invalid recordings).
  async isQuiet(chatId) {
    const row = await this.queryOne('SELECT quiet FROM chat_settings WHERE chat_id = $1', [chatId]);
    return !!(row && row.quiet === 1);
  }

  async setQuiet(chatId, on) {
    await this.run(`
      INSERT INTO chat_settings (chat_id, quiet) VALUES ($1, $2)
      ON CONFLICT (chat_id) DO UPDATE SET quiet = EXCLUDED.quiet
    `, [chatId, on ? 1 : 0]);
  }

  async registerGroupMember(chatId, telegramId) {
    await this.run(`
      INSERT INTO group_members (chat_id, telegram_id, is_active) VALUES ($1, $2, 1)
      ON CONFLICT (chat_id, telegram_id) DO UPDATE SET is_active = 1
    `, [chatId, telegramId]);
  }

  async removeGroupMember(chatId, telegramId) {
    await this.run(
      'UPDATE group_members SET is_active = 0 WHERE chat_id = $1 AND telegram_id = $2',
      [chatId, telegramId]
    );
  }

  // Active members of a scope. For a group this is its tracked members; for a
  // private chat (chat_id > 0, equal to the user's id) it's just that user.
  async getScopeMembers(chatId) {
    return this.queryAll(`
      SELECT u.* FROM users u
      JOIN (
        SELECT telegram_id FROM group_members WHERE chat_id = $1 AND is_active = 1
        UNION
        SELECT $1::bigint AS telegram_id WHERE $1 > 0
      ) m ON u.telegram_id = m.telegram_id
      WHERE u.is_active = 1
    `, [chatId]);
  }

  // Users who have at least one submission in their own 1:1 chat.
  async getPrivateParticipants() {
    return this.queryAll(`
      SELECT u.* FROM users u
      WHERE u.is_active = 1
        AND EXISTS (
          SELECT 1 FROM submissions s
          WHERE s.user_id = u.telegram_id AND s.chat_id = u.telegram_id AND s.is_valid = 1
        )
    `);
  }

  async recordSubmission(userId, chatId, fileId, fileType, duration, caption, date) {
    const timezone = process.env.TIMEZONE || 'Asia/Saigon';
    const today = moment().tz(timezone).format('YYYY-MM-DD');

    const existing = await this.queryOne(
      'SELECT id FROM submissions WHERE user_id = $1 AND chat_id = $2 AND submission_date = $3 AND is_valid = 1',
      [userId, chatId, date]
    );

    if (existing) {
      return { success: false, message: `You already have a recording for ${date}!` };
    }

    await this.run(
      'INSERT INTO submissions (user_id, chat_id, submission_date, file_id, file_type, duration, caption) VALUES ($1, $2, $3, $4, $5, $6, $7)',
      [userId, chatId, date, fileId, fileType, duration || 0, caption || null]
    );

    // Fines are NOT decided here. A missed day is only fined when the NEXT day is
    // also missed (the most recent miss always gets a one-day grace), so all
    // penalty assessment happens in the nightly deadline job. Submitting can only
    // ever avoid a fine, never cause one.
    return { success: true, message: 'Submission recorded successfully!' };
  }

  // True if the user has any valid submission in this scope strictly before `date`.
  // Used to avoid fining brand-new participants for days before they joined.
  async hasSubmissionBefore(userId, chatId, date) {
    const row = await this.queryOne(
      'SELECT 1 FROM submissions WHERE user_id = $1 AND chat_id = $2 AND submission_date < $3 AND is_valid = 1 LIMIT 1',
      [userId, chatId, date]
    );
    return !!row;
  }

  async penaltyExists(userId, chatId, penaltyDate) {
    const row = await this.queryOne(
      'SELECT 1 FROM penalties WHERE user_id = $1 AND chat_id = $2 AND penalty_date = $3 LIMIT 1',
      [userId, chatId, penaltyDate]
    );
    return !!row;
  }

  // Apply the fine rule for a single missed day `missedDate` in a scope:
  // fine it only if the user also missed the following day (`nextDate`), is an
  // established participant, and hasn't already been fined for that day.
  // Returns true if a new penalty was recorded.
  async assessMissedDay(userId, chatId, missedDate, nextDate) {
    const submittedMissed = await this.getSubmissionCountForDate(userId, chatId, missedDate);
    if (submittedMissed > 0) return false;               // they did submit that day
    const submittedNext = await this.getSubmissionCountForDate(userId, chatId, nextDate);
    if (submittedNext > 0) return false;                 // next-day submission grants grace
    if (!(await this.hasSubmissionBefore(userId, chatId, missedDate))) return false; // not yet active
    if (await this.penaltyExists(userId, chatId, missedDate)) return false;          // already fined
    await this.addPenalty(userId, chatId, missedDate, 'Missed daily submission (2-day rule)');
    return true;
  }

  async getTodaySubmissions(chatId, date) {
    return this.queryAll(`
      SELECT s.*, u.username, u.first_name, u.last_name
      FROM submissions s
      JOIN users u ON s.user_id = u.telegram_id
      WHERE s.chat_id = $1 AND s.submission_date = $2 AND s.is_valid = 1
      ORDER BY s.submitted_at ASC
    `, [chatId, date]);
  }

  async getUserSubmissions(userId, chatId, limit = 30) {
    return this.queryAll(`
      SELECT * FROM submissions
      WHERE user_id = $1 AND chat_id = $2 AND is_valid = 1
      ORDER BY submission_date DESC
      LIMIT $3
    `, [userId, chatId, limit]);
  }

  async getSubmissionsInRange(userId, chatId, startDate, endDate) {
    return this.queryAll(`
      SELECT submission_date::text as submission_date FROM submissions
      WHERE user_id = $1 AND chat_id = $2 AND submission_date >= $3 AND submission_date <= $4 AND is_valid = 1
      ORDER BY submission_date
    `, [userId, chatId, startDate, endDate]);
  }

  // Same range, but with the data the leaderboard score needs (duration + time).
  async getSubmissionsDetailInRange(userId, chatId, startDate, endDate) {
    return this.queryAll(`
      SELECT submission_date::text as submission_date, duration, submitted_at FROM submissions
      WHERE user_id = $1 AND chat_id = $2 AND submission_date >= $3 AND submission_date <= $4 AND is_valid = 1
      ORDER BY submission_date
    `, [userId, chatId, startDate, endDate]);
  }

  async getSubmissionCountForDate(userId, chatId, date) {
    const row = await this.queryOne(`
      SELECT COUNT(*) as count FROM submissions
      WHERE user_id = $1 AND chat_id = $2 AND submission_date = $3 AND is_valid = 1
    `, [userId, chatId, date]);
    return row ? parseInt(row.count) : 0;
  }

  async addPenalty(userId, chatId, penaltyDate, reason) {
    await this.run(
      'INSERT INTO penalties (user_id, chat_id, penalty_date, reason) VALUES ($1, $2, $3, $4)',
      [userId, chatId, penaltyDate, reason]
    );
  }

  async getUserPenalties(userId, chatId, limit = 20) {
    return this.queryAll(`
      SELECT * FROM penalties
      WHERE user_id = $1 AND chat_id = $2
      ORDER BY penalty_date DESC
      LIMIT $3
    `, [userId, chatId, limit]);
  }

  async getPenaltyCount(userId, chatId) {
    const row = await this.queryOne(
      'SELECT COUNT(*) as count FROM penalties WHERE user_id = $1 AND chat_id = $2',
      [userId, chatId]
    );
    return row ? parseInt(row.count) : 0;
  }

  async getUserStats(userId, chatId) {
    const totalSubmissions = await this.queryOne(`
      SELECT COUNT(*) as count FROM submissions
      WHERE user_id = $1 AND chat_id = $2 AND is_valid = 1
    `, [userId, chatId]);

    const count = totalSubmissions ? parseInt(totalSubmissions.count) : 0;
    const totalPenalties = await this.getPenaltyCount(userId, chatId);

    const lastSubmission = await this.queryOne(`
      SELECT submission_date::text as submission_date FROM submissions
      WHERE user_id = $1 AND chat_id = $2 AND is_valid = 1
      ORDER BY submission_date DESC LIMIT 1
    `, [userId, chatId]);

    const currentStreak = await this.calculateStreak(userId, chatId);

    return {
      totalSubmissions: count,
      totalPenalties,
      lastSubmission: lastSubmission ? lastSubmission.submission_date : null,
      currentStreak
    };
  }

  async calculateStreak(userId, chatId) {
    const submissions = await this.queryAll(`
      SELECT submission_date::text as submission_date, submitted_at FROM submissions
      WHERE user_id = $1 AND chat_id = $2 AND is_valid = 1
    `, [userId, chatId]);

    if (submissions.length === 0) return 0;

    const tz = process.env.TIMEZONE || 'Asia/Saigon';

    // Only days submitted ON that very day count toward the streak. A make-up
    // (sent on a later day, e.g. tagged 260617 but uploaded on the 18th) avoids
    // a fine but does NOT build streak — streak rewards daily submission.
    const onTime = new Set();
    for (const s of submissions) {
      if (!s.submitted_at) continue;
      const forDay = String(s.submission_date);
      const sentDay = moment(s.submitted_at).tz(tz).format('YYYY-MM-DD');
      if (sentDay === forDay) onTime.add(forDay);
    }
    if (onTime.size === 0) return 0;

    const today = moment().tz(tz).format('YYYY-MM-DD');
    const yesterday = moment().tz(tz).subtract(1, 'day').format('YYYY-MM-DD');

    // Anchor at today if done on time, otherwise yesterday (the grace day), so a
    // running streak isn't shown as 0 just because today isn't done yet.
    let expectedDate;
    if (onTime.has(today)) expectedDate = today;
    else if (onTime.has(yesterday)) expectedDate = yesterday;
    else return 0; // last on-time submission is older than yesterday → streak broken

    let streak = 0;
    while (onTime.has(expectedDate)) {
      streak++;
      expectedDate = moment(expectedDate).subtract(1, 'day').format('YYYY-MM-DD');
    }
    return streak;
  }

  // Members of a scope with their submission/penalty status for `today`.
  async getAllUsersWithTodayStatus(chatId, today) {
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
      JOIN (
        SELECT telegram_id FROM group_members WHERE chat_id = $1 AND is_active = 1
        UNION
        SELECT $1::bigint AS telegram_id WHERE $1 > 0
      ) m ON u.telegram_id = m.telegram_id
      LEFT JOIN submissions s ON u.telegram_id = s.user_id
        AND s.chat_id = $1 AND s.submission_date = $2 AND s.is_valid = 1
      LEFT JOIN penalties p ON u.telegram_id = p.user_id
        AND p.chat_id = $1 AND p.penalty_date = $2
      WHERE u.is_active = 1
      ORDER BY u.first_name ASC, u.username ASC
    `, [chatId, today]);
  }

  async close() {
    await this.pool.end();
  }
}

module.exports = DatabaseManager;