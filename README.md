<p align="center">
  <img src="snapclaw-logo.png" alt="SnapClaw" width="300"/>
</p>

<p align="center"><em>Production-ready OpenClaw on Railway</em></p>

<p align="center">
  <a href="https://railway.com/deploy/snapclaw">
    <img src="https://railway.com/button.svg" alt="Deploy on Railway"/>
  </a>
</p>

Deploy your own AI agent in minutes. Click the button, follow the steps, talk to your bot.

## Step 1 — Deploy (~2 min)

1. Click **Deploy on Railway** button above
2. Click **Deploy Now** in Railway
3. Click **Configure** → set environment variables:
   - `SETUP_PASSWORD` — create a password for the admin panel
   - `OPENCLAW_GATEWAY_TOKEN` — any random token ([generate one here](https://www.uuidgenerator.net/))
4. Click **Deploy**
5. Wait for the build to finish

## Step 2 — Setup (~5 min)

1. Go to Railway dashboard → your service → **Settings → Networking** → click your domain link
2. Log in with any username and your `SETUP_PASSWORD`
3. Click **"Start setup"** — this opens an interactive terminal in your browser
4. Follow the prompts to choose an AI provider, add channels, and configure your bot

The setup wizard will guide you through everything — no CLI or SSH needed.

<details>
<summary><strong>Answers for quick setup</strong></summary>

1. **"I understand this is personal-by-default..."** → Yes
2. **Setup mode** → QuickStart
3. **OpenAI Codex OAuth** — copy the URL, paste in your browser
   - Log into ChatGPT
   - Click **"Sign in to Codex with ChatGPT"** (don't worry about the empty screen after sign-in)
   - Copy the redirect URL from your browser
   - Paste it back in the terminal
4. **Select channel** → Telegram
5. **"How do you want to provide this Telegram bot token?"** → select **"Enter Telegram bot token"**
6. Create your bot:
   - Open Telegram, search for **@BotFather** (official bot with blue checkmark)
   - Start chat → send `/newbot`
   - Enter a bot name (doesn't need to be unique)
   - Enter a bot username (must be unique, must end with `_bot`)
   - Click on the token to copy it (looks like `123456:ABC...`)
7. Paste the token in the terminal
8. **Search provider** → DuckDuckGo Search (free, no API key needed)
9. **Configure skills** → No (defaults are enough, add more later)
10. **Enable hooks** → select **session-memory** (helps the bot remember you), skip the rest
11. **Hatch your bot** → Do this later

</details>

## Step 3 — Approve devices (~1 min)

After setup completes, the page moves to the Approve step:

**Telegram:**
1. Open your bot in Telegram → click **Start** → it shows a pairing code
2. Enter the code on the setup page → click **Approve**

**Web UI:**
1. Click **"Open Web UI"** link on the setup page (creates a pairing request)
2. Come back to the setup page → click **"Refresh pending devices"** → click **Approve**

## Step 4 — Talk to your bot (you're done!)

- **Telegram** — message your bot
- **Web UI** — open your Railway domain link

---

## What's included

- **OpenClaw Gateway + Control UI** — full AI agent platform
- **Interactive setup wizard** at `/setup` with embedded terminal
- **Built-in browser automation** — Playwright + Chromium
- **Persistent storage** — config, credentials, memory survive redeploys

## Tech stack

- **TypeScript** — server and client
- **Node.js 22** — runtime
- **OpenClaw** — AI agent framework (installed via npm)
- **Playwright** — browser automation
- **xterm.js** — embedded terminal
- **node-pty** — PTY backend for terminal

## Best practices

| AI Provider | Cost | Notes |
|---|---|---|
| **OpenAI Codex OAuth** | Free (ChatGPT sub) | Recommended — auto-refreshes tokens |
| **Anthropic API key** | Pay per token | Simple, reliable, no expiry |
| **OpenAI API key** | Pay per token | Simple, reliable, no expiry |

## Troubleshooting

**502 Bad Gateway** — Check Settings → Networking port. Ensure Volume is mounted at `/data`.

**"pairing required"** — Visit `/setup` → Step 2 → approve your devices.

## Persistence

Only `/data` (Railway Volume) survives redeploys.

**Persists:** config, credentials, sessions, memory, workspace

**Does not persist:** `apt-get` packages, `~/.cache/`, `/tmp/`

## Credits

- **OpenClaw**: [openclaw.ai](https://openclaw.ai) | [GitHub](https://github.com/openclaw/openclaw)
- **SnapClaw**: maintained by [@balukov](https://github.com/balukov)
