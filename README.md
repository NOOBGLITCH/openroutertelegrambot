# OpenRouter Telegram Bot

Serverless Telegram bot running on [Telegram's serverless platform](https://core.telegram.org/bots/serverless).
Uses built-in SQLite database for persistent conversation history and user settings.

## Setup

1. **Enable Serverless** — open @BotFather → your bot → Serverless → turn it on
2. **Link project** — `npx tgcloud login` (paste the CLI access token from BotFather)
3. **Set env vars** — in BotFather → your bot → Serverless → env:
   - `OPENROUTER_API_KEY` = your OpenRouter key
   - `DEFAULT_MODEL` = `openrouter/free`
4. **Deploy** — `npm run deploy`
5. **Migrate DB** — `npm run migrate`

## Commands

- `/start` — reset everything
- `/help` — show all commands
- `/model` — show current model
- `/model <id>` — set custom model
- `/prompt` — show system prompt
- `/prompt <text>` — set custom system prompt
- `/prompt reset` — remove custom prompt
- `/new` — clear history
- `/exit` — reset everything

## Env Variables

Set in BotFather → Serverless → Environment:

| Variable | Required | Default | Description |
|---|---|---|---|
| `OPENROUTER_API_KEY` | Yes | — | OpenRouter API key |
| `DEFAULT_MODEL` | No | `openrouter/free` | Default model for new chats |
