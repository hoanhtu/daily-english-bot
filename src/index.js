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

  // Set command suggestions (shows when typing /)
  await bot.setMyCommands([
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
  ]);
  console.log('✅ Command suggestions registered');

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
        const monthSubs = await db.getSubmissionsInRange(user.telegram_id, chatId, startOfMonth, endOfMonth);
        const streak = await db.calculateStreak(user.telegram_id, chatId);
        userStats.push({ ...user, monthCount: monthSubs.length, streak });
      }

      userStats.sort((a, b) => b.monthCount - a.monthCount || b.streak - a.streak);

      const todaySubmissions = await db.getTodaySubmissions(chatId, today);

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
/penalty [user_id] - Add penalty to user
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
        await bot.sendMessage(chatId, `❌ ${validation.reason}\n\nPlease send a recording of at least 5 minutes.`, replyOpts);
        return;
      }

      const today = getToday();
      const result = await db.recordSubmission(
        userId,
        chatId,
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

        const streak = await db.calculateStreak(userId, chatId);
        let streakMsg = '';
        if (streak > 0) {
          if (streak === 1) streakMsg = '\n🔥 Streak started! Day 1!';
          else if (streak < 7) streakMsg = `\n🔥 ${streak}-day streak!`;
          else streakMsg = `\n🔥🔥 ${streak}-day streak! Amazing!`;
        }

        const typeEmoji = validation.fileType === 'voice' ? '🎤' :
                          validation.fileType === 'video' ? '📹' : '🎵';

        const user = await db.getUser(userId);
        const userName = formatUserDisplay(user);

        await bot.sendMessage(chatId,
          `✅ *Submission Recorded!* ${typeEmoji}\n` +
          (isGroup ? `👤 ${userName}\n` : '') +
          `📅 ${today}\n` +
          `⏱ ${durationStr}${streakMsg}\n\n` +
          `Keep up the great work! 🚀\n` +
          `Check your stats with /mystats`,
          { parse_mode: 'Markdown', ...replyOpts }
        );

        const scopeLine = isGroup ? `\n👥 ${msg.chat.title || 'Group'}` : '\n💬 Private chat';
        for (const adminId of ADMIN_IDS) {
          try {
            await bot.sendMessage(adminId,
              `✅ *Submission Received*\n👤 ${userName}${scopeLine}\n📅 ${today}\n⏱ ${durationStr}${streakMsg}`,
              { parse_mode: 'Markdown' }
            );
          } catch (e) {}
        }
      } else {
        await bot.sendMessage(chatId, `⚠️ ${result.message}\n\nYou can view your stats with /mystats`, replyOpts);
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

  // Deadline alert at 23:59 — per group, plus DMs for 1:1 users
  cron.schedule('59 23 * * *', async () => {
    try {
      const today = getToday();
      const groups = await db.getAllGroups();

      for (const g of groups) {
        const usersStatus = await db.getAllUsersWithTodayStatus(g.chat_id, today);
        const notSubmitted = usersStatus.filter(u => !u.submission_id);

        if (notSubmitted.length === 0) {
          try {
            await bot.sendMessage(g.chat_id,
              `🎉 *All clear!* Everyone in this group submitted today! 📅 ${today}`,
              { parse_mode: 'Markdown' }
            );
          } catch (e) {}
          continue;
        }

        const names = notSubmitted.map(u => formatUserDisplay(u)).join(', ');
        try {
          await bot.sendMessage(g.chat_id,
            `⛔ *Deadline reached - ${today}*\n\nMissed today (${notSubmitted.length}): ${names}\n\nStart fresh tomorrow! 💪`,
            { parse_mode: 'Markdown' }
          );
        } catch (e) {}

        // Admins get penalty hints. NOTE: run /penalty inside this group so it
        // applies to the right scope.
        let reportMsg = `⛔ *${g.title || 'Group'} - ${today}* (run /penalty in the group)\nMissing: *${notSubmitted.length}*\n\n`;
        notSubmitted.forEach((u, i) => {
          reportMsg += `${i + 1}. ${formatUserDisplay(u)} → /penalty ${u.telegram_id}\n`;
        });
        for (const adminId of ADMIN_IDS) {
          try {
            await bot.sendMessage(adminId, reportMsg, { parse_mode: 'Markdown' });
          } catch (e) {}
        }
      }

      // Personal 1:1 deadline notices
      const privateUsers = await db.getPrivateParticipants();
      for (const u of privateUsers) {
        const submittedToday = await db.getSubmissionCountForDate(u.telegram_id, u.telegram_id, today);
        if (submittedToday > 0) continue;
        const name = u.first_name || 'there';
        try {
          await bot.sendMessage(u.telegram_id,
            `⛔ *Deadline Missed!*\n\nHey ${name}, you didn't submit your English recording today.\n\nDon't worry - start fresh tomorrow! 💪`,
            { parse_mode: 'Markdown' }
          );
        } catch (e) {}
      }
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
        try {
          await bot.sendMessage(g.chat_id, fullMessage, { parse_mode: 'Markdown' });
        } catch (e) {}
      }

      const privateUsers = await db.getPrivateParticipants();
      for (const u of privateUsers) {
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