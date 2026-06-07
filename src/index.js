require('dotenv').config();
const TelegramBot = require('node-telegram-bot-api');
const cron = require('node-cron');
const moment = require('moment-timezone');
const DatabaseManager = require('./database');
const http = require('http');

// Configuration
const TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const ADMIN_IDS = (process.env.ADMIN_IDS || '').split(',').map(id => parseInt(id.trim())).filter(id => !isNaN(id));
const TIMEZONE = process.env.TIMEZONE || 'Asia/Saigon';
const PORT = process.env.PORT || 10000;

if (!TOKEN) {
  console.error('ERROR: TELEGRAM_BOT_TOKEN is not set in .env file!');
  process.exit(1);
}

// Helper functions
function isAdmin(telegramId) {
  return ADMIN_IDS.includes(telegramId);
}

function getToday() {
  return moment().tz(TIMEZONE).format('YYYY-MM-DD');
}

function getDeadlineTime() {
  const hour = parseInt(process.env.DEADLINE_HOUR) || 23;
  const minute = parseInt(process.env.DEADLINE_MINUTE) || 59;
  return `${hour.toString().padStart(2, '0')}:${minute.toString().padStart(2, '0')}`;
}

function formatUserDisplay(user) {
  if (!user) return 'Unknown';
  if (user.first_name || user.last_name) {
    return `${user.first_name || ''} ${user.last_name || ''}`.trim() + (user.username ? ` (@${user.username})` : '');
  }
  return user.username ? `@${user.username}` : `User #${user.telegram_id}`;
}

function validateSubmission(msg) {
  const voice = msg.voice;
  const video = msg.video;
  const videoNote = msg.video_note;
  const audio = msg.audio;
  const document = msg.document;

  let fileId = null;
  let fileType = null;
  let duration = 0;

  if (voice) {
    fileId = voice.file_id;
    fileType = 'voice';
    duration = voice.duration;
  } else if (video) {
    fileId = video.file_id;
    fileType = 'video';
    duration = video.duration;
  } else if (videoNote) {
    fileId = videoNote.file_id;
    fileType = 'video_note';
    duration = videoNote.duration;
  } else if (audio) {
    fileId = audio.file_id;
    fileType = 'audio';
    duration = audio.duration;
  } else if (document) {
    const mimeType = document.mime_type || '';
    if (mimeType.startsWith('audio/')) {
      fileId = document.file_id;
      fileType = 'document_audio';
      duration = 0;
    }
  }

  const minDuration = 300; // 5 minutes (300 seconds)
  if (fileId && (duration >= minDuration || duration === 0)) {
    return { valid: true, fileId, fileType, duration };
  }

  if (fileId && duration > 0 && duration < minDuration) {
    return {
      valid: false,
      reason: `Your recording is only ${Math.floor(duration / 60)}m ${duration % 60}s long. Minimum required is 5 minutes!`
    };
  }

  return { valid: false, reason: 'no_media' };
}

// Create HTTP server for Render health checks
const server = http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.end('Daily English Bot is running!\n');
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`🌐 Health check server listening on port ${PORT}`);
});

async function startBot() {
  const db = new DatabaseManager();
  await db.ready;

  const bot = new TelegramBot(TOKEN, { polling: true });

  console.log(`🤖 Daily English Bot started!`);
  console.log(`📍 Timezone: ${TIMEZONE}`);
  console.log(`👤 Admins: ${ADMIN_IDS.length > 0 ? ADMIN_IDS.join(', ') : 'None configured'}`);

  // ===== COMMAND HANDLERS =====

  // Start command
  bot.onText(/\/start/, async (msg) => {
    try {
      const chatId = msg.chat.id;
      const userId = msg.from.id;
      const username = msg.from.username || null;
      const firstName = msg.from.first_name || null;
      const lastName = msg.from.last_name || null;

      await db.registerUser(userId, username, firstName, lastName);

      const welcomeMsg = `
🎯 *Daily English Bot* 🎯

Welcome ${firstName || 'there'}! I'm here to help you track your daily English practice.

*How it works:*
🎤 Record yourself speaking English for *at least 5 minutes* every day
📤 Send the recording here (voice, video, or audio)
✅ I'll automatically track your submissions
📊 Check your progress with /mystats

*Commands:*
/start - Show this welcome message
/submit - How to submit your recording
/mystats - View your personal statistics
/streak - Check your current streak
/history - View your recent submissions
/leaderboard - View the submission leaderboard
/help - Show all commands

*Deadline:* ${getDeadlineTime()} daily
*Minimum:* 5 minutes per recording

Let's practice English every day! 🚀
`;

      await bot.sendMessage(chatId, welcomeMsg, { parse_mode: 'Markdown' });
    } catch (err) {
      console.error('Error in /start:', err.message);
    }
  });

  // Get my Telegram ID
  bot.onText(/\/myid/, async (msg) => {
    try {
      const chatId = msg.chat.id;
      const userId = msg.from.id;
      await bot.sendMessage(chatId, `🆔 Your Telegram User ID: \`${userId}\``, { parse_mode: 'Markdown' });
    } catch (err) {
      console.error('Error in /myid:', err.message);
    }
  });

  // Submit instructions
  bot.onText(/\/submit/, async (msg) => {
    try {
      const chatId = msg.chat.id;
      await bot.sendMessage(chatId, `
🎤 *How to Submit Your Daily Recording*

Simply *send a voice message, video, or audio file* in this chat!

*Requirements:*
⏱ Minimum *5 minutes* long
🗣 Speak in English
📅 One submission per day

*Tips:*
• Talk about your day
• Describe a picture
• Summarize news/articles
• Practice a presentation
• Just speak freely!

Send your recording now! 🚀
`, { parse_mode: 'Markdown' });
    } catch (err) {
      console.error('Error in /submit:', err.message);
    }
  });

  // My Stats
  bot.onText(/\/mystats/, async (msg) => {
    try {
      const chatId = msg.chat.id;
      const userId = msg.from.id;

      await db.registerUser(userId, msg.from.username, msg.from.first_name, msg.from.last_name);
      const stats = await db.getUserStats(userId);
      const user = await db.getUser(userId);

      const startOfMonth = moment().tz(TIMEZONE).startOf('month').format('YYYY-MM-DD');
      const endOfMonth = moment().tz(TIMEZONE).endOf('month').format('YYYY-MM-DD');
      const monthSubmissions = await db.getSubmissionsInRange(userId, startOfMonth, endOfMonth);

      const statsMsg = `
📊 *Your Statistics* 📊

👤 *${formatUserDisplay(user)}*

📅 Total Submissions: *${stats.totalSubmissions}*
🔥 Current Streak: *${stats.currentStreak} day(s)*
📆 This Month: *${monthSubmissions.length} submissions*
⚠️ Penalties: *${stats.totalPenalties}*
${stats.lastSubmission ? `\n✅ Last submission: \`${stats.lastSubmission}\`` : '\n❌ No submissions yet'}

Keep up the great work! 💪
`;

      await bot.sendMessage(chatId, statsMsg, { parse_mode: 'Markdown' });
    } catch (err) {
      console.error('Error in /mystats:', err.message);
    }
  });

  // Streak
  bot.onText(/\/streak/, async (msg) => {
    try {
      const chatId = msg.chat.id;
      const userId = msg.from.id;

      const streak = await db.calculateStreak(userId);

      let message = '';
      if (streak === 0) {
        message = `You don't have an active streak yet. Submit your first recording today! 🎤`;
      } else if (streak === 1) {
        message = `🔥 You have a 1-day streak! Keep going! Day 2 awaits!`;
      } else if (streak < 7) {
        message = `🔥 *${streak}-day streak!* You're building a great habit! Keep it up!`;
      } else if (streak < 30) {
        message = `🔥🔥 *${streak}-day streak!* Amazing consistency! You're on fire!`;
      } else {
        message = `🔥🔥🔥 *${streak}-day streak!* INCREDIBLE! You're a true champion! 🏆`;
      }

      await bot.sendMessage(chatId, message, { parse_mode: 'Markdown' });
    } catch (err) {
      console.error('Error in /streak:', err.message);
    }
  });

  // History
  bot.onText(/\/history/, async (msg) => {
    try {
      const chatId = msg.chat.id;
      const userId = msg.from.id;

      const submissions = await db.getUserSubmissions(userId, 15);

      if (submissions.length === 0) {
        await bot.sendMessage(chatId, '📭 No submissions found. Start by sending your first recording!');
        return;
      }

      let historyMsg = `📋 *Your Recent Submissions*\n\n`;
      submissions.forEach((sub, index) => {
        const date = moment(sub.submission_date).format('MMM D, YYYY');
        const time = sub.submitted_at ? moment(sub.submitted_at).format('HH:mm') : '--:--';
        const duration = sub.duration > 0 ? `${Math.floor(sub.duration / 60)}m ${sub.duration % 60}s` : 'N/A';
        const type = sub.file_type === 'voice' ? '🎤' : sub.file_type === 'video' ? '📹' : '🎵';
        historyMsg += `${index + 1}. ${type} ${date} at ${time} (${duration})\n`;
      });

      await bot.sendMessage(chatId, historyMsg, { parse_mode: 'Markdown' });
    } catch (err) {
      console.error('Error in /history:', err.message);
    }
  });

  // Leaderboard
  bot.onText(/\/leaderboard/, async (m) => {
    try {
      const chatId = m.chat.id;
      const users = await db.getAllActiveUsers();
      const today = getToday();
      const startOfMonth = moment().tz(TIMEZONE).startOf('month').format('YYYY-MM-DD');
      const endOfMonth = moment().tz(TIMEZONE).endOf('month').format('YYYY-MM-DD');

      const userStats = [];
      for (const user of users) {
        const monthSubs = await db.getSubmissionsInRange(user.telegram_id, startOfMonth, endOfMonth);
        const streak = await db.calculateStreak(user.telegram_id);
        userStats.push({ ...user, monthCount: monthSubs.length, streak });
      }

      userStats.sort((a, b) => b.monthCount - a.monthCount || b.streak - a.streak);

      const todaySubmissions = await db.getTodaySubmissions(today);

      let leaderboardMsg = `🏆 *Leaderboard - ${moment().tz(TIMEZONE).format('MMMM YYYY')}* 🏆\n\n`;
      leaderboardMsg += `📅 Today: ${todaySubmissions.length}/${users.length} submitted\n\n`;

      const medals = ['🥇', '🥈', '🥉'];
      userStats.forEach((user, index) => {
        const rank = index < 3 ? medals[index] : `${index + 1}.`;
        const name = user.first_name || user.username || `User ${user.telegram_id}`;
        let line = `${rank} *${name}* - ${user.monthCount} this month`;
        if (user.streak > 0) line += ` 🔥${user.streak}d`;
        if (index === 0 && user.monthCount > 0) line += ' 👑';
        leaderboardMsg += `${line}\n`;
      });

      if (userStats.length === 0) {
        leaderboardMsg += '\nNo registered users yet!';
      }

      await bot.sendMessage(chatId, leaderboardMsg, { parse_mode: 'Markdown' });
    } catch (err) {
      console.error('Error in /leaderboard:', err.message);
    }
  });

  // Help
  bot.onText(/\/help/, async (msg) => {
    try {
      const chatId = msg.chat.id;
      const userId = msg.from.id;

      let helpMsg = `
📚 *Available Commands*

*For everyone:*
/start - Welcome message & intro
/submit - How to submit recordings
/mystats - Your personal statistics
/streak - Check your current streak
/history - View recent submissions
/leaderboard - Monthly leaderboard
/help - Show this message

${isAdmin(userId) ? `
*Admin commands:*
/admin - Show admin panel
/status - Today's submission status
/report - Full daily report
/check - Check who hasn't submitted
/deadline - Set deadline time
/broadcast - Send message to all users
` : ''}

*How to submit:*
Just send a voice message, video, or audio file of at least 5 minutes!

*Deadline:* ${getDeadlineTime()} daily
`;

      await bot.sendMessage(chatId, helpMsg, { parse_mode: 'Markdown' });
    } catch (err) {
      console.error('Error in /help:', err.message);
    }
  });

  // ===== ADMIN COMMANDS =====

  // Admin panel
  bot.onText(/\/admin/, async (msg) => {
    try {
      const chatId = msg.chat.id;
      const userId = msg.from.id;

      if (!isAdmin(userId)) {
        await bot.sendMessage(chatId, '⛔ You are not authorized to use admin commands.');
        return;
      }

      const adminMsg = `
🔧 Admin Panel

/status - Today's submission status
/report - Full daily report with stats
/check - Users who haven't submitted
/penalty [user_id] - Add penalty to user
/broadcast [message] - Broadcast to all users
/setdeadline HH:MM - Set deadline time
`;

      await bot.sendMessage(chatId, adminMsg);
    } catch (err) {
      console.error('Error in /admin:', err.message);
    }
  });

  // Today's status (admin)
  bot.onText(/\/status/, async (msg) => {
    try {
      const chatId = msg.chat.id;
      const userId = msg.from.id;

      if (!isAdmin(userId)) {
        await bot.sendMessage(chatId, '⛔ Not authorized.');
        return;
      }

      const today = getToday();
      const usersStatus = await db.getAllUsersWithTodayStatus(today);

      const submitted = usersStatus.filter(u => u.submission_id);
      const notSubmitted = usersStatus.filter(u => !u.submission_id);

      let statusMsg = `📊 *Today's Status - ${today}*\n\n`;
      statusMsg += `✅ Submitted: *${submitted.length}/${usersStatus.length}*\n`;
      statusMsg += `❌ Missing: *${notSubmitted.length}/${usersStatus.length}*\n\n`;

      if (submitted.length > 0) {
        statusMsg += `*✅ Submitted:*\n`;
        submitted.forEach(u => {
          const name = u.first_name || u.username || `User ${u.telegram_id}`;
          const time = u.submitted_at ? moment(u.submitted_at).format('HH:mm') : '--:--';
          const duration = u.duration > 0 ? `(${Math.floor(u.duration / 60)}m ${u.duration % 60}s)` : '';
          const type = u.file_type === 'voice' ? '🎤' : u.file_type === 'video' ? '📹' : '🎵';
          statusMsg += `${type} ${name} - ${time} ${duration}\n`;
        });
        statusMsg += '\n';
      }

      if (notSubmitted.length > 0) {
        statusMsg += `*❌ Not Submitted:*\n`;
        notSubmitted.forEach(u => {
          const name = u.first_name || u.username || `User ${u.telegram_id}`;
          statusMsg += `• ${name}\n`;
        });
      }

      await bot.sendMessage(chatId, statusMsg, { parse_mode: 'Markdown' });
    } catch (err) {
      console.error('Error in /status:', err.message);
    }
  });

  // Full report
  bot.onText(/\/report/, async (msg) => {
    try {
      const chatId = msg.chat.id;
      const userId = msg.from.id;

      if (!isAdmin(userId)) {
        await bot.sendMessage(chatId, '⛔ Not authorized.');
        return;
      }

      const today = getToday();
      const usersStatus = await db.getAllUsersWithTodayStatus(today);
      const allUsers = await db.getAllActiveUsers();

      const submitted = usersStatus.filter(u => u.submission_id);
      const notSubmitted = usersStatus.filter(u => !u.submission_id);

      const startOfMonth = moment().tz(TIMEZONE).startOf('month').format('YYYY-MM-DD');
      const endOfMonth = moment().tz(TIMEZONE).endOf('month').format('YYYY-MM-DD');
      const daysInMonth = moment().tz(TIMEZONE).date();

      let reportMsg = `📋 *Daily Report - ${today}*\n`;
      reportMsg += `━━━━━━━━━━━━━━━━\n\n`;

      reportMsg += `📊 *Overall:*\n`;
      reportMsg += `Total Users: *${allUsers.length}*\n`;
      reportMsg += `Submitted: *${submitted.length}*\n`;
      reportMsg += `Pending: *${notSubmitted.length}*\n`;
      reportMsg += `Rate: *${allUsers.length > 0 ? Math.round(submitted.length / allUsers.length * 100) : 0}%*\n\n`;

      if (submitted.length > 0) {
        reportMsg += `*✅ Completed (${submitted.length}):*\n`;
        submitted.forEach((u, i) => {
          const name = u.first_name || u.username || `User ${u.telegram_id}`;
          const time = u.submitted_at ? moment(u.submitted_at).format('HH:mm') : '--:--';
          reportMsg += `  ${i + 1}. ${name} ✅ ${time}\n`;
        });
        reportMsg += '\n';
      }

      if (notSubmitted.length > 0) {
        reportMsg += `*❌ Missing (${notSubmitted.length}):* — NEEDS PENALTY\n`;
        notSubmitted.forEach((u, i) => {
          const name = u.first_name || u.username || `User ${u.telegram_id}`;
          reportMsg += `  ${i + 1}. ${name}\n`;
        });
        reportMsg += '\n';
      }

      reportMsg += `*📆 Monthly Summary (Days ${daysInMonth}):*\n`;
      const sortedUsers = [];
      for (const u of allUsers) {
        const monthSubs = await db.getSubmissionsInRange(u.telegram_id, startOfMonth, endOfMonth);
        const penalties = await db.getUserPenalties(u.telegram_id);
        const monthPenalties = penalties.filter(p => p.penalty_date >= startOfMonth && p.penalty_date <= endOfMonth);
        const streak = await db.calculateStreak(u.telegram_id);
        sortedUsers.push({ ...u, monthCount: monthSubs.length, penaltyCount: monthPenalties.length, streak });
      }
      sortedUsers.sort((a, b) => b.monthCount - a.monthCount);

      sortedUsers.forEach((u, i) => {
        const name = u.first_name || u.username || `User ${u.telegram_id}`;
        const missed = daysInMonth - u.monthCount;
        reportMsg += `  ${i + 1}. ${name}: ${u.monthCount}/${daysInMonth}`;
        if (u.streak > 0) reportMsg += ` 🔥${u.streak}d`;
        if (missed > 0) reportMsg += ` ❌${missed}`;
        if (u.penaltyCount > 0) reportMsg += ` ⚠️${u.penaltyCount}`;
        reportMsg += '\n';
      });

      await bot.sendMessage(chatId, reportMsg, { parse_mode: 'Markdown' });
    } catch (err) {
      console.error('Error in /report:', err.message);
    }
  });

  // Check missing users
  bot.onText(/\/check/, async (msg) => {
    try {
      const chatId = msg.chat.id;
      const userId = msg.from.id;

      if (!isAdmin(userId)) {
        await bot.sendMessage(chatId, '⛔ Not authorized.');
        return;
      }

      const today = getToday();
      const usersStatus = await db.getAllUsersWithTodayStatus(today);
      const notSubmitted = usersStatus.filter(u => !u.submission_id);

      if (notSubmitted.length === 0) {
        await bot.sendMessage(chatId, '🎉 *Everyone has submitted today!* Great job!', { parse_mode: 'Markdown' });
        return;
      }

      let checkMsg = `❌ ${notSubmitted.length} users haven't submitted yet today:\n\n`;
      notSubmitted.forEach((u, i) => {
        const name = formatUserDisplay(u);
        checkMsg += `${i + 1}. ${name}\n`;
      });

      checkMsg += `\nDeadline: ${getDeadlineTime()}`;
      await bot.sendMessage(chatId, checkMsg, { parse_mode: 'Markdown' });
    } catch (err) {
      console.error('Error in /check:', err.message);
    }
  });

  // Add penalty (admin)
  bot.onText(/\/penalty(?:\s+(\d+))?/, async (msg, match) => {
    try {
      const chatId = msg.chat.id;
      const userId = msg.from.id;

      if (!isAdmin(userId)) {
        await bot.sendMessage(chatId, '⛔ Not authorized.');
        return;
      }

      const targetUserId = match[1] ? parseInt(match[1]) : null;

      if (!targetUserId) {
        const today = getToday();
        const usersStatus = await db.getAllUsersWithTodayStatus(today);
        const notSubmitted = usersStatus.filter(u => !u.submission_id);

        if (notSubmitted.length === 0) {
          await bot.sendMessage(chatId, '✅ Everyone has submitted. No penalties needed!');
          return;
        }

        let penaltyMsg = `Add penalty by replying with user ID:\n/penalty <user_id>\n\nPending users:\n`;
        notSubmitted.forEach((u, i) => {
          const name = formatUserDisplay(u);
          penaltyMsg += `${i + 1}. ID: \`${u.telegram_id}\` - ${name}\n`;
        });
        await bot.sendMessage(chatId, penaltyMsg, { parse_mode: 'Markdown' });
        return;
      }

      const user = await db.getUser(targetUserId);
      if (!user) {
        await bot.sendMessage(chatId, `❌ User ${targetUserId} not found.`);
        return;
      }

      const today = getToday();
      await db.addPenalty(targetUserId, today, 'Missed daily submission');

      const name = formatUserDisplay(user);
      await bot.sendMessage(chatId, `⚠️ Penalty added to ${name} for missing today's submission.`);
    } catch (err) {
      console.error('Error in /penalty:', err.message);
    }
  });

  // Broadcast message
  bot.onText(/\/broadcast(?:\s+(.+))?/, async (msg, match) => {
    try {
      const chatId = msg.chat.id;
      const userId = msg.from.id;

      if (!isAdmin(userId)) {
        await bot.sendMessage(chatId, '⛔ Not authorized.');
        return;
      }

      const message = match[1];

      if (!message) {
        await bot.sendMessage(chatId, 'Usage: /broadcast <message>\nExample: /broadcast Reminder: Please submit your recording today!');
        return;
      }

      const users = await db.getAllActiveUsers();
      let sent = 0;
      let failed = 0;

      for (const user of users) {
        try {
          await bot.sendMessage(user.telegram_id, `📢 *Broadcast:*\n\n${message}`, { parse_mode: 'Markdown' });
          sent++;
        } catch (err) {
          failed++;
        }
      }

      await bot.sendMessage(chatId, `📢 Broadcast sent!\n✅ Sent: ${sent}\n❌ Failed: ${failed}\n👥 Total: ${users.length}`);
    } catch (err) {
      console.error('Error in /broadcast:', err.message);
    }
  });

  // Set deadline
  bot.onText(/\/setdeadline\s+(\d{1,2}):(\d{2})/, async (msg, match) => {
    try {
      const chatId = msg.chat.id;
      const userId = msg.from.id;

      if (!isAdmin(userId)) {
        await bot.sendMessage(chatId, '⛔ Not authorized.');
        return;
      }

      const hour = parseInt(match[1]);
      const minute = parseInt(match[2]);

      if (hour < 0 || hour > 23 || minute < 0 || minute > 59) {
        await bot.sendMessage(chatId, '❌ Invalid time. Use HH:MM format (e.g., 23:59)');
        return;
      }

      process.env.DEADLINE_HOUR = hour.toString();
      process.env.DEADLINE_MINUTE = minute.toString();

      await bot.sendMessage(chatId, `⏰ Deadline updated to ${hour.toString().padStart(2, '0')}:${minute.toString().padStart(2, '0')} (will reset on restart)`);
    } catch (err) {
      console.error('Error in /setdeadline:', err.message);
    }
  });

  // ===== MEDIA HANDLERS (Recordings) =====

  async function handleMediaSubmission(msg) {
    try {
      const chatId = msg.chat.id;
      const userId = msg.from.id;
      const username = msg.from.username || null;
      const firstName = msg.from.first_name || null;
      const lastName = msg.from.last_name || null;

      await db.registerUser(userId, username, firstName, lastName);

      const validation = validateSubmission(msg);

      if (!validation.valid) {
        if (validation.reason === 'no_media') {
          return;
        }
        await bot.sendMessage(chatId, `❌ ${validation.reason}\n\nPlease send a recording of at least 5 minutes.`);
        return;
      }

      const today = getToday();
      const result = await db.recordSubmission(
        userId,
        validation.fileId,
        validation.fileType,
        validation.duration,
        msg.caption || null,
        today
      );

      if (result.success) {
        const durationStr = validation.duration > 0
          ? `(${Math.floor(validation.duration / 60)}m ${validation.duration % 60}s)`
          : '';

        const streak = await db.calculateStreak(userId);
        let streakMsg = '';
        if (streak > 0) {
          if (streak === 1) streakMsg = '\n🔥 Streak started! Day 1!';
          else if (streak < 7) streakMsg = `\n🔥 ${streak}-day streak!`;
          else streakMsg = `\n🔥🔥 ${streak}-day streak! Amazing!`;
        }

        const typeEmoji = validation.fileType === 'voice' ? '🎤' :
                          validation.fileType === 'video' ? '📹' : '🎵';

        await bot.sendMessage(chatId,
          `✅ *Submission Recorded!* ${typeEmoji}\n` +
          `📅 ${today}\n` +
          `⏱ ${durationStr}${streakMsg}\n\n` +
          `Keep up the great work! 🚀\n` +
          `Check your stats with /mystats`,
          { parse_mode: 'Markdown' }
        );

        const user = await db.getUser(userId);
        const userName = formatUserDisplay(user);
        for (const adminId of ADMIN_IDS) {
          try {
            await bot.sendMessage(adminId,
              `✅ *Submission Received*\n👤 ${userName}\n📅 ${today}\n⏱ ${durationStr}${streakMsg}`,
              { parse_mode: 'Markdown' }
            );
          } catch (e) {}
        }
      } else {
        await bot.sendMessage(chatId, `⚠️ ${result.message}\n\nYou can view your stats with /mystats`);
      }
    } catch (err) {
      console.error('Error in handleMediaSubmission:', err.message);
    }
  }

  bot.on('voice', (msg) => handleMediaSubmission(msg));
  bot.on('video', (msg) => handleMediaSubmission(msg));
  bot.on('video_note', (msg) => handleMediaSubmission(msg));
  bot.on('audio', (msg) => handleMediaSubmission(msg));
  bot.on('document', (msg) => handleMediaSubmission(msg));

  // ===== SCHEDULED TASKS =====

  // Reminder at 22:00 (10 PM) daily
  cron.schedule('0 22 * * *', async () => {
    try {
      const today = getToday();
      const usersStatus = await db.getAllUsersWithTodayStatus(today);
      const notSubmitted = usersStatus.filter(u => !u.submission_id);

      if (notSubmitted.length === 0) return;

      for (const u of notSubmitted) {
        const name = u.first_name || 'there';
        try {
          await bot.sendMessage(u.telegram_id,
            `⏰ *Reminder!*\n\nHey ${name}! Don't forget to submit your daily English recording today! 🎤\n\nDeadline: ${getDeadlineTime()}\n\nSend your recording now! 🚀`,
            { parse_mode: 'Markdown' }
          );
        } catch (e) {}
      }

      const names = notSubmitted.map(u => u.first_name || u.username || `User ${u.telegram_id}`).join(', ');
      for (const adminId of ADMIN_IDS) {
        try {
          await bot.sendMessage(adminId,
            `⏰ *Reminder sent to ${notSubmitted.length} users*\n\nPending: ${names}`,
            { parse_mode: 'Markdown' }
          );
        } catch (e) {}
      }
    } catch (err) {
      console.error('Error in reminder cron:', err.message);
    }
  });

  // Deadline alert at 23:59
  cron.schedule('59 23 * * *', async () => {
    try {
      const today = getToday();
      const usersStatus = await db.getAllUsersWithTodayStatus(today);
      const notSubmitted = usersStatus.filter(u => !u.submission_id);

      if (notSubmitted.length === 0) {
        for (const adminId of ADMIN_IDS) {
          try {
            await bot.sendMessage(adminId,
              `🎉 *All clear!* Everyone submitted today!\n📅 ${today}`,
              { parse_mode: 'Markdown' }
            );
          } catch (e) {}
        }
        return;
      }

      let reportMsg = `⛔ *Deadline Reached - ${today}*\n\n`;
      reportMsg += `Missing submissions: *${notSubmitted.length}*\n\n`;
      reportMsg += `*Need to add penalties:*\n`;
      notSubmitted.forEach((u, i) => {
        const name = formatUserDisplay(u);
        reportMsg += `${i + 1}. ${name}\n`;
        reportMsg += `   -> Use: /penalty ${u.telegram_id}\n`;
      });

      for (const adminId of ADMIN_IDS) {
        try {
          await bot.sendMessage(adminId, reportMsg, { parse_mode: 'Markdown' });
        } catch (e) {}
      }

      for (const u of notSubmitted) {
        const name = u.first_name || 'there';
        try {
          await bot.sendMessage(u.telegram_id,
            `⛔ *Deadline Missed!*\n\nHey ${name}, you didn't submit your English recording today.\n\nDon't worry - start fresh tomorrow! Every day is a new opportunity! 💪`,
            { parse_mode: 'Markdown' }
          );
        } catch (e) {}
      }
    } catch (err) {
      console.error('Error in deadline cron:', err.message);
    }
  });

  // Morning motivation at 7:00
  cron.schedule('0 7 * * *', async () => {
    try {
      const users = await db.getAllActiveUsers();
      const messages = [
        '🌅 Good morning! Ready to practice your English today? 🎤',
        '☀️ New day, new opportunity! Don\'t forget your English recording! 🚀',
        '🌄 Rise and shine! Your English practice awaits! Send your recording today! 💪',
        '🌟 Good morning! Make today count with your English practice! 🎯',
        '🌞 Start your day strong! Record your English practice now! 🔥'
      ];

      const message = messages[Math.floor(Math.random() * messages.length)];

      for (const user of users) {
        try {
          await bot.sendMessage(user.telegram_id, message);
        } catch (e) {}
      }
    } catch (err) {
      console.error('Error in morning cron:', err.message);
    }
  });

  // Weekly summary on Sunday at 20:00
  cron.schedule('0 20 * * 0', async () => {
    try {
      const users = await db.getAllActiveUsers();
      const endDate = getToday();
      const startDate = moment().tz(TIMEZONE).subtract(7, 'days').format('YYYY-MM-DD');

      for (const user of users) {
        const weekSubs = await db.getSubmissionsInRange(user.telegram_id, startDate, endDate);
        const streak = await db.calculateStreak(user.telegram_id);
        const name = user.first_name || 'there';

        let msg = `📊 *Weekly Summary*\n\n`;
        msg += `Hey ${name}! Here's your progress this week:\n\n`;
        msg += `📅 Submissions: ${weekSubs.length}/7 days\n`;
        msg += `🔥 Current streak: ${streak} day(s)\n\n`;

        if (weekSubs.length >= 5) {
          msg += `🌟 Great job this week! Keep it up! 🚀`;
        } else if (weekSubs.length >= 3) {
          msg += `💪 Good effort! Try to be more consistent next week!`;
        } else {
          msg += `📈 Let's aim for more submissions next week! You can do it! 💪`;
        }

        try {
          await bot.sendMessage(user.telegram_id, msg, { parse_mode: 'Markdown' });
        } catch (e) {}
      }
    } catch (err) {
      console.error('Error in weekly cron:', err.message);
    }
  });

  // Error handling
  bot.on('polling_error', (error) => {
    console.error('Polling error:', error.code, error.message);
  });

  bot.on('error', (error) => {
    console.error('Bot error:', error.code, error.message);
  });

  // Graceful shutdown
  const shutdown = async () => {
    console.log('\n🤖 Bot shutting down...');
    await db.close();
    server.close();
    process.exit(0);
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

startBot().catch(err => {
  console.error('Failed to start bot:', err);
  process.exit(1);
});