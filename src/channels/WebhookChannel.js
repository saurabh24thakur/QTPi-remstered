// ================================================================
// FILE: src/channels/WebhookChannel.js
// PURPOSE: A dependency-free channel that speaks plain HTTP.
//
// It proves the channel abstraction: the same runtime that powers the
// CLI and Telegram can be driven by a bare `POST /message` request.
//
//   POST /message   { "senderId": "u1", "text": "hello" }
//   → 200           { "senderId": "u1", "replies": ["…"] }
//
// Sensitive tools are rejected by default (there is no interactive UI);
// set webhookAutoApprove=true to auto-approve them.
//
// Uses only Node's built-in `http` — no new dependency.
// ================================================================

import http from 'http';
import { assertChannel } from './Channel.js';

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
// createWebhookChannel({ port, host, path, autoApprove })
// Returns a Channel (see Channel.js) backed by a tiny HTTP server.
// ───────────────��─────────────────────────────────────────────
export function createWebhookChannel({
  port = 8787,
  host = '127.0.0.1',
  path: routePath = '/message',
  autoApprove = false,
} = {}) {
  let server = null;
  let messageHandler = null;
  const outbox = [];

  const channel = {
    name: 'webhook',

    async start() {
      if (server) return;

      server = http.createServer(async (req, res) => {
        const url = (req.url || '').split('?')[0];
        if (req.method !== 'POST' || url !== routePath) {
          sendJson(res, 404, { error: 'Not found' });
          return;
        }

        let payload;
        try {
          payload = JSON.parse((await readBody(req)) || '{}');
        } catch (error) {
          sendJson(res, 400, { error: `Invalid JSON: ${error.message}` });
          return;
        }

        const senderId = String(payload.senderId ?? payload.from ?? 'anonymous');
        const text = String(payload.text ?? '');
        const replies = [];

        try {
          if (messageHandler) {
            await messageHandler({
              senderId,
              text,
              reply: (t) => { replies.push(String(t)); },
            });
          }
          sendJson(res, 200, { senderId, replies });
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
    },

    async stop() {
      if (!server) return;
      const closing = server;
      server = null;
      await new Promise((resolve) => closing.close(resolve));
    },

    async send(target, text) {
      const message = { target, text: String(text), at: new Date().toISOString() };
      outbox.push(message);

      // Best-effort delivery when the target is a URL.
      if (typeof fetch === 'function' && typeof target === 'string' && /^https?:\/\//i.test(target)) {
        try {
          await fetch(target, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ text: message.text }),
          });
        } catch {
          // Delivery failed — the message stays in the outbox.
        }
      }
    },

    onMessage(handler) {
      messageHandler = handler;
    },

    async requestApproval() {
      return autoApprove ? 'approved' : 'rejected';
    },

    // ── introspection helpers (tests / gateway) ──
    address() {
      return server ? server.address() : null;
    },
    outbox() {
      return outbox.slice();
    },
  };

  return assertChannel(channel);
}
