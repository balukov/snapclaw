<p align="center">
  <img src="snapclaw-logo.png" alt="SnapClaw" width="300"/>
</p>

<p align="center"><em>Your own AI agent on Railway in 5 minutes</em></p>

<p align="center">
  One-click OpenClaw deploy for Railway + Telegram.<br/>
  No Docker, no terminal, no DevOps. Just deploy, connect, and chat.
</p>

<p align="center">
  <a href="https://railway.com/deploy/snapclaw" target="_blank">
    <img src="https://railway.com/button.svg" alt="Deploy on Railway"/>
  </a>
</p>

<p align="center">
  ⭐ If SnapClaw helped you, please star the repo — it genuinely helps more people discover it.
</p>

> Already used in **19 Railway deployments**, with **16 currently active**.

## Why SnapClaw

[OpenClaw](https://openclaw.ai) is powerful, but not everyone wants to deal with Docker, terminals, or infrastructure setup.

SnapClaw gives you the fastest path to a working personal AI agent:

- Deploy on Railway in one click
- Connect your ChatGPT account
- Add a Telegram bot
- Start chatting with your own assistant

## Who it’s for

SnapClaw is for people who want a personal AI agent without infra pain:

- indie hackers
- makers
- technical founders
- QA / dev / product people
- anyone who wants an AI assistant in Telegram fast

## What you need

- [Railway](https://railway.app) account
- [ChatGPT](https://chat.openai.com) subscription for Codex OAuth
- [Telegram](https://telegram.org) app

## Deploy

1. Click **Deploy on Railway**
2. Set two environment variables:
   - `SETUP_PASSWORD` — password for the admin panel
   - `OPENCLAW_GATEWAY_TOKEN` — any random string
3. Wait for the deploy to finish

## Setup

In Railway, open **Settings > Networking** and open your public domain.  
Log in with your `SETUP_PASSWORD`.

### Step 1: Connect Codex

- Click **Connect**
- Copy the OAuth URL
- Sign in with your ChatGPT account
- Paste the redirect URL back

### Step 2: Add Telegram Bot

- Create a bot with [@BotFather](https://t.me/BotFather) using `/newbot`
- Paste the bot token into SnapClaw
- Send a message to your bot to get a pairing code
- Enter the code and click **Approve**

Done. Your AI agent is live in Telegram and the Web UI.

## What gets persisted

Everything is stored on a Railway Volume at `/data` and survives redeploys:

- conversations
- memory
- config
- credentials
- skills
- workspace

## Why people like it

- no Docker setup
- no local terminal work
- no VPS maintenance
- fast path from zero to working agent
- persists data across redeploys

## FAQ

### Do I need Docker?
No.

### Do I need to use a terminal?
No.

### Do I need DevOps experience?
No. Railway handles deployment.

### Can I update later?
Yes, just redeploy.

## Credits

- [OpenClaw](https://openclaw.ai)
- [OpenClaw GitHub](https://github.com/openclaw/openclaw)
- SnapClaw by [@balukov](https://github.com/balukov)

---

If you deploy SnapClaw and it helps you, give the repo a star ⭐
