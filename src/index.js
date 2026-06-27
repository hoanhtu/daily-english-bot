require('dotenv').config();
const TelegramBot = require('node-telegram-bot-api');
const cron = require('node-cron');
const moment = require('moment-timezone');
const DatabaseManager = require('./database');
const http = require('http');
const https = require('https');

// Configuration
const TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const ADMIN_IDS = (process.env.ADMIN_IDS || '').split(',').map(id => parseInt(id.trim())).filter(id => !isNaN(id));
const TIMEZONE = process.env.TIMEZONE || 'Asia/Saigon';
const PORT = process.env.PORT || 10000;

// AI topic generation (Ollama Cloud) — optional. Falls back to the static list if unset/unavailable.
const OLLAMA_API_KEY = process.env.OLLAMA_API_KEY;
const AI_MODEL = process.env.AI_MODEL || 'gpt-oss:120b';

// Leaderboard score weights (tunable via env):
//   score = W_STREAK*streak + W_AVGLEN*avgMinutes + W_PUNCTUALITY*earliness - W_PENALTY*penalties
const LB_WEIGHTS = {
  streak: parseFloat(process.env.W_STREAK) || 10,
  avgLen: parseFloat(process.env.W_AVGLEN) || 2,
  punctuality: parseFloat(process.env.W_PUNCTUALITY) || 5,
  penalty: parseFloat(process.env.W_PENALTY) || 15
};

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

  if (!fileId) {
    return { valid: false, reason: 'no_media' };
  }

  // Unknown/zero length → we can't verify the 5-minute minimum. This happens when
  // audio is sent as a "File"/document (Telegram reports no duration). Reject it
  // so a 0s file can't sneak through.
  if (!duration || duration <= 0) {
    return { valid: false, reason: 'unknown_duration' };
  }

  if (duration < minDuration) {
    return {
      valid: false,
      reason: `Your recording is only ${Math.floor(duration / 60)}m ${duration % 60}s long. Minimum required is 5 minutes!`
    };
  }

  return { valid: true, fileId, fileType, duration };
}


// Speaking topic suggestions (recommendation only — members are free to talk about anything)
const SPEAKING_TOPICS = [
  'Describe your typical morning routine and one thing you would change about it.',
  'Talk about a skill you want to learn this year and why.',
  'Describe your favorite meal and how it is made.',
  'Tell a story about a time you helped a stranger.',
  'If you could live in any country, which one would you choose and why?',
  'Describe the best trip you have ever taken.',
  'What does your ideal weekend look like?',
  'Talk about a movie or book that changed how you think.',
  'Describe a person who inspires you and explain why.',
  'What are three things you are grateful for today?',
  'Talk about your dream job and what a normal day there would look like.',
  'Describe a challenge you faced and how you overcame it.',
  'If you could have dinner with anyone in history, who would it be?',
  'Talk about a habit you are trying to build or break.',
  'Describe your hometown to someone who has never been there.',
  'What technology do you think will change the world in 10 years?',
  'Talk about your favorite season and what you love about it.',
  'Describe a goal you have for the next five years.',
  'Summarize a piece of news you read recently in your own words.',
  'Talk about a hobby you enjoy and how you got started.',
  'What advice would you give to your younger self?',
  'Describe a tradition or holiday that is important to your family.',
  'Talk about the last thing that made you laugh.',
  'If you won the lottery tomorrow, what would you do first?',
  'Describe a place where you feel most relaxed.',
  'Talk about a teacher or mentor who influenced your life.',
  'What is something you changed your mind about recently?',
  'Describe your favorite way to spend a rainy day.',
  'Talk about a goal you achieved that you are proud of.',
  'If you could master one language instantly, which would it be and why?'
];

function getDailyTopic() {
  // Pick a topic based on the day of the year so everyone gets the same one each day
  const dayOfYear = parseInt(moment().tz(TIMEZONE).format('DDD'), 10);
  return SPEAKING_TOPICS[dayOfYear % SPEAKING_TOPICS.length];
}

// Core call to Ollama Cloud. Returns the assistant's text, or null on any failure
// (missing key, timeout, HTTP error, network) so callers can degrade gracefully.
async function callOllama(messages, timeoutMs = 25000) {
  if (!OLLAMA_API_KEY) return null;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const res = await fetch('https://ollama.com/api/chat', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${OLLAMA_API_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ model: AI_MODEL, stream: false, messages }),
      signal: controller.signal
    });

    if (!res.ok) {
      console.error(`[AI] request failed: HTTP ${res.status}`);
      return null;
    }

    const data = await res.json();
    const text = (data && data.message && data.message.content || '').trim();
    return text || null;
  } catch (err) {
    console.error('[AI] request error:', err.message);
    return null;
  } finally {
    clearTimeout(timer);
  }
}

// Generate a fresh speaking topic. Returns null on failure so callers fall back to the static list.
async function generateAITopic() {
  const text = await callOllama([
    {
      role: 'system',
      content: 'You create short, engaging English speaking-practice prompts for language learners preparing a 5-minute monologue.'
    },
    {
      role: 'user',
      content: 'Give me ONE fresh, interesting English speaking-practice topic. Return only the topic as a single sentence — no numbering, no quotation marks, no extra text.'
    }
  ], 20000);
  if (!text) return null;
  // Strip wrapping quotes or a leading list marker if the model added them
  return text.replace(/^["'\s\-\d.)]+/, '').replace(/["']+$/, '').trim() || null;
}

// Get a topic: try AI first, fall back to the deterministic static list.
async function suggestTopic() {
  const aiTopic = await generateAITopic();
  return { topic: aiTopic || getDailyTopic(), fromAI: !!aiTopic };
}

// Answer a free-form question from a user. Returns null on failure.
async function askAI(question) {
  return callOllama([
    {
      role: 'system',
      content: 'You are a friendly English-learning assistant inside a Telegram bot. Help users practice English: answer questions, explain grammar and vocabulary, correct mistakes, and give examples. Keep answers clear and concise (a few short paragraphs at most) since they are read on a phone.'
    },
    { role: 'user', content: question }
  ], 30000);
}

// Create HTTP server for Render health checks
const server = http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.end('Daily English Bot is running!\n');
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`🌐 Health check server listening on port ${PORT}`);
});

// Self-ping every 5 minutes to prevent Render free tier from sleeping
const RENDER_URL = process.env.RENDER_EXTERNAL_URL;
if (RENDER_URL) {
  setInterval(() => {
    https.get(RENDER_URL, (res) => {
      console.log(`[keep-alive] ping ${res.statusCode}`);
    }).on('error', (err) => {
      console.error('[keep-alive] ping failed:', err.message);
    });
  }, 5 * 60 * 1000);
  console.log(`[keep-alive] Self-ping enabled → ${RENDER_URL} every 5 min`);
}

async function startBot() {
  const db = new DatabaseManager();
  await db.ready;

  const bot = new TelegramBot(TOKEN, { polling: true });

  console.log(`🤖 Daily English Bot started!`);
  console.log(`📍 Timezone: ${TIMEZONE}`);
  console.log(`👤 Admins: ${ADMIN_IDS.length > 0 ? ADMIN_IDS.join(', ') : 'None configured'}`);

  // Set command suggestions (shows when typing /).
  const COMMAND_LIST = [
    { command: 'start', description: 'Welcome & instructions' },
    { command: 'submit', description: 'How to submit recordings' },
    { command: 'topic', description: "Today's speaking topic suggestion" },
    { command: 'ask', description: 'Ask the AI an English question' },
    { command: 'mystats', description: 'Your personal statistics' },
    { command: 'streak', description: 'Check your current streak' },
    { command: 'history', description: 'View recent submissions' },
    { command: 'leaderboard', description: 'Monthly leaderboard' },
    { command: 'penalties', description: 'Wall of shame (missed days)' },
    { command: 'myid', description: 'Get your Telegram user ID' },
    { command: 'help', description: 'Show all commands' }
  ];
  // Telegram keeps a separate command list per scope. The default scope alone
  // does NOT reliably show the slash-autocomplete in groups, so register the
  // group scopes explicitly too.
  try {
    await bot.setMyCommands(COMMAND_LIST); // default scope (fallback / private)
    await bot.setMyCommands(COMMAND_LIST, { scope: { type: 'all_private_chats' } });
    await bot.setMyCommands(COMMAND_LIST, { scope: { type: 'all_group_chats' } });
    await bot.setMyCommands(COMMAND_LIST, { scope: { type: 'all_chat_administrators' } });
    console.log('✅ Command suggestions registered (default + private + groups)');
  } catch (e) {
    console.error('Failed to register command suggestions:', e.message);
  }

  // A "scope" is the world a message belongs to:
  //   - group/supergroup -> the group's chat id (negative)
  //   - private 1:1 chat  -> msg.chat.id, which equals the user's own id (positive)
  // Every submission/penalty/query is scoped by this chat id so each group is
  // independent and 1:1 practice stays personal.
  function isGroupChat(msg) {
    return msg.chat.type === 'group' || msg.chat.type === 'supergroup';
  }

  // Remember which users participate in which group. Fires for every message
  // (needs Privacy Mode OFF or the bot to be a group admin to see them all).
  bot.on('message', async (msg) => {
    try {
      if (!msg.from || !isGroupChat(msg)) return;
      await db.registerGroup(msg.chat.id, msg.chat.title || null);
      await db.registerUser(msg.from.id, msg.from.username, msg.from.first_name, msg.from.last_name);
      await db.registerGroupMember(msg.chat.id, msg.from.id);
    } catch (e) {
      console.error('Error tracking group member:', e.message);
    }
  });

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

Just *send a voice message, video, or audio file*. No filenames or dates needed — I count each valid recording automatically.

*Requirements:*
⏱ Minimum *5 minutes* long (one file = one day)
🗣 Speak in English
📅 One recording per day

*Catching up:* Each recording fills your *oldest unfinished day first*. So if you missed yesterday, send *two* recordings today — the first covers yesterday, the second covers today. You can't bank ahead: extra files when you're all caught up are ignored.

⚠️ *Fines:* You may be *1 day late*. If a day is still missing by the end of the next day, you get *1 penalty* for it — so never go *2 days in a row* with nothing.
🗓 *Saturday* is relaxed: its recording can be turned in as late as *Monday*.

Send your recording now! 🚀
`, { parse_mode: 'Markdown' });
    } catch (err) {
      console.error('Error in /submit:', err.message);
    }
  });

  // Daily speaking topic (suggestion only, AI-generated when available)
  bot.onText(/\/topic/, async (msg) => {
    try {
      const chatId = msg.chat.id;
      await bot.sendChatAction(chatId, 'typing').catch(() => {});

      const { topic, fromAI } = await suggestTopic();

      await bot.sendMessage(chatId,
        `💡 *Speaking topic (just a suggestion):*\n\n` +
        `_${topic}_\n\n` +
        `This is only an idea — feel free to talk about anything you like! 🗣\n` +
        `Then send your recording (at least 5 minutes). 🎤` +
        (fromAI ? `\n\n🤖 _Suggested by AI — send /topic again for a new one._` : ''),
        { parse_mode: 'Markdown' }
      );
    } catch (err) {
      console.error('Error in /topic:', err.message);
    }
  });

  // Ask the AI a free-form question
  bot.onText(/^\/ask(?:@\w+)?(?:\s+([\s\S]+))?$/, async (msg, match) => {
    try {
      const chatId = msg.chat.id;
      const question = match[1] ? match[1].trim() : '';

      if (!question) {
        await bot.sendMessage(chatId,
          `🤖 *Ask me anything about English!*\n\n` +
          `Usage: \`/ask <your question>\`\n\n` +
          `Examples:\n` +
          `• /ask What is the difference between "since" and "for"?\n` +
          `• /ask Correct this: He don't likes coffee\n` +
          `• /ask Give me 5 synonyms for "happy"`,
          { parse_mode: 'Markdown' }
        );
        return;
      }

      if (!OLLAMA_API_KEY) {
        await bot.sendMessage(chatId, '🤖 AI is not configured right now. Please try again later.');
        return;
      }

      await bot.sendChatAction(chatId, 'typing').catch(() => {});
      const answer = await askAI(question);

      if (!answer) {
        await bot.sendMessage(chatId, '⚠️ Sorry, I couldn\'t get an answer right now. Please try again in a moment.');
        return;
      }

      // Send as plain text so arbitrary AI formatting can't break Telegram's parser.
      // Telegram caps messages at 4096 chars, so trim if needed.
      const reply = answer.length > 4000 ? answer.slice(0, 4000) + '…' : answer;
      await bot.sendMessage(chatId, `🤖 ${reply}`);
    } catch (err) {
      console.error('Error in /ask:', err.message);
    }
  });

  // My Stats
  bot.onText(/\/mystats/, async (msg) => {
    try {
      const chatId = msg.chat.id;
      const userId = msg.from.id;

      await db.registerUser(userId, msg.from.username, msg.from.first_name, msg.from.last_name);
      const stats = await db.getUserStats(userId, chatId);
      const user = await db.getUser(userId);

      const startOfMonth = moment().tz(TIMEZONE).startOf('month').format('YYYY-MM-DD');
      const endOfMonth = moment().tz(TIMEZONE).endOf('month').format('YYYY-MM-DD');
      const monthSubmissions = await db.getSubmissionsInRange(userId, chatId, startOfMonth, endOfMonth);

      const statsMsg = `
📊 *Your Statistics${isGroupChat(msg) ? ' (this group)' : ''}* 📊

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

      const streak = await db.calculateStreak(userId, chatId);

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

      const submissions = await db.getUserSubmissions(userId, chatId, 15);

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
      const users = await db.getScopeMembers(chatId);
      const today = getToday();
      const startOfMonth = moment().tz(TIMEZONE).startOf('month').format('YYYY-MM-DD');
      const endOfMonth = moment().tz(TIMEZONE).endOf('month').format('YYYY-MM-DD');

      const userStats = [];
      for (const user of users) {
        const subs = await db.getSubmissionsDetailInRange(user.telegram_id, chatId, startOfMonth, endOfMonth);
        const streak = await db.calculateStreak(user.telegram_id, chatId);
        const penalties = await db.getUserPenalties(user.telegram_id, chatId, 1000);
        const monthPenalties = penalties.filter(p => {
          const d = moment(p.penalty_date).format('YYYY-MM-DD');
          return d >= startOfMonth && d <= endOfMonth;
        }).length;

        const monthCount = subs.length;
        // Average recording length, in minutes.
        const avgMinutes = monthCount > 0
          ? (subs.reduce((s, x) => s + (x.duration || 0), 0) / monthCount) / 60
          : 0;
        // Punctuality: average earliness within the day (00:00 → 1.0, 23:59 → ~0.0).
        let earliness = 0;
        if (monthCount > 0) {
          const sum = subs.reduce((acc, x) => {
            if (!x.submitted_at) return acc;
            const local = moment(x.submitted_at).tz(TIMEZONE);
            const secs = local.hours() * 3600 + local.minutes() * 60 + local.seconds();
            return acc + (1 - secs / 86400);
          }, 0);
          earliness = sum / monthCount;
        }

        const score = LB_WEIGHTS.streak * streak
          + LB_WEIGHTS.avgLen * avgMinutes
          + LB_WEIGHTS.punctuality * earliness
          - LB_WEIGHTS.penalty * monthPenalties;

        userStats.push({ ...user, monthCount, streak, avgMinutes, monthPenalties, score });
      }

      userStats.sort((a, b) => b.score - a.score);

      const todaySubmissions = await db.getTodaySubmissions(chatId, today);

      let leaderboardMsg = `🏆 *Leaderboard - ${moment().tz(TIMEZONE).format('MMMM YYYY')}* 🏆\n\n`;
      leaderboardMsg += `📅 Today: ${todaySubmissions.length}/${users.length} submitted\n\n`;

      const medals = ['🥇', '🥈', '🥉'];
      userStats.forEach((user, index) => {
        const rank = index < 3 ? medals[index] : `${index + 1}.`;
        const name = user.first_name || user.username || `User ${user.telegram_id}`;
        let line = `${rank} *${name}* — *${user.score.toFixed(1)}* pts`;
        if (index === 0 && user.monthCount > 0) line += ' 👑';
        line += `\n   📅 ${user.monthCount} • 🔥 ${user.streak}d • ⏱ ${user.avgMinutes.toFixed(1)}m`;
        if (user.monthPenalties > 0) line += ` • ⚠️ ${user.monthPenalties}`;
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

  // Penalties — wall of shame (most missed days this month)
  bot.onText(/\/penalties/, async (msg) => {
    try {
      const chatId = msg.chat.id;
      const users = await db.getScopeMembers(chatId);
      const startOfMonth = moment().tz(TIMEZONE).startOf('month').format('YYYY-MM-DD');
      const endOfMonth = moment().tz(TIMEZONE).endOf('month').format('YYYY-MM-DD');

      const userStats = [];
      for (const user of users) {
        const penalties = await db.getUserPenalties(user.telegram_id, chatId, 100);
        const monthPenalties = penalties.filter(p => {
          const d = moment(p.penalty_date).format('YYYY-MM-DD');
          return d >= startOfMonth && d <= endOfMonth;
        });
        userStats.push({ ...user, penaltyCount: monthPenalties.length });
      }

      const offenders = userStats
        .filter(u => u.penaltyCount > 0)
        .sort((a, b) => b.penaltyCount - a.penaltyCount);

      let wallMsg = `🚨 *Wall of Shame - ${moment().tz(TIMEZONE).format('MMMM YYYY')}* 🚨\n`;
      wallMsg += `_Most missed days this month_\n\n`;

      if (offenders.length === 0) {
        wallMsg += `🎉 *Spotless!* Nobody has any penalties this month. Amazing discipline, everyone! 💪`;
      } else {
        offenders.forEach((u, index) => {
          const name = u.first_name || u.username || `User ${u.telegram_id}`;
          const skulls = '💀'.repeat(Math.min(u.penaltyCount, 5));
          wallMsg += `${index + 1}. *${name}* — ${u.penaltyCount} missed ${skulls}\n`;
        });
        wallMsg += `\nLet's turn those misses into streaks tomorrow! 🔥`;
      }

      await bot.sendMessage(chatId, wallMsg, { parse_mode: 'Markdown' });
    } catch (err) {
      console.error('Error in /penalties:', err.message);
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
/topic - Today's speaking topic suggestion
/ask - Ask the AI an English question
/mystats - Your personal statistics
/streak - Check your current streak
/history - View recent submissions
/leaderboard - Monthly leaderboard
/penalties - Wall of shame (missed days)
/help - Show this message

${isAdmin(userId) ? `
*Admin commands:*
/admin - Show admin panel
/status - Today's submission status
/report - Full daily report
/check - Check who hasn't submitted
/addmember - Add a member (reply or user id)
/removemember - Remove a member
/quiet - Toggle quiet mode (no submit replies / daily topic)
/penalty - Add a penalty
/forcecheck - Run the end-of-day penalty job now
/deadline - Set deadline time
/broadcast - Send message to all users
/testai - Check if AI topic generation works
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
/addmember - Add a member (reply to them, or /addmember <user_id>)
/removemember - Remove a member (reply, or /removemember <user_id>)
/quiet [on|off] - Mute submit replies & daily topic in this chat
/penalty [user_id] - Add penalty to user
/forcecheck - Run the end-of-day penalty job now
/broadcast [message] - Broadcast to all users
/setdeadline HH:MM - Set deadline time
/testai - Check if AI topic generation works
`;

      await bot.sendMessage(chatId, adminMsg);
    } catch (err) {
      console.error('Error in /admin:', err.message);
    }
  });

  // Test AI topic generation (admin)
  bot.onText(/\/testai/, async (msg) => {
    try {
      const chatId = msg.chat.id;
      const userId = msg.from.id;

      if (!isAdmin(userId)) {
        await bot.sendMessage(chatId, '⛔ Not authorized.');
        return;
      }

      if (!OLLAMA_API_KEY) {
        await bot.sendMessage(chatId,
          `⚙️ *AI Status: Disabled*\n\n` +
          `No \`OLLAMA_API_KEY\` is set, so the bot uses its built-in topic list.\n\n` +
          `Add the key in your environment to enable AI topics.`,
          { parse_mode: 'Markdown' }
        );
        return;
      }

      await bot.sendChatAction(chatId, 'typing').catch(() => {});
      const start = Date.now();
      const aiTopic = await generateAITopic();
      const elapsed = ((Date.now() - start) / 1000).toFixed(1);

      if (aiTopic) {
        await bot.sendMessage(chatId,
          `✅ *AI is working!*\n\n` +
          `🤖 Model: \`${AI_MODEL}\`\n` +
          `⏱ Response time: ${elapsed}s\n\n` +
          `*Sample topic:*\n_${aiTopic}_`,
          { parse_mode: 'Markdown' }
        );
      } else {
        await bot.sendMessage(chatId,
          `❌ *AI request failed* (took ${elapsed}s)\n\n` +
          `Model \`${AI_MODEL}\` did not return a topic. The bot will fall back to its built-in list.\n\n` +
          `Check the server logs for the exact error (bad key, rate limit, or wrong model name).`,
          { parse_mode: 'Markdown' }
        );
      }
    } catch (err) {
      console.error('Error in /testai:', err.message);
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
      const usersStatus = await db.getAllUsersWithTodayStatus(chatId, today);

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
      const usersStatus = await db.getAllUsersWithTodayStatus(chatId, today);
      const allUsers = await db.getScopeMembers(chatId);

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
        const monthSubs = await db.getSubmissionsInRange(u.telegram_id, chatId, startOfMonth, endOfMonth);
        const penalties = await db.getUserPenalties(u.telegram_id, chatId, 100);
        const monthPenalties = penalties.filter(p => p.penalty_date >= startOfMonth && p.penalty_date <= endOfMonth);
        const streak = await db.calculateStreak(u.telegram_id, chatId);
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
      const usersStatus = await db.getAllUsersWithTodayStatus(chatId, today);
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

  // Add a member to this group's tracker (admin). The bot only auto-knows people
  // who have posted, so this covers lurkers. Two ways:
  //   • reply to the person's message with /addmember   (best — captures their name)
  //   • /addmember <user_id>
  bot.onText(/^\/addmember(?:@\w+)?(?:\s+(\d+))?/, async (msg, match) => {
    try {
      const chatId = msg.chat.id;
      const userId = msg.from.id;

      if (!isAdmin(userId)) {
        await bot.sendMessage(chatId, '⛔ Not authorized.');
        return;
      }
      if (!isGroupChat(msg)) {
        await bot.sendMessage(chatId, 'ℹ️ Use this *inside the group* you want to add the member to.', { parse_mode: 'Markdown' });
        return;
      }

      // Resolve the target: a replied-to user is best (gives their real name).
      let target = null;
      if (msg.reply_to_message && msg.reply_to_message.from) {
        const f = msg.reply_to_message.from;
        target = { id: f.id, username: f.username || null, first_name: f.first_name || null, last_name: f.last_name || null };
      } else if (match[1]) {
        const id = parseInt(match[1]);
        const existing = await db.getUser(id);
        target = existing
          ? { id, username: existing.username, first_name: existing.first_name, last_name: existing.last_name }
          : { id, username: null, first_name: `Member ${id}`, last_name: null };
      }

      if (!target) {
        await bot.sendMessage(chatId,
          `➕ *Add a member*\n\n` +
          `• *Reply* to the person's message with \`/addmember\` (recommended — gets their name), or\n` +
          `• \`/addmember <user_id>\`\n\n` +
          `_Telegram doesn't let bots list group members, so add anyone who hasn't posted yet this way._`,
          { parse_mode: 'Markdown' });
        return;
      }

      if (target.id === (await bot.getMe()).id) {
        await bot.sendMessage(chatId, "🤖 That's me — I don't need to be tracked.");
        return;
      }

      await db.registerGroup(chatId, msg.chat.title || null);
      await db.registerUser(target.id, target.username, target.first_name, target.last_name);
      await db.registerGroupMember(chatId, target.id);

      const name = formatUserDisplay(await db.getUser(target.id));
      await bot.sendMessage(chatId, `✅ Added *${name}* to this group's tracker. They'll now appear in /status, /leaderboard and reminders.`, { parse_mode: 'Markdown' });
    } catch (err) {
      console.error('Error in /addmember:', err.message);
    }
  });

  // Remove a member from this group's tracker (admin). Reply or /removemember <id>.
  bot.onText(/^\/removemember(?:@\w+)?(?:\s+(\d+))?/, async (msg, match) => {
    try {
      const chatId = msg.chat.id;
      const userId = msg.from.id;

      if (!isAdmin(userId)) {
        await bot.sendMessage(chatId, '⛔ Not authorized.');
        return;
      }
      if (!isGroupChat(msg)) {
        await bot.sendMessage(chatId, 'ℹ️ Use this inside the group.');
        return;
      }

      let targetId = null;
      if (msg.reply_to_message && msg.reply_to_message.from) targetId = msg.reply_to_message.from.id;
      else if (match[1]) targetId = parseInt(match[1]);

      if (!targetId) {
        await bot.sendMessage(chatId, 'Usage: reply to the person with `/removemember`, or `/removemember <user_id>`.', { parse_mode: 'Markdown' });
        return;
      }

      await db.removeGroupMember(chatId, targetId);
      const user = await db.getUser(targetId);
      await bot.sendMessage(chatId, `✅ Removed ${user ? formatUserDisplay(user) : `user ${targetId}`} from this group's tracker. (Their past records are kept.)`);
    } catch (err) {
      console.error('Error in /removemember:', err.message);
    }
  });

  // Quiet mode (admin): toggle whether the bot confirms submissions and posts the
  // daily topic in THIS chat. It still warns about invalid/too-short recordings.
  //   /quiet        → toggle
  //   /quiet on     → enable quiet mode
  //   /quiet off    → disable quiet mode
  bot.onText(/^\/quiet(?:@\w+)?(?:\s+(on|off))?\s*$/i, async (msg, match) => {
    try {
      const chatId = msg.chat.id;
      const userId = msg.from.id;

      if (!isAdmin(userId)) {
        await bot.sendMessage(chatId, '⛔ Not authorized.');
        return;
      }

      const arg = match[1] ? match[1].toLowerCase() : null;
      let quiet;
      if (arg === 'on') quiet = true;
      else if (arg === 'off') quiet = false;
      else quiet = !(await db.isQuiet(chatId)); // no arg → toggle

      await db.setQuiet(chatId, quiet);

      await bot.sendMessage(chatId,
        quiet
          ? `🔇 *Quiet mode ON.*\nI'll go silent here — no submission confirmations, no daily topic, no reminders, and no penalty announcements.\n\nI'll *still* warn when a recording is too short or unreadable, and fines are *still* applied automatically.\n\n_Turn back on with_ \`/quiet off\``
          : `🔔 *Quiet mode OFF.*\nI'll confirm submissions and post the daily topic, reminders, and penalty announcements again.`,
        { parse_mode: 'Markdown' });
    } catch (err) {
      console.error('Error in /quiet:', err.message);
    }
  });

  // Force-run the nightly penalty job now (admin) — for testing/ops.
  bot.onText(/^\/forcecheck/, async (msg) => {
    try {
      const chatId = msg.chat.id;
      if (!isAdmin(msg.from.id)) {
        await bot.sendMessage(chatId, '⛔ Not authorized.');
        return;
      }
      await bot.sendMessage(chatId, '⏳ Running the end-of-day penalty check…');
      await runDeadlineCheck();
      await bot.sendMessage(chatId, '✅ Penalty check complete.');
    } catch (err) {
      console.error('Error in /forcecheck:', err.message);
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
        const usersStatus = await db.getAllUsersWithTodayStatus(chatId, today);
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
      await db.addPenalty(targetUserId, chatId, today, 'Missed daily submission');

      const name = formatUserDisplay(user);
      await bot.sendMessage(chatId, `⚠️ Penalty added to ${name} for missing today's submission${isGroupChat(msg) ? ' in this group' : ''}.`);
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

      // In groups/supergroups, reply directly to the submitter's recording so it's
      // clear whose submission was counted when several people post at once.
      const isGroup = isGroupChat(msg);
      const replyOpts = isGroup ? { reply_to_message_id: msg.message_id } : {};

      // Make sure this person counts as a member of this group's tracker.
      if (isGroup) {
        await db.registerGroup(chatId, msg.chat.title || null);
        await db.registerGroupMember(chatId, userId);
      }

      const validation = validateSubmission(msg);

      if (!validation.valid) {
        if (validation.reason === 'no_media') {
          return;
        }
        if (validation.reason === 'unknown_duration') {
          await bot.sendMessage(chatId,
            `❌ I couldn't read this file's length, so I can't confirm it's at least 5 minutes.\n\n` +
            `Please send it as a *voice message* or an *audio file* — *not* as a “File”/document — so I can check the duration.`,
            { parse_mode: 'Markdown', ...replyOpts });
          return;
        }
        await bot.sendMessage(chatId, `❌ ${validation.reason}\n\nPlease send a recording of at least 5 minutes.`, replyOpts);
        return;
      }

      // Files are dateless: the recording fills the member's OLDEST still-uncovered
      // day (up to today). Extra files when fully caught up are discarded.
      const today = getToday();
      const startDate = await db.getMemberStartDate(chatId, userId);
      const result = await db.recordSubmission(
        userId,
        chatId,
        validation.fileId,
        validation.fileType,
        validation.duration,
        msg.caption || null,
        today,
        startDate
      );

      const quiet = await db.isQuiet(chatId);

      if (result.success) {
        const assignedDate = result.assignedDate;
        const durationStr = validation.duration > 0
          ? `(${Math.floor(validation.duration / 60)}m ${validation.duration % 60}s)`
          : '';

        const streak = await db.calculateStreak(userId, chatId);
        let streakMsg = '';
        if (streak > 0) {
          if (streak === 1) streakMsg = '\n🔥 Streak started! Day 1!';
          else if (streak < 7) streakMsg = `\n🔥 ${streak}-day streak!`;
          else streakMsg = `\n🔥🔥 ${streak}-day streak! Amazing!`;
        }

        const typeEmoji = validation.fileType === 'voice' ? '🎤' :
                          validation.fileType === 'video' ? '📹' : '🎵';
        const makeupTag = result.onTime ? '' : ' _(catch-up — does not count for streak)_';

        const user = await db.getUser(userId);
        const userName = formatUserDisplay(user);

        // Quiet mode: record silently (no in-chat confirmation). Admins are still
        // notified, and invalid/too-short recordings are still warned about above.
        if (!quiet) {
          await bot.sendMessage(chatId,
            `✅ *Submission Recorded!* ${typeEmoji}\n` +
            (isGroup ? `👤 ${userName}\n` : '') +
            `📅 Counts for: ${assignedDate}${makeupTag}\n` +
            `⏱ ${durationStr}${streakMsg}\n\n` +
            `Keep up the great work! 🚀\n` +
            `Check your stats with /mystats`,
            { parse_mode: 'Markdown', ...replyOpts }
          );
        }

        const scopeLine = isGroup ? `\n👥 ${msg.chat.title || 'Group'}` : '\n💬 Private chat';
        for (const adminId of ADMIN_IDS) {
          try {
            await bot.sendMessage(adminId,
              `✅ *Submission Received*\n👤 ${userName}${scopeLine}\n📅 ${assignedDate}${makeupTag}\n⏱ ${durationStr}${streakMsg}`,
              { parse_mode: 'Markdown' }
            );
          } catch (e) {}
        }
      } else if (result.discarded) {
        // Fully caught up — the file isn't needed (no paying ahead). Let them know
        // (unless quiet) so they don't think it was lost.
        if (!quiet) {
          await bot.sendMessage(chatId,
            `👍 You're all caught up — no day is owed, so this extra recording isn't needed (you can't bank ahead for future days).`,
            replyOpts);
        }
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

  // Reminder at 22:00 (10 PM) daily — posted per group, plus DMs for 1:1 users
  cron.schedule('0 22 * * *', async () => {
    try {
      const today = getToday();
      const groups = await db.getAllGroups();

      for (const g of groups) {
        if (await db.isQuiet(g.chat_id)) continue; // quiet groups get no reminders
        const usersStatus = await db.getAllUsersWithTodayStatus(g.chat_id, today);
        const notSubmitted = usersStatus.filter(u => !u.submission_id);
        if (notSubmitted.length === 0) continue;

        const names = notSubmitted.map(u => u.first_name || u.username || `User ${u.telegram_id}`).join(', ');
        try {
          await bot.sendMessage(g.chat_id,
            `⏰ *Daily Reminder!*\n\nStill waiting on: ${names}\n\n🎤 Send your recording (5+ min) before ${getDeadlineTime()}!`,
            { parse_mode: 'Markdown' }
          );
        } catch (e) {}

        for (const adminId of ADMIN_IDS) {
          try {
            await bot.sendMessage(adminId,
              `⏰ *${g.title || 'Group'}* — ${notSubmitted.length} pending\n${names}`,
              { parse_mode: 'Markdown' }
            );
          } catch (e) {}
        }
      }

      // Personal 1:1 reminders
      const privateUsers = await db.getPrivateParticipants();
      for (const u of privateUsers) {
        if (await db.isQuiet(u.telegram_id)) continue;
        const submittedToday = await db.getSubmissionCountForDate(u.telegram_id, u.telegram_id, today);
        if (submittedToday > 0) continue;
        const name = u.first_name || 'there';
        try {
          await bot.sendMessage(u.telegram_id,
            `⏰ *Reminder!*\n\nHey ${name}! Don't forget your daily English recording! 🎤\n\nDeadline: ${getDeadlineTime()}`,
            { parse_mode: 'Markdown' }
          );
        } catch (e) {}
      }
    } catch (err) {
      console.error('Error in reminder cron:', err.message);
    }
  }, { timezone: TIMEZONE });

  // Which recording-day(s) hit their deadline at the END of day X.
  //   • Normal day R → deadline end of R+1, so X-1 is due tonight (unless it's a Saturday).
  //   • Saturday is special: its recording is deferred to Monday (R+2), so a
  //     Saturday two days ago (X-2) is due tonight — which only happens on Monday.
  // (Sun→Mon, all other days → +1.) This yields: nothing due on Sunday night,
  // and both Sat+Sun due on Monday night.
  function dueRecordingDays(today) {
    const dow = d => moment(d, 'YYYY-MM-DD').day(); // 0=Sun … 6=Sat
    const minus = n => moment(today, 'YYYY-MM-DD').subtract(n, 'days').format('YYYY-MM-DD');
    const due = [];
    const yesterday = minus(1);
    if (dow(yesterday) !== 6) due.push(yesterday); // a Saturday is NOT due the next day
    const twoAgo = minus(2);
    if (dow(twoAgo) === 6) due.push(twoAgo);       // deferred Saturday comes due (Monday night)
    return due;
  }

  // Assess penalties for whichever recording-days are now past their deadline, per
  // scope. Fines are applied even in quiet mode (quiet only silences the public
  // announcement). `catchUp` just changes the announcement wording.
  async function runDeadlineCheck(catchUp = false) {
    const today = getToday();
    const due = dueRecordingDays(today);
    if (due.length === 0) return; // e.g. Sunday night — nothing newly due
    const prefix = catchUp ? '[catch-up] ' : '';

    const assessScope = async (chatId, members) => {
      const newlyFined = []; // { name, day, total }
      for (const m of members) {
        const start = await db.getMemberStartDate(chatId, m.telegram_id);
        for (const R of due) {
          if (R < start) continue;                                   // before they joined
          if (await db.getSubmissionCountForDate(m.telegram_id, chatId, R) > 0) continue; // covered
          if (await db.penaltyExists(m.telegram_id, chatId, R)) continue;                 // already fined
          await db.addPenalty(m.telegram_id, chatId, R, 'Missed daily submission');
          const total = await db.getPenaltyCount(m.telegram_id, chatId);
          newlyFined.push({ name: formatUserDisplay(m), day: R, total });
        }
      }
      return newlyFined;
    };

    // Groups: announce in the group (unless quiet), batched into one message.
    for (const g of await db.getAllGroups()) {
      const members = await db.getScopeMembers(g.chat_id);
      const fined = await assessScope(g.chat_id, members);
      if (fined.length === 0) continue;

      if (!(await db.isQuiet(g.chat_id))) {
        let msg = `🚨 *${prefix}Penalties — ${today}*\n\n`;
        for (const f of fined) msg += `• ${f.name} — missed *${f.day}* (total: ${f.total})\n`;
        try { await bot.sendMessage(g.chat_id, msg, { parse_mode: 'Markdown' }); } catch (e) {}
      }
      for (const adminId of ADMIN_IDS) {
        try {
          await bot.sendMessage(adminId,
            `🚨 *${g.title || 'Group'}* — ${fined.length} penalty(ies): ${fined.map(f => `${f.name} (${f.day})`).join(', ')}`,
            { parse_mode: 'Markdown' });
        } catch (e) {}
      }
    }

    // Private 1:1 scope: assess and DM the user (unless quiet).
    for (const u of await db.getPrivateParticipants()) {
      const fined = await assessScope(u.telegram_id, [u]);
      if (fined.length === 0 || await db.isQuiet(u.telegram_id)) continue;
      let msg = `🚨 *${prefix}Penalty${fined.length > 1 ? 'ies' : ''}*\n\n`;
      for (const f of fined) msg += `• Missed *${f.day}* (total: ${f.total})\n`;
      try { await bot.sendMessage(u.telegram_id, msg, { parse_mode: 'Markdown' }); } catch (e) {}
    }
  }

  // Nightly penalty job at 23:59.
  cron.schedule('59 23 * * *', async () => {
    try {
      await runDeadlineCheck();
    } catch (err) {
      console.error('Error in deadline cron:', err.message);
    }
  }, { timezone: TIMEZONE });

  // Morning motivation at 7:00 — posted to every group and DM'd to 1:1 users
  cron.schedule('0 7 * * *', async () => {
    try {
      const messages = [
        '🌅 Good morning! Ready to practice your English today? 🎤',
        '☀️ New day, new opportunity! Don\'t forget your English recording! 🚀',
        '🌄 Rise and shine! Your English practice awaits! Send your recording today! 💪',
        '🌟 Good morning! Make today count with your English practice! 🎯',
        '🌞 Start your day strong! Record your English practice now! 🔥'
      ];

      const message = messages[Math.floor(Math.random() * messages.length)];
      // One AI call per day, reused everywhere (falls back to static list)
      const { topic } = await suggestTopic();
      const fullMessage =
        `${message}\n\n` +
        `💡 *Today's speaking topic (just a suggestion):*\n` +
        `_${topic}_\n\n` +
        `Feel free to talk about anything you like — this is only an idea to get you started! 🗣`;

      const groups = await db.getAllGroups();
      for (const g of groups) {
        if (await db.isQuiet(g.chat_id)) continue; // quiet chats get no daily topic
        try {
          await bot.sendMessage(g.chat_id, fullMessage, { parse_mode: 'Markdown' });
        } catch (e) {}
      }

      const privateUsers = await db.getPrivateParticipants();
      for (const u of privateUsers) {
        if (await db.isQuiet(u.telegram_id)) continue;
        try {
          await bot.sendMessage(u.telegram_id, fullMessage, { parse_mode: 'Markdown' });
        } catch (e) {}
      }
    } catch (err) {
      console.error('Error in morning cron:', err.message);
    }
  }, { timezone: TIMEZONE });

  // Weekly summary on Sunday at 20:00 — group leaderboard in each group, personal DM for 1:1 users
  cron.schedule('0 20 * * 0', async () => {
    try {
      const endDate = getToday();
      const startDate = moment().tz(TIMEZONE).subtract(7, 'days').format('YYYY-MM-DD');

      // Per-group weekly recap
      const groups = await db.getAllGroups();
      for (const g of groups) {
        const members = await db.getScopeMembers(g.chat_id);
        const rows = [];
        for (const u of members) {
          const weekSubs = await db.getSubmissionsInRange(u.telegram_id, g.chat_id, startDate, endDate);
          const streak = await db.calculateStreak(u.telegram_id, g.chat_id);
          rows.push({ name: u.first_name || u.username || `User ${u.telegram_id}`, count: weekSubs.length, streak });
        }
        if (rows.length === 0) continue;
        rows.sort((a, b) => b.count - a.count || b.streak - a.streak);

        let msg = `📊 *Weekly Summary - ${g.title || 'Group'}*\n\n`;
        rows.forEach((r, i) => {
          msg += `${i + 1}. ${r.name}: ${r.count}/7 days`;
          if (r.streak > 0) msg += ` 🔥${r.streak}d`;
          msg += `\n`;
        });
        msg += `\nKeep practicing every day! 💪`;
        try {
          await bot.sendMessage(g.chat_id, msg, { parse_mode: 'Markdown' });
        } catch (e) {}
      }

      // Personal weekly summary for 1:1 participants
      const privateUsers = await db.getPrivateParticipants();
      for (const u of privateUsers) {
        const weekSubs = await db.getSubmissionsInRange(u.telegram_id, u.telegram_id, startDate, endDate);
        const streak = await db.calculateStreak(u.telegram_id, u.telegram_id);
        const name = u.first_name || 'there';

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
          await bot.sendMessage(u.telegram_id, msg, { parse_mode: 'Markdown' });
        } catch (e) {}
      }
    } catch (err) {
      console.error('Error in weekly cron:', err.message);
    }
  }, { timezone: TIMEZONE });

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