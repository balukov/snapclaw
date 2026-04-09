declare const Terminal: new (opts: Record<string, unknown>) => {
  open(el: HTMLElement): void;
  loadAddon(addon: unknown): void;
  clear(): void;
  write(data: string): void;
  writeln(data: string): void;
  onData(cb: (data: string) => void): void;
  onResize(cb: (size: { cols: number; rows: number }) => void): void;
};

declare const FitAddon: {
  FitAddon: new () => {
    fit(): void;
    proposeDimensions(): { cols: number; rows: number } | undefined;
  };
};

const $ = (id: string) => document.getElementById(id)!;

let isConfigured = false;
let hasChannels = false;

// --- HTTP ---

async function httpJson<T = Record<string, unknown>>(
  url: string,
  opts?: RequestInit,
): Promise<T> {
  const res = await fetch(url, { credentials: "same-origin", ...opts });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`HTTP ${res.status}: ${text}`);
  }
  return res.json() as Promise<T>;
}

// --- Status ---

async function refreshStatus(): Promise<void> {
  $("status").textContent = "Loading...";
  try {
    const j = await httpJson<{
      configured: boolean;
      channelsReady: boolean;
      openclawVersion?: string;
    }>("/snapclaw/api/status");

    isConfigured = !!j.configured;
    hasChannels = !!j.channelsReady;
    const ver = j.openclawVersion ? j.openclawVersion : "";
    $("status").textContent = j.configured ? `Ready ${ver}` : "Setting up...";
    $("statusBar").classList.toggle("configured", !!j.configured);
  } catch (e) {
    $("status").textContent = `Error: ${e}`;
  }
}

function setBadge(el: HTMLElement, type: "success" | "pending", text: string): void {
  el.innerHTML = "";
  const badge = document.createElement("span");
  badge.className = `status-badge ${type}`;
  badge.textContent = text;
  el.appendChild(badge);
}

function showOutput(el: HTMLElement, text: string): void {
  el.classList.remove("hidden");
  el.textContent = text;
}

// --- Codex OAuth ---

$("codexStartBtn").onclick = async () => {
  const btn = $("codexStartBtn") as HTMLButtonElement;
  btn.disabled = true;
  btn.textContent = "Starting...";
  $("codexOutput").classList.add("hidden");

  try {
    const r = await httpJson<{
      ok: boolean;
      oauthUrl: string | null;
      status: string;
      output?: string;
    }>("/snapclaw/api/codex/start", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });

    if (r.oauthUrl) {
      ($("codexOauthUrl") as HTMLInputElement).value = r.oauthUrl;
      $("codexUrl").classList.remove("hidden");
      $("codexStart").classList.add("hidden");
      setBadge($("codexStatus"), "pending", "Waiting for redirect URL...");
    } else if (r.status === "done") {
      setBadge($("codexStatus"), "success", "Connected");
      $("codexStart").classList.add("hidden");
      await refreshStatus();
    } else {
      showOutput($("codexOutput"), r.output ?? "No OAuth URL found. Try again.");
      btn.disabled = false;
      btn.textContent = "Start OAuth";
    }
  } catch (e) {
    showOutput($("codexOutput"), `Error: ${e}`);
    btn.disabled = false;
    btn.textContent = "Start OAuth";
  }
};

$("codexCopyBtn").onclick = () => {
  const input = $("codexOauthUrl") as HTMLInputElement;
  navigator.clipboard.writeText(input.value).then(() => {
    $("codexCopyBtn").textContent = "Copied!";
    setTimeout(() => { $("codexCopyBtn").textContent = "Copy"; }, 2000);
  });
};

$("codexCompleteBtn").onclick = async () => {
  const redirectUrl = ($("codexRedirectUrl") as HTMLInputElement).value.trim();
  if (!redirectUrl) {
    alert("Paste the redirect URL first.");
    return;
  }

  const btn = $("codexCompleteBtn") as HTMLButtonElement;
  btn.disabled = true;
  btn.textContent = "Verifying...";

  try {
    const r = await httpJson<{ ok: boolean; output: string }>(
      "/snapclaw/api/codex/callback",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ redirectUrl }),
      },
    );

    if (r.ok) {
      setBadge($("codexStatus"), "success", "Connected");
      $("codexUrl").classList.add("hidden");
      await refreshStatus();
    } else {
      showOutput($("codexOutput"), r.output);
      btn.disabled = false;
      btn.textContent = "Done";
    }
  } catch (e) {
    showOutput($("codexOutput"), `Error: ${e}`);
    btn.disabled = false;
    btn.textContent = "Done";
  }
};

// --- Telegram ---

$("telegramConnectBtn").onclick = async () => {
  const token = ($("telegramToken") as HTMLInputElement).value.trim();
  if (!token) {
    alert("Paste your bot token first.");
    return;
  }

  const btn = $("telegramConnectBtn") as HTMLButtonElement;
  btn.disabled = true;
  btn.textContent = "Connecting...";
  $("telegramOutput").classList.add("hidden");

  try {
    const r = await httpJson<{ ok: boolean; output: string }>(
      "/snapclaw/api/telegram/add",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ token }),
      },
    );

    if (r.ok) {
      setBadge($("telegramStatus"), "success", "Bot connected");
      ($("telegramToken") as HTMLInputElement).disabled = true;
      btn.classList.add("hidden");
      await refreshStatus();
    } else {
      showOutput($("telegramOutput"), r.output);
      btn.disabled = false;
      btn.textContent = "Connect";
    }
  } catch (e) {
    showOutput($("telegramOutput"), `Error: ${e}`);
    btn.disabled = false;
    btn.textContent = "Connect";
  }
};

// --- Check Telegram status on load ---

async function checkTelegram(): Promise<void> {
  try {
    const r = await httpJson<{ connected: boolean }>("/snapclaw/api/telegram/verify");
    if (r.connected) {
      setBadge($("telegramStatus"), "success", "Bot connected");
      ($("telegramToken") as HTMLInputElement).disabled = true;
      $("telegramConnectBtn").classList.add("hidden");
    }
  } catch {}
}

// --- Dashboard (shown when already configured) ---

let dashTerm: InstanceType<typeof Terminal> | null = null;
let dashWs: WebSocket | null = null;
let dashFit: ReturnType<typeof FitAddon.FitAddon.prototype.constructor> | null = null;

function showDashboard(): void {
  $("setupCards").classList.add("hidden");
  $("dashboard").classList.remove("hidden");
}

function connectDashTerminal(): void {
  if (dashWs && dashWs.readyState <= WebSocket.OPEN) return;

  $("dashTermContainer").classList.remove("hidden");

  if (!dashTerm) {
    dashTerm = new Terminal({
      cursorBlink: true,
      fontSize: 14,
      fontFamily: "JetBrains Mono, monospace",
      theme: {
        background: "#0c0e14",
        foreground: "#e8e6e3",
        cursor: "#e85d3a",
        selectionBackground: "rgba(232,93,58,0.25)",
      },
      convertEol: true,
    });
    dashFit = new FitAddon.FitAddon();
    dashTerm.loadAddon(dashFit);
    dashTerm.open($("dashTerminal"));
    dashFit.fit();
    window.addEventListener("resize", () => dashFit?.fit());
  }

  dashTerm.clear();
  dashTerm.writeln("\x1b[1;32mConnecting...\x1b[0m\r\n");

  const proto = location.protocol === "https:" ? "wss:" : "ws:";
  httpJson<{ token: string }>("/snapclaw/api/terminal-token")
    .then((j) => {
      const url = `${proto}//${location.host}/snapclaw/terminal?token=${encodeURIComponent(j.token)}`;
      dashWs = new WebSocket(url);

      dashWs.onopen = () => {
        dashTerm!.writeln("\x1b[1;32mConnected!\x1b[0m\r\n");
        const dims = dashFit!.proposeDimensions();
        if (dims)
          dashWs!.send(JSON.stringify({ type: "resize", cols: dims.cols, rows: dims.rows }));
      };
      dashWs.onmessage = (e: MessageEvent) => dashTerm!.write(e.data as string);
      dashWs.onclose = () => dashTerm!.writeln("\r\n\x1b[1;33mDisconnected.\x1b[0m");
      dashWs.onerror = () => dashTerm!.writeln("\r\n\x1b[1;31mConnection error.\x1b[0m");
      dashTerm!.onData((d: string) => {
        if (dashWs && dashWs.readyState === WebSocket.OPEN) dashWs.send(d);
      });
      dashTerm!.onResize((s: { cols: number; rows: number }) => {
        if (dashWs && dashWs.readyState === WebSocket.OPEN)
          dashWs.send(JSON.stringify({ type: "resize", cols: s.cols, rows: s.rows }));
      });
    })
    .catch((e: Error) => dashTerm!.writeln(`\x1b[1;31mFailed: ${e}\x1b[0m`));
}

$("dashShell").onclick = () => connectDashTerminal();
$("dashRestart").onclick = async () => {
  const out = $("dashOutput");
  out.classList.remove("hidden");
  out.textContent = "Restarting gateway...";
  try {
    const r = await httpJson<{ output: string }>("/snapclaw/api/console/run", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ cmd: "gateway.restart", arg: "" }),
    });
    out.textContent = r.output ?? "Gateway restarted.";
    await refreshStatus();
  } catch (e) {
    out.textContent = `Error: ${e}`;
  }
};

// --- Init ---

refreshStatus().then(() => {
  if (hasChannels) {
    showDashboard();
  } else {
    checkTelegram();
  }
});
