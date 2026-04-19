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

// --- Helpers ---

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

function setLoading(btn: HTMLButtonElement, loading: boolean, text: string): void {
  btn.disabled = loading;
  if (loading) {
    btn.innerHTML = '<span class="spinner"></span>' + text;
  } else {
    btn.textContent = text;
  }
}

// --- Status ---

interface StatusResponse {
  configured: boolean;
  codexConnected: boolean;
  channelsReady: boolean;
  botTokenSet: boolean;
  model?: string | null;
  openclawVersion?: string;
}

let lastStatus: StatusResponse | null = null;

async function refreshStatus(): Promise<StatusResponse | null> {
  $("status").textContent = "Loading...";
  try {
    const j = await httpJson<StatusResponse>("/snapclaw/api/status");
    lastStatus = j;
    const ver = j.openclawVersion ?? "";
    $("status").textContent = j.configured
      ? (j.channelsReady ? `Ready ${ver}` : `Configured ${ver}`)
      : `Setting up... ${ver}`;
    $("statusBar").classList.toggle("configured", !!j.configured);
    return j;
  } catch (e) {
    $("status").textContent = `Error: ${e}`;
    return null;
  }
}

function restoreUI(s: StatusResponse): void {
  // Codex state
  if (s.codexConnected) {
    $("codexStart").classList.add("hidden");
    $("codexOauth").classList.add("hidden");
    const modelLabel = typeof s.model === "string" && s.model ? s.model : "Connected";
    setBadge($("codexStatus"), "success", modelLabel);
    $("codexStep").classList.add("done");
  }

  // Telegram state
  if (s.channelsReady) {
    // Fully connected and paired
    $("telegramSetup").classList.add("hidden");
    $("telegramPairing").classList.add("hidden");
    setBadge($("telegramStatus"), "success", "Telegram");
    $("telegramStep").classList.add("done");
  } else if (s.botTokenSet) {
    // Token set but not yet paired
    ($("telegramToken") as HTMLInputElement).disabled = true;
    ($("telegramConnectBtn") as HTMLButtonElement).classList.add("hidden");
    setBadge($("telegramStatus"), "pending", "Waiting for pairing code...");
    $("telegramPairing").classList.remove("hidden");
  }
}

// --- Codex OAuth ---

$("codexStartBtn").onclick = async () => {
  const btn = $("codexStartBtn") as HTMLButtonElement;
  setLoading(btn, true, "Starting...");
  $("codexOutput").classList.add("hidden");

  try {
    const r = await httpJson<{
      ok: boolean;
      oauthUrl: string | null;
      status: string;
      error?: string;
    }>("/snapclaw/api/codex/start", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });

    if (r.oauthUrl) {
      ($("codexOauthUrl") as HTMLInputElement).value = r.oauthUrl;
      $("codexOauth").classList.remove("hidden");
      $("codexStart").classList.add("hidden");
      setBadge($("codexStatus"), "pending", "Waiting for sign-in...");
    } else if (r.status === "done") {
      setBadge($("codexStatus"), "success", "Connected");
      $("codexStart").classList.add("hidden");
      $("codexStep").classList.add("done");
      await refreshStatus();
    } else {
      showOutput($("codexOutput"), r.error ?? "No OAuth URL found. Try again.");
      setLoading(btn, false, "Connect");
    }
  } catch (e) {
    showOutput($("codexOutput"), `Error: ${e}`);
    setLoading(btn, false, "Connect");
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
  setLoading(btn, true, "Verifying...");

  try {
    const r = await httpJson<{ ok: boolean; status: string }>(
      "/snapclaw/api/codex/callback",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ redirectUrl }),
      },
    );

    if (r.ok) {
      setBadge($("codexStatus"), "success", "Connected");
      $("codexOauth").classList.add("hidden");
      $("codexStep").classList.add("done");
      await refreshStatus();
    } else {
      showOutput($("codexOutput"), "Authentication failed. Try again.");
      $("codexOauth").classList.add("hidden");
      $("codexStart").classList.remove("hidden");
      setLoading($("codexStartBtn") as HTMLButtonElement, false, "Connect");
      setLoading(btn, false, "Done");
    }
  } catch (e) {
    showOutput($("codexOutput"), `Error: ${e}`);
    setLoading(btn, false, "Done");
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
  setLoading(btn, true, "Connecting...");
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
      // Token saved, now show pairing section
      ($("telegramToken") as HTMLInputElement).disabled = true;
      btn.classList.add("hidden");
      setBadge($("telegramStatus"), "pending", "Waiting for pairing code...");
      $("telegramPairing").classList.remove("hidden");
    } else {
      showOutput($("telegramOutput"), r.output);
      setLoading(btn, false, "Connect");
    }
  } catch (e) {
    showOutput($("telegramOutput"), `Error: ${e}`);
    setLoading(btn, false, "Connect");
  }
};

$("telegramApproveBtn").onclick = async () => {
  const code = ($("telegramPairingCode") as HTMLInputElement).value.trim().toUpperCase();
  if (!code) {
    alert("Enter the pairing code from Telegram.");
    return;
  }

  const btn = $("telegramApproveBtn") as HTMLButtonElement;
  setLoading(btn, true, "Approving...");
  $("telegramOutput").classList.add("hidden");

  try {
    const r = await httpJson<{ ok: boolean; output: string }>(
      "/snapclaw/api/pairing/approve",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ channel: "telegram", code }),
      },
    );

    if (r.ok) {
      setBadge($("telegramStatus"), "success", "Connected");
      $("telegramPairing").classList.add("hidden");
      $("telegramStep").classList.add("done");
      await refreshStatus();
    } else {
      showOutput($("telegramOutput"), r.output || "Pairing failed. Check the code and try again.");
      setLoading(btn, false, "Approve");
    }
  } catch (e) {
    showOutput($("telegramOutput"), `Error: ${e}`);
    setLoading(btn, false, "Approve");
  }
};

// --- Dashboard (shown when already configured) ---

let dashTerm: InstanceType<typeof Terminal> | null = null;
let dashWs: WebSocket | null = null;
let dashFit: ReturnType<typeof FitAddon.FitAddon.prototype.constructor> | null = null;

function showDashboard(): void {
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

refreshStatus().then((s) => {
  if (!s) return;
  restoreUI(s);
  // Terminal/admin should be reachable any time the agent is configured,
  // not only when channels are ready — so the user can diagnose from setup.
  if (s.configured) {
    showDashboard();
  }
});
