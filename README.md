# 🎯 Daily English Telegram Bot

A Telegram bot that helps groups manage daily English practice by tracking 5-minute voice/video recording submissions from multiple users.

## Features

- **Automatic Tracking** - Users submit recordings, bot tracks automatically
- **Streak System** - Tracks consecutive daily submissions
- **Leaderboard** - Monthly ranking of all users
- **Admin Dashboard** - Monitor submissions, add penalties, send broadcasts
- **Scheduled Reminders** - Automated reminders at 10 PM, deadline alerts at midnight
- **Morning Motivation** - Daily encouragement at 7 AM
- **Weekly Summaries** - Sunday recap for each user
- **Duration Validation** - Ensures recordings are at least 3 minutes
- **Penalty System** - Track missed submissions

## Setup

### Prerequisites

- Node.js 16+
- A Telegram account

### Step 1: Create a Telegram Bot

1. Open Telegram and search for [@BotFather](https://t.me/BotFather)
2. Send `/newbot` and follow instructions
3. Copy the bot token you receive

### Step 2: Configure the Bot

```bash
# Clone or navigate to the project
cd daily-english-bot

# Install dependencies
npm install

# Copy environment file
cp .env.example .env

# Edit .env with your bot token and admin IDs
```

Edit `.env` file:
```
TELEGRAM_BOT_TOKEN=your_bot_token_here
ADMIN_IDS=your_telegram_id,your_friend_id
TIMEZONE=Asia/Saigon
DEADLINE_HOUR=23
DEADLINE_MINUTE=59
```

### Step 3: Get Your Telegram User ID

1. Search for [@userinfobot](https://t.me/userinfobot) on Telegram
2. Send `/start` - it will reply with your ID
3. Add this ID to ADMIN_IDS in `.env`

### Step 4: Run the Bot

```bash
npm start
```

For development with auto-restart:
```bash
npm run dev
```

## Commands

### User Commands

| Command | Description |
|---------|-------------|
| `/start` | Welcome message and intro |
| `/submit` | How to submit recordings |
| `/mystats` | Your personal statistics |
| `/streak` | Check your current streak |
| `/history` | View recent submissions |
| `/leaderboard` | Monthly leaderboard |
| `/help` | Show all commands |

### Admin Commands

| Command | Description |
|---------|-------------|
| `/admin` | Show admin panel |
| `/status` | Today's submission status |
| `/report` | Full daily report with stats |
| `/check` | Users who haven't submitted |
| `/penalty <user_id>` | Add penalty to user |
| `/broadcast <message>` | Send message to all users |
| `/setdeadline HH:MM` | Set deadline time |

## How Users Submit

Users simply send a **voice message**, **video**, or **audio file** of at least **3 minutes** speaking English to the bot. The bot will:

1. ✅ Validate the duration
2. ✅ Record the submission
3. ✅ Show their current streak
4. ✅ Notify admins

## Deployment (Optional)

### Using PM2 (recommended for production)

```bash
npm install -g pm2
pm2 start src/index.js --name daily-english-bot
pm2 save
pm2 startup
```

### Using Docker

```dockerfile
FROM node:18-alpine
WORKDIR /app
COPY package*.json ./
RUN npm install --production
COPY . .
CMD ["node", "src/index.js"]
```

## Data Storage

All data is stored locally in `daily_english.db` (SQLite). Tables:
- **users** - Registered users
- **submissions** - Recording submissions
- **penalties** - Missed submission penalties

## License

MIT