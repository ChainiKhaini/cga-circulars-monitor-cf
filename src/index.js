/**
 * CGA Circulars Monitor — Cloudflare Worker
 * ==========================================
 * Monitors https://cga.gov.in/Circular/Published/9350.aspx
 * for new orders/circulars and sends Telegram push notifications.
 *
 * State is stored in Cloudflare KV (binding: CGA_STORE).
 * Telegram credentials are stored as Worker Secrets.
 */

// ─── Constants ──────────────────────────────────────────────
const KV_KEY_SEEN = "seen_urls";
const KV_KEY_META = "meta";

const DASHBOARD_CSS = `
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body {
    font-family: 'Segoe UI', system-ui, sans-serif;
    background: #0f172a;
    color: #e2e8f0;
    min-height: 100vh;
    display: flex;
    align-items: center;
    justify-content: center;
  }
  .card {
    background: #1e293b;
    border: 1px solid #334155;
    border-radius: 16px;
    padding: 2.5rem;
    max-width: 480px;
    width: 90%;
    box-shadow: 0 25px 50px rgba(0,0,0,0.4);
  }
  h1 { font-size: 1.5rem; margin-bottom: 1.5rem; }
  h1 span { color: #38bdf8; }
  .stat {
    display: flex;
    justify-content: space-between;
    padding: 0.75rem 0;
    border-bottom: 1px solid #334155;
  }
  .stat:last-child { border-bottom: none; }
  .label { color: #94a3b8; }
  .value { font-weight: 600; color: #f1f5f9; }
  .value.healthy { color: #4ade80; }
  .value.degraded { color: #f87171; }
  .error-box {
    margin-top: 1rem;
    padding: 0.75rem;
    background: rgba(248, 113, 113, 0.1);
    border: 1px solid rgba(248, 113, 113, 0.3);
    border-radius: 8px;
    font-size: 0.85rem;
    color: #f87171;
    word-break: break-all;
  }
  .actions { margin-top: 1.5rem; display: flex; gap: 0.75rem; }
  a.btn {
    display: inline-block;
    padding: 0.6rem 1.2rem;
    border-radius: 8px;
    text-decoration: none;
    font-size: 0.875rem;
    font-weight: 500;
    transition: all 0.2s;
  }
  .btn-primary {
    background: #2563eb;
    color: #fff;
  }
  .btn-primary:hover { background: #1d4ed8; }
  .btn-ghost {
    background: transparent;
    color: #38bdf8;
    border: 1px solid #334155;
  }
  .btn-ghost:hover { background: #334155; }
  .footer {
    margin-top: 1.5rem;
    font-size: 0.75rem;
    color: #64748b;
    text-align: center;
  }
  .recent-section {
    margin-top: 1.5rem;
    border-top: 1px solid #334155;
    padding-top: 1rem;
  }
  .recent-section h2 {
    font-size: 1rem;
    margin-bottom: 0.75rem;
    color: #94a3b8;
  }
  .recent-list {
    list-style: none;
    padding: 0;
  }
  .recent-list li {
    padding: 0.5rem 0;
    border-bottom: 1px solid #1e293b;
    font-size: 0.85rem;
    line-height: 1.4;
  }
  .recent-list li:last-child {
    border-bottom: none;
  }
  .recent-list a {
    color: #38bdf8;
    text-decoration: none;
  }
  .recent-list a:hover {
    text-decoration: underline;
  }
  .recent-list .date {
    font-size: 0.75rem;
    color: #64748b;
    display: block;
    margin-top: 2px;
  }
`;

// ─── Helper Functions ───────────────────────────────────────

/**
 * Escapes characters for safe interpolation into HTML mode on Telegram.
 */
function escapeHtml(text) {
  if (!text) return "";
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

/**
 * Constant-time comparison for Authorization tokens.
 */
function secureCompare(a, b) {
  if (!a || !b || a.length !== b.length) return false;
  let result = 0;
  for (let i = 0; i < a.length; i++) {
    result |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return result === 0;
}

/**
 * Compute SHA-256 digest of sorted URL list.
 */
async function computeDigest(urls) {
  const sorted = [...urls].sort();
  const encoder = new TextEncoder();
  const data = encoder.encode(sorted.join("\n"));
  const hashBuffer = await crypto.subtle.digest("SHA-256", data);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map(b => b.toString(16).padStart(2, "0")).join("");
}

// ─── HTML Parsing ───────────────────────────────────────────

/**
 * Parse circulars from the CGA page HTML using streaming HTMLRewriter
 */
async function parseCirculars(response, pageUrl) {
  let inLink = false;
  let currentTitle = "";
  let currentHref = "";
  const circulars = [];
  const seenOnPage = new Set();

  const rewriter = new HTMLRewriter()
    .on(".whats-new-inner a", {
      element(el) {
        currentHref = el.getAttribute("href") || "";
        currentTitle = "";
        inLink = true;
        el.onEndTag(() => {
          inLink = false;
          if (currentHref) {
            try {
              const urlObj = new URL(currentHref, pageUrl);
              if (urlObj.protocol === "http:" || urlObj.protocol === "https:") {
                const host = urlObj.hostname.toLowerCase();
                if (host === "cga.gov.in" || host.endsWith(".cga.gov.in")) {
                  urlObj.protocol = "https:";
                  urlObj.hash = "";
                  const fullUrl = urlObj.toString();
                  const cleanedTitle = currentTitle.replace(/\s+/g, " ").trim();
                  if (cleanedTitle && !seenOnPage.has(fullUrl)) {
                    seenOnPage.add(fullUrl);
                    circulars.push({
                      title: cleanedTitle,
                      url: fullUrl
                    });
                  }
                }
              }
            } catch (e) {
              // Ignore malformed URL
            }
          }
        });
      }
    })
    .on(".whats-new-inner", {
      text(t) {
        if (inLink) {
          currentTitle += t.text;
        }
      }
    });

  const transformed = rewriter.transform(response);
  await transformed.arrayBuffer(); // Drive the stream
  return circulars;
}

// ─── Telegram ───────────────────────────────────────────────

/**
 * Sends a message via Telegram Bot API with AbortSignal timeout and retries.
 * Safe from throwing errors or leaking tokens.
 */
async function sendTelegram(botToken, chatId, message) {
  if (!botToken || !chatId) {
    console.warn("Telegram credentials not configured");
    return false;
  }

  const url = `https://api.telegram.org/bot${botToken}/sendMessage`;
  const maxAttempts = 3;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 10000);

      const resp = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          chat_id: chatId,
          text: message,
          parse_mode: "HTML",
          disable_web_page_preview: true,
        }),
        signal: controller.signal
      });

      clearTimeout(timeoutId);

      if (resp.ok) {
        return true;
      }

      const status = resp.status;
      let bodyText = "";
      try {
        bodyText = await resp.text();
      } catch (_) {}

      console.error(`Telegram API error status=${status} body=${bodyText.substring(0, 200)}`);

      if (status === 429 && attempt < maxAttempts) {
        let retryAfter = 5;
        try {
          const resJson = JSON.parse(bodyText);
          if (resJson?.parameters?.retry_after) {
            retryAfter = Math.min(resJson.parameters.retry_after, 10);
          }
        } catch (_) {}
        console.warn(`Telegram 429: Retrying after ${retryAfter}s (attempt ${attempt}/${maxAttempts})`);
        await new Promise(resolve => setTimeout(resolve, retryAfter * 1000));
        continue;
      }

      if (status >= 500 && attempt < maxAttempts) {
        const backoff = attempt * 2;
        console.warn(`Telegram 5xx: Retrying after ${backoff}s (attempt ${attempt}/${maxAttempts})`);
        await new Promise(resolve => setTimeout(resolve, backoff * 1000));
        continue;
      }

      return false;
    } catch (err) {
      console.error(`Telegram fetch attempt ${attempt}/${maxAttempts} failed: ${err.message || "Timeout/Network Error"}`);
      if (attempt < maxAttempts) {
        const backoff = attempt * 2;
        await new Promise(resolve => setTimeout(resolve, backoff * 1000));
      }
    }
  }

  return false;
}

/**
 * Builds formatted and length-restricted Telegram HTML notification chunks.
 */
function buildMessages(circulars, cgaUrl) {
  const maxMessageLength = 3800;
  const messages = [];

  const escapedCgaUrl = escapeHtml(cgaUrl);

  function getEscapedTitle(title) {
    const clean = title.trim();
    return clean.length > 180 
      ? escapeHtml(clean.substring(0, 180) + "...") 
      : escapeHtml(clean);
  }

  const header = `📢 <b>${circulars.length} New CGA Circular${circulars.length > 1 ? "s" : ""}</b>\n\n`;
  const footer = `\n🌐 <a href="${escapedCgaUrl}">View All Circulars</a>`;
  
  let currentChunk = [];
  let currentChunkLen = header.length + footer.length;

  for (let i = 0; i < circulars.length; i++) {
    const line = `${i + 1}. <a href="${escapeHtml(circulars[i].url)}">${getEscapedTitle(circulars[i].title)}</a>\n`;
    if (currentChunkLen + line.length > maxMessageLength) {
      messages.push(header + currentChunk.join("") + footer);
      currentChunk = [line];
      currentChunkLen = header.length + footer.length + line.length;
    } else {
      currentChunk.push(line);
      currentChunkLen += line.length;
    }
  }
  if (currentChunk.length > 0) {
    messages.push(header + currentChunk.join("") + footer);
  }
  return messages;
}

// ─── KV Helpers ─────────────────────────────────────────────

async function loadSeenUrls(kv) {
  const data = await kv.get(KV_KEY_SEEN, { type: "json" });
  return data ? new Set(data) : null;
}

async function saveSeenUrls(kv, urlsSet) {
  let urls = [...urlsSet];
  if (urls.length > 2000) {
    urls = urls.slice(urls.length - 2000);
  }
  await kv.put(KV_KEY_SEEN, JSON.stringify(urls));
}

async function loadMeta(kv) {
  return await kv.get(KV_KEY_META, { type: "json", cacheTtl: 60 });
}

async function saveMeta(kv, meta) {
  await kv.put(KV_KEY_META, JSON.stringify(meta));
}

// ─── Main Pipeline ──────────────────────────────────────────

async function checkForUpdates(env) {
  return await runCheckPipeline(env);
}

async function runCheckPipeline(env) {
  const cgaUrl = env.CGA_URL || "https://cga.gov.in/Circular/Published/9350.aspx";
  const botToken = env.TELEGRAM_BOT_TOKEN;
  const chatId = env.TELEGRAM_CHAT_ID;
  const kv = env.CGA_STORE;

  let maxNotifications = 10;
  const parsedMax = parseInt(env.MAX_NOTIFICATIONS, 10);
  if (Number.isFinite(parsedMax)) {
    maxNotifications = Math.max(1, Math.min(parsedMax, 50));
  }

  const meta = await loadMeta(kv) || {};
  const consecutiveEmptyRuns = meta.consecutiveEmptyRuns || 0;
  const consecutiveErrors = meta.consecutiveErrors || 0;

  // 1. Fetch page with ETag support and Timeout
  let resp;
  const headers = {
    "User-Agent":
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
    Accept: "text/html,application/xhtml+xml",
  };
  if (meta.etag) {
    headers["If-None-Match"] = meta.etag;
  }

  try {
    resp = await fetch(cgaUrl, {
      headers,
      signal: AbortSignal.timeout(30000)
    });
  } catch (err) {
    console.error(`Fetch error: ${err.message}`);
    await handleFailure(kv, meta, `Fetch failed: ${err.message || err}`, botToken, chatId, cgaUrl);
    return { success: false, error: err.message };
  }

  // Handle 304 Not Modified
  if (resp.status === 304) {
    console.log("304 Not Modified. Short-circuiting.");
    const { firstRun, ...cleanMeta } = meta;
    await saveMeta(kv, {
      ...cleanMeta,
      lastCheck: new Date().toISOString(),
      consecutiveErrors: 0,
      lastError: ""
    });
    return { success: true, found: meta.totalTracked || 0, new: 0, cached: true };
  }

  if (!resp.ok) {
    console.error(`Failed to fetch CGA page: ${resp.status}`);
    await handleFailure(kv, meta, `HTTP status ${resp.status}`, botToken, chatId, cgaUrl);
    return { success: false, error: `HTTP ${resp.status}` };
  }

  // 2. Parse circulars streamingly
  let circulars;
  try {
    circulars = await parseCirculars(resp, cgaUrl);
  } catch (err) {
    console.error(`Parsing error: ${err.message}`);
    await handleFailure(kv, meta, `Parse failed: ${err.message}`, botToken, chatId, cgaUrl);
    return { success: false, error: err.message };
  }

  console.log(`Found ${circulars.length} circulars on page`);

  // 3. Handle zero circulars (Dead-man's switch)
  if (circulars.length === 0) {
    const emptyCount = consecutiveEmptyRuns + 1;
    await saveMeta(kv, {
      ...meta,
      lastCheck: new Date().toISOString(),
      consecutiveEmptyRuns: emptyCount,
      lastError: "Zero circulars found by parser"
    });
    
    if (emptyCount >= 6 && emptyCount % 6 === 0 && botToken && chatId) {
      const deadmanMsg = `⚠️ <b>CGA Monitor Alert:</b> ${emptyCount} consecutive runs found zero circulars. The parser is likely broken.\n\n🌐 <a href="${escapeHtml(cgaUrl)}">CGA Website</a>`;
      await sendTelegram(botToken, chatId, deadmanMsg);
    }
    
    return { success: false, error: "Zero circulars found" };
  }

  // 4. Compute digest for short-circuiting
  const currentUrlsList = circulars.map(c => c.url);
  const currentDigest = await computeDigest(currentUrlsList);

  if (meta.digest && meta.digest === currentDigest) {
    console.log("Digest match. Short-circuiting.");
    const { firstRun, ...cleanMeta } = meta;
    await saveMeta(kv, {
      ...cleanMeta,
      lastCheck: new Date().toISOString(),
      consecutiveEmptyRuns: 0,
      consecutiveErrors: 0,
      lastError: ""
    });
    return { success: true, found: circulars.length, new: 0, cached: true };
  }

  // 5. Load seen list
  const seenUrls = await loadSeenUrls(kv);
  const isFirstRun = seenUrls === null;
  const currentUrlsSet = new Set(currentUrlsList);

  if (isFirstRun) {
    console.log(`First run — saving ${circulars.length} circulars as baseline`);
    await saveSeenUrls(kv, currentUrlsSet);
    
    const newMeta = {
      lastCheck: new Date().toISOString(),
      totalTracked: circulars.length,
      firstRun: true,
      consecutiveEmptyRuns: 0,
      consecutiveErrors: 0,
      lastError: "",
      digest: currentDigest,
      etag: resp.headers.get("ETag") || ""
    };
    await saveMeta(kv, newMeta);

    // Send confirmation
    if (botToken && chatId) {
      const confirmMsg = [
        `✅ <b>CGA Monitor Started!</b>`,
        ``,
        `Monitoring: ${escapeHtml(cgaUrl)}`,
        `Currently tracking <b>${circulars.length}</b> circulars.`,
        `You'll be notified when new circulars are posted.`,
        ``,
        `⏰ Checked and scheduled via Cloudflare Workers.`,
      ].join("\n");
      await sendTelegram(botToken, chatId, confirmMsg);
    }

    return { success: true, found: circulars.length, new: 0, firstRun: true };
  }

  // 6. Find new circulars
  const newCirculars = circulars.filter((c) => !seenUrls.has(c.url));

  if (newCirculars.length === 0) {
    console.log("No new circulars found");
    const { firstRun, ...cleanMeta } = meta;
    await saveMeta(kv, {
      ...cleanMeta,
      lastCheck: new Date().toISOString(),
      totalTracked: circulars.length,
      newFound: 0,
      consecutiveEmptyRuns: 0,
      consecutiveErrors: 0,
      lastError: "",
      digest: currentDigest,
      etag: resp.headers.get("ETag") || ""
    });
    return { success: true, found: circulars.length, new: 0 };
  }

  // 7. Send Telegram notifications & commit state
  const hasTelegramCreds = !!(botToken && chatId);
  let deliverySuccessful = true;

  if (hasTelegramCreds) {
    const toNotify = newCirculars.slice(0, maxNotifications);
    const messages = buildMessages(toNotify, cgaUrl);

    for (const msg of messages) {
      const success = await sendTelegram(botToken, chatId, msg);
      if (!success) {
        deliverySuccessful = false;
        break; // Stop immediately so we retry the whole batch on next cron run
      }
    }

    if (deliverySuccessful && newCirculars.length > maxNotifications) {
      const extra = newCirculars.length - maxNotifications;
      const extraMsg = `ℹ️ ...and ${extra} more new circulars. Visit the website to see all.`;
      await sendTelegram(botToken, chatId, extraMsg);
    }
  }

  if (deliverySuccessful) {
    for (const url of currentUrlsSet) {
      seenUrls.add(url);
    }
    await saveSeenUrls(kv, seenUrls);

    // Save recent circulars inside meta (prepend new ones, keep last 10)
    const existingRecent = meta.recent || [];
    const newEntries = newCirculars.map(c => ({
      title: c.title,
      url: c.url,
      detectedAt: new Date().toISOString()
    }));
    const updatedRecent = [...newEntries, ...existingRecent].slice(0, 10);

    const { firstRun, ...cleanMeta } = meta;
    await saveMeta(kv, {
      ...cleanMeta,
      lastCheck: new Date().toISOString(),
      totalTracked: circulars.length,
      newFound: newCirculars.length,
      recent: updatedRecent,
      consecutiveEmptyRuns: 0,
      consecutiveErrors: 0,
      lastError: "",
      digest: currentDigest,
      etag: resp.headers.get("ETag") || ""
    });

    return { success: true, found: circulars.length, new: newCirculars.length };
  } else {
    console.error("Telegram delivery failed. seen_urls not updated.");
    await handleFailure(kv, meta, "Telegram delivery failed", botToken, chatId, cgaUrl);
    return { success: false, error: "Telegram delivery failed" };
  }
}

async function handleFailure(kv, meta, errorMsg, botToken, chatId, cgaUrl) {
  const errorCount = (meta.consecutiveErrors || 0) + 1;
  const newMeta = {
    ...meta,
    lastCheck: new Date().toISOString(),
    consecutiveErrors: errorCount,
    lastError: errorMsg
  };
  await saveMeta(kv, newMeta);
  
  if (errorCount >= 6 && errorCount % 6 === 0 && botToken && chatId) {
    const deadmanMsg = `⚠️ <b>CGA Monitor Alert:</b> ${errorCount} consecutive errors occurred. Monitor might be failing.\nError: ${escapeHtml(errorMsg)}\n\n🌐 <a href="${escapeHtml(cgaUrl)}">CGA Website</a>`;
    await sendTelegram(botToken, chatId, deadmanMsg);
  }
}

// ─── Worker Entry Points ────────────────────────────────────

export default {
  /**
   * Cron trigger — runs according to the schedule configured in wrangler.toml
   */
  async scheduled(event, env, ctx) {
    ctx.waitUntil(
      checkForUpdates(env).catch(err => {
        console.error("Scheduled execution failed:", err);
      })
    );
  },

  /**
   * HTTP handler — allows manual trigger and status check
   *   GET /         → status page
   *   GET /check    → manually trigger a check (requires authentication)
   *   GET /status   → JSON status from KV
   */
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (url.pathname === "/check") {
      if (request.method !== "POST") {
        return new Response(JSON.stringify({ error: "Method Not Allowed" }, null, 2), {
          status: 405,
          headers: { 
            "Content-Type": "application/json",
            "Allow": "POST",
            "X-Content-Type-Options": "nosniff"
          }
        });
      }

      const authHeader = request.headers.get("Authorization") || "";
      const expectedToken = env.ADMIN_TOKEN;
      if (!expectedToken) {
        return new Response(JSON.stringify({ error: "Unauthorized (Admin token not set)" }, null, 2), {
          status: 401,
          headers: { 
            "Content-Type": "application/json",
            "X-Content-Type-Options": "nosniff"
          }
        });
      }
      
      const tokenPrefix = "Bearer ";
      if (!authHeader.startsWith(tokenPrefix)) {
        return new Response(JSON.stringify({ error: "Unauthorized" }, null, 2), {
          status: 401,
          headers: { 
            "Content-Type": "application/json",
            "X-Content-Type-Options": "nosniff"
          }
        });
      }
      
      const token = authHeader.substring(tokenPrefix.length);
      if (!secureCompare(token, expectedToken)) {
        return new Response(JSON.stringify({ error: "Unauthorized" }, null, 2), {
          status: 401,
          headers: { 
            "Content-Type": "application/json",
            "X-Content-Type-Options": "nosniff"
          }
        });
      }

      ctx.waitUntil(
        checkForUpdates(env).catch(err => {
          console.error("Manual check execution failed:", err);
        })
      );

      return new Response(JSON.stringify({ status: "Accepted" }, null, 2), {
        status: 202,
        headers: { 
          "Content-Type": "application/json",
          "X-Content-Type-Options": "nosniff"
        }
      });
    }

    if (url.pathname === "/recent") {
      const meta = await loadMeta(env.CGA_STORE);
      const recent = meta?.recent || [];
      return new Response(JSON.stringify(recent, null, 2), {
        headers: { 
          "Content-Type": "application/json",
          "Cache-Control": "max-age=60",
          "X-Content-Type-Options": "nosniff",
          "Referrer-Policy": "no-referrer"
        },
      });
    }

    if (url.pathname === "/status") {
      const meta = await loadMeta(env.CGA_STORE);
      return new Response(JSON.stringify(meta || { status: "no data yet" }, null, 2), {
        headers: { 
          "Content-Type": "application/json",
          "Cache-Control": "max-age=60",
          "X-Content-Type-Options": "nosniff",
          "Referrer-Policy": "no-referrer"
        },
      });
    }

    // Default: status page
    const metaData = await loadMeta(env.CGA_STORE) || {};
    const recent = metaData.recent || [];
    const lastCheck = metaData.lastCheck || "never";
    const tracked = metaData.totalTracked || 0;
    const lastNew = metaData.newFound ?? "—";
    const consecutiveErrors = metaData.consecutiveErrors || 0;
    const consecutiveEmptyRuns = metaData.consecutiveEmptyRuns || 0;
    const lastError = (consecutiveErrors > 0 || consecutiveEmptyRuns > 0) ? (metaData.lastError || "") : "";

    const isHealthy = consecutiveErrors < 6 && consecutiveEmptyRuns < 6;
    const healthText = isHealthy ? "Healthy" : "Degraded";
    const healthClass = isHealthy ? "healthy" : "degraded";

    const formattedLastCheck = lastCheck === "never" 
      ? "Never" 
      : escapeHtml(new Date(lastCheck).toLocaleString("en-IN", { timeZone: "Asia/Kolkata" }));

    let recentHtml = "";
    if (recent.length > 0) {
      const items = recent.map(c => {
        const date = c.detectedAt 
          ? new Date(c.detectedAt).toLocaleString("en-IN", { timeZone: "Asia/Kolkata" }) 
          : "";
        return `<li><a href="${escapeHtml(c.url)}" target="_blank">${escapeHtml(c.title)}</a>${date ? `<span class="date">Detected: ${escapeHtml(date)}</span>` : ""}</li>`;
      }).join("");
      recentHtml = `<div class="recent-section"><h2>📄 Last ${recent.length} Update${recent.length > 1 ? "s" : ""}</h2><ul class="recent-list">${items}</ul></div>`;
    } else {
      recentHtml = `<div class="recent-section"><h2>📄 Recent Updates</h2><p style="font-size:0.85rem;color:#64748b;">No new circulars detected yet. They will appear here as they are found.</p></div>`;
    }

    const html = `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>CGA Monitor Status</title>
  <style>${DASHBOARD_CSS}</style>
</head>
<body>
  <div class="card">
    <h1>📡 <span>CGA</span> Circulars Monitor</h1>
    <div class="stat">
      <span class="label">Status</span>
      <span class="value ${healthClass}">${escapeHtml(healthText)}</span>
    </div>
    <div class="stat">
      <span class="label">Last Check</span>
      <span class="value">${formattedLastCheck}</span>
    </div>
    <div class="stat">
      <span class="label">Circulars Tracked</span>
      <span class="value">${tracked}</span>
    </div>
    <div class="stat">
      <span class="label">New (Last Run)</span>
      <span class="value">${lastNew}</span>
    </div>
    <div class="stat">
      <span class="label">Schedule</span>
      <span class="value">Every 10-15 min</span>
    </div>
    ${lastError ? `<div class="error-box"><b>Last Error:</b> ${escapeHtml(lastError)}</div>` : ""}
    ${recentHtml}
    <div class="actions">
      <a class="btn btn-primary" href="#" id="runCheckBtn">▶ Run Check Now</a>
      <a class="btn btn-ghost" href="/status">📊 JSON Status</a>
    </div>
    <div class="footer">Powered by Cloudflare Workers • Free Tier</div>
  </div>

  <script>
    document.getElementById('runCheckBtn').addEventListener('click', async (e) => {
      e.preventDefault();
      const pwd = prompt("Enter password to trigger check:");
      if (pwd === null) return;
      
      try {
        const resp = await fetch('/check', {
          method: 'POST',
          headers: {
            'Authorization': 'Bearer ' + pwd
          }
        });
        
        if (resp.status === 202) {
          alert("✅ Check triggered successfully in background!");
          location.reload();
        } else if (resp.status === 401) {
          alert("❌ Incorrect password / Unauthorized.");
        } else {
          const text = await resp.text();
          alert("❌ Error: " + text);
        }
      } catch (err) {
        alert("❌ Request failed: " + err.message);
      }
    });
  </script>
</body>
</html>`;

    return new Response(html, {
      headers: {
        "Content-Type": "text/html; charset=utf-8",
        "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'self';",
        "X-Content-Type-Options": "nosniff",
        "Referrer-Policy": "no-referrer",
        "Cache-Control": "max-age=60"
      },
    });
  },
};
