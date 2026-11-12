// ================================================================
// FILE: src/gateway/controlUi.js
// PURPOSE: A local, dependency-free control dashboard (Phase 3).
//
// Serves ONE self-contained HTML page over Node's built-in `http`:
//
//   GET  /                → the dashboard (sessions + chat + config)
//   GET  /api/status      → { started, channels, sessions, sessionList }
//   GET  /api/config      → the merged config with secrets masked
//   POST /api/message     → { senderId, text } → { senderId, replies }
//
// It reuses the gateway's own message router (gateway.routeMessage), so
// a dashboard message is processed EXACTLY like a channel message: same
// runtime, same per-sender session isolation, same approval gate.
//
// Security posture:
//   - binds to 127.0.0.1 by default (loopback only),
//   - never returns secret values (maskConfig),
//   - sensitive tools are REJECTED unless controlUiAutoApprove=true,
//     because a browser has no interactive approval prompt.
// ================================================================

import http from 'http';
import crypto from 'crypto';
import { getAllConfig, maskConfig } from '../config/configManager.js';

const MAX_BODY_BYTES = 1_000_000;


function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error('Payload too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf-8')));
    req.on('error', reject);
  });
}


function sendJson(res, status, payload) {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(payload));
}


// ─────────────────────────────────────────────────────────────
// The dashboard page. Kept as a plain string (no template literals in
// the client script) so it can be embedded without escaping hazards.
// ─────────────────────────────────────────────────────────────
function renderPage(csrfToken) {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>QTPi Control</title>
<style>
  :root { --bg:#0f1117; --panel:#171a23; --line:#262b38; --fg:#e6e8ee; --muted:#8b93a7; --accent:#c678dd; --ok:#4ec9b0; --warn:#e5c07b; }
  * { box-sizing: border-box; }
  body { margin:0; font:14px/1.5 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace; background:var(--bg); color:var(--fg); }
  header { padding:14px 20px; border-bottom:1px solid var(--line); display:flex; align-items:center; gap:12px; }
  header h1 { font-size:16px; margin:0; color:var(--accent); }
  header .pill { font-size:12px; color:var(--muted); border:1px solid var(--line); border-radius:999px; padding:2px 10px; }
  main { display:grid; grid-template-columns: 260px 1fr 320px; gap:16px; padding:16px; height:calc(100vh - 56px); }
  .panel { background:var(--panel); border:1px solid var(--line); border-radius:10px; display:flex; flex-direction:column; min-height:0; }
  .panel h2 { font-size:12px; text-transform:uppercase; letter-spacing:.08em; color:var(--muted); margin:0; padding:12px 14px; border-bottom:1px solid var(--line); }
  .scroll { overflow:auto; padding:10px 14px; }
  .session { padding:8px 10px; border-radius:8px; cursor:pointer; display:flex; justify-content:space-between; gap:8px; }
  .session:hover { background:#1e2230; }
  .session.active { background:#241b2e; outline:1px solid var(--accent); }
  .session .id { overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
  .session .n { color:var(--muted); font-size:12px; }
  #chat { flex:1; display:flex; flex-direction:column; min-height:0; }
  #log { flex:1; overflow:auto; padding:14px; display:flex; flex-direction:column; gap:10px; }
  .msg { max-width:80%; padding:8px 12px; border-radius:10px; white-space:pre-wrap; word-break:break-word; }
  .msg.user { align-self:flex-end; background:#2b2440; }
  .msg.agent { align-self:flex-start; background:#1b2029; border:1px solid var(--line); }
  .msg.sys { align-self:center; color:var(--muted); font-size:12px; }
  .composer { display:flex; gap:8px; padding:12px; border-top:1px solid var(--line); }
  input, button { font:inherit; }
  input { flex:1; background:#0c0e14; color:var(--fg); border:1px solid var(--line); border-radius:8px; padding:9px 11px; }
  input:focus { outline:1px solid var(--accent); }
  button { background:var(--accent); color:#160b1c; border:0; border-radius:8px; padding:9px 16px; font-weight:700; cursor:pointer; }
  button:disabled { opacity:.5; cursor:default; }
  table { width:100%; border-collapse:collapse; font-size:12px; }
  td { padding:4px 0; vertical-align:top; border-bottom:1px solid #1c202b; }
  td.k { color:var(--muted); padding-right:10px; white-space:nowrap; }
  td.v { word-break:break-all; }
  .muted { color:var(--muted); }
</style>
</head>
<body>
<header>
  <h1>🧁 QTPi Control</h1>
  <span class="pill" id="status">connecting…</span>
  <span class="pill" id="channels"></span>
</header>
<main>
  <section class="panel">
    <h2>Sessions</h2>
    <div class="scroll" id="sessions"></div>
  </section>

  <section class="panel" id="chat">
    <h2 id="chatTitle">Chat</h2>
    <div id="log"></div>
    <div class="composer">
      <input id="sender" placeholder="senderId" value="dashboard" />
      <input id="text" placeholder="Ask QTPi anything…" autofocus />
      <button id="send">Send</button>
    </div>
  </section>

  <section class="panel">
    <h2>Config <span class="muted">(secrets masked)</span></h2>
    <div class="scroll" id="config"></div>
  </section>
</main>

<script>
(function () {
  var csrfToken = ${JSON.stringify(csrfToken)};
  var current = 'dashboard';
  var log = document.getElementById('log');
  var senderEl = document.getElementById('sender');
  var textEl = document.getElementById('text');
  var sendBtn = document.getElementById('send');

  function el(tag, cls, text) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  }

  function addMsg(kind, text) {
    log.appendChild(el('div', 'msg ' + kind, text));
    log.scrollTop = log.scrollHeight;
  }

  function refreshStatus() {
    fetch('/api/status').then(function (r) { return r.json(); }).then(function (s) {
      document.getElementById('status').textContent =
        (s.started ? 'online' : 'idle') + ' · ' + s.sessions.sessions + ' sessions · ' + s.sessions.messages + ' msgs';
      document.getElementById('channels').textContent = 'channels: ' + (s.channels.join(', ') || 'none');
      var box = document.getElementById('sessions');
      box.innerHTML = '';
      if (!s.sessionList.length) { box.appendChild(el('div', 'muted', 'No sessions yet.')); return; }
      s.sessionList.forEach(function (sess) {
        var row = el('div', 'session' + (sess.id === current ? ' active' : ''));
        row.appendChild(el('span', 'id', sess.id));
        row.appendChild(el('span', 'n', String(sess.messages)));
        row.onclick = function () { current = sess.id; senderEl.value = sess.id; refreshStatus(); };
        box.appendChild(row);
      });
    }).catch(function () {});
  }

  function refreshConfig() {
    fetch('/api/config').then(function (r) { return r.json(); }).then(function (cfg) {
      var box = document.getElementById('config');
      box.innerHTML = '';
      var keys = Object.keys(cfg).sort();
      if (!keys.length) { box.appendChild(el('div', 'muted', 'No config found.')); return; }
      var table = el('table');
      keys.forEach(function (k) {
        var tr = el('tr');
        tr.appendChild(el('td', 'k', k));
        tr.appendChild(el('td', 'v', String(cfg[k])));
        table.appendChild(tr);
      });
      box.appendChild(table);
    }).catch(function () {});
  }

  function send() {
    var text = textEl.value.trim();
    if (!text) return;
    var senderId = senderEl.value.trim() || 'dashboard';
    current = senderId;
    addMsg('user', text);
    textEl.value = '';
    sendBtn.disabled = true;
    fetch('/api/message', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-qtpi-csrf': csrfToken },
      body: JSON.stringify({ senderId: senderId, text: text }),
    }).then(function (r) { return r.json(); }).then(function (data) {
      if (data.error) { addMsg('sys', 'error: ' + data.error); }
      (data.replies || []).forEach(function (m) { addMsg('agent', m); });
      if (!data.replies || !data.replies.length) addMsg('sys', '(no output)');
    }).catch(function (e) { addMsg('sys', 'request failed: ' + e.message); })
      .then(function () { sendBtn.disabled = false; refreshStatus(); });
  }

  sendBtn.onclick = send;
  textEl.addEventListener('keydown', function (e) { if (e.key === 'Enter') send(); });

  refreshStatus();
  refreshConfig();
  setInterval(refreshStatus, 5000);
})();
</script>
</body>
</html>`;
}


// ─────────────────────────────────────────────────────────────
// createControlUi({ gateway, config, host, port, autoApprove })
//
//   gateway      object  the gateway (needs routeMessage + status)
//   config       { get } config wrapper (for /api/config)
//   host         string  bind host (default 127.0.0.1)
//   port         number  listen port (default 8788; 0 = ephemeral)
//   autoApprove  bool    auto-approve sensitive tools
//
// Returns:
//   { name, start, stop, address, requestApproval, handleMessage }
// ─────────────────────────────────────────────────────────────
export function createControlUi({
  gateway,
  config,
  host = '127.0.0.1',
  port = 8788,
  autoApprove = false,
} = {}) {
  if (!gateway || typeof gateway.routeMessage !== 'function') {
    throw new TypeError('createControlUi requires a gateway with routeMessage()');
  }
  if (!['127.0.0.1', '::1', 'localhost'].includes(String(host).toLowerCase())) {
    throw new TypeError('The control UI only binds to loopback hosts (127.0.0.1, ::1, or localhost)');
  }

  let server = null;
  const csrfToken = crypto.randomBytes(32).toString('hex');

  function requestAllowed(req) {
    const address = server?.address();
    if (!address || typeof address === 'string') return false;
    const authorityHost = host.includes(':') ? `[${host}]` : host;
    const expectedHost = `${authorityHost}:${address.port}`;
    if (req.headers.host !== expectedHost) return false;
    if (req.headers.origin) {
      try {
        if (new URL(req.headers.origin).origin !== `http://${expectedHost}`) return false;
      } catch {
        return false;
      }
    }
    if (req.method === 'POST') {
      const supplied = Buffer.from(String(req.headers['x-qtpi-csrf'] || ''));
      const expected = Buffer.from(csrfToken);
      if (supplied.length !== expected.length || !crypto.timingSafeEqual(supplied, expected)) return false;
    }
    return true;
  }

  // The control UI acts as its own "channel" for the approval gate: a
  // browser has no interactive prompt, so sensitive tools are rejected
  // unless autoApprove is on.
  const approvalChannel = {
    name: 'control-ui',
    async requestApproval() {
      return autoApprove ? 'approved' : 'rejected';
    },
  };

  // Route one dashboard message through the gateway's shared router.
  async function handleMessage(senderId, text) {
    const replies = [];
    await gateway.routeMessage(
      { senderId, text, reply: (t) => { replies.push(String(t)); } },
      approvalChannel,
    );
    return replies;
  }

  function statusPayload() {
    const status = gateway.status();
    const sessionList = gateway.sessions.list().map((s) => ({
      id: s.id,
      messages: s.conversation.getMessages().length,
      lastUsedAt: s.lastUsedAt,
    }));
    return { ...status, sessionList };
  }

  async function start() {
    if (server) return;

    server = http.createServer(async (req, res) => {
      const url = (req.url || '').split('?')[0];

      try {
        if (!requestAllowed(req)) {
          sendJson(res, req.headers.host ? 403 : 421, { error: 'Forbidden request origin or host' });
          return;
        }

        if (req.method === 'GET' && (url === '/' || url === '/index.html')) {
          res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
          res.end(renderPage(csrfToken));
          return;
        }

        if (req.method === 'GET' && url === '/api/status') {
          sendJson(res, 200, statusPayload());
          return;
        }

        if (req.method === 'GET' && url === '/api/config') {
          // Mirror `qtpi config --show`: the merged global+project config
          // with every secret value masked before it leaves the process.
          sendJson(res, 200, maskConfig(getAllConfig()));
          return;
        }

        if (req.method === 'POST' && url === '/api/message') {
          let payload;
          try {
            payload = JSON.parse((await readBody(req)) || '{}');
          } catch (error) {
            sendJson(res, 400, { error: `Invalid JSON: ${error.message}` });
            return;
          }
          const senderId = String(payload.senderId ?? 'dashboard');
          const text = String(payload.text ?? '');
          const replies = await handleMessage(senderId, text);
          sendJson(res, 200, { senderId, replies });
          return;
        }

        sendJson(res, 404, { error: 'Not found' });
      } catch (error) {
        sendJson(res, 500, { error: error.message });
      }
    });

    await new Promise((resolve, reject) => {
      const onError = (error) => { server.off('listening', onListening); reject(error); };
      const onListening = () => { server.off('error', onError); resolve(); };
      server.once('error', onError);
      server.once('listening', onListening);
      server.listen(port, host);
    });
  }

  async function stop() {
    if (!server) return;
    const closing = server;
    server = null;
    await new Promise((resolve) => closing.close(resolve));
  }

  function address() {
    return server ? server.address() : null;
  }

  return {
    name: 'control-ui',
    start,
    stop,
    address,
    handleMessage,
    requestApproval: approvalChannel.requestApproval,
    get running() { return Boolean(server); },
  };
}

