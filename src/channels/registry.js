// ================================================================
// FILE: src/channels/registry.js
// PURPOSE: Map a channel name → its factory, so the gateway (and the
// CLI) can start channels by name from config.
//
//   createChannel('telegram', { token })  → Channel
//   listChannels()                        → ['telegram', 'webhook']
//   resolveEnabledChannels(config)        → ['telegram']
// ================================================================

import { createTelegramChannel } from './TelegramChannel.js';
import { createWebhookChannel } from './WebhookChannel.js';
import { assertChannel } from './Channel.js';

const FACTORIES = {
  telegram: createTelegramChannel,
  webhook: createWebhookChannel,
};


export function listChannels() {
  return Object.keys(FACTORIES);
}


export function hasChannel(name) {
  return Object.prototype.hasOwnProperty.call(FACTORIES, name);
}


export function getChannelFactory(name) {
  return FACTORIES[name];
}


// Build a channel by name. Throws on an unknown name.
export function createChannel(name, options = {}, extensions = new Map()) {
  const factory = extensions.get(name) || FACTORIES[name];
  if (!factory) {
    throw new Error(`Unknown channel "${name}". Available channels: ${listChannels().join(', ')}`);
  }
  return assertChannel(factory(options));
}


// Read `channelsEnabled` from a config wrapper ({ get }) or plain object.
// Accepts an array or a comma-separated string (QTPI_CHANNELS).
export function resolveEnabledChannels(config) {
  const raw = config && typeof config.get === 'function'
    ? config.get('channelsEnabled')
    : config?.channelsEnabled;

  if (raw == null || raw === '') return [];
  if (Array.isArray(raw)) return raw.map((v) => String(v).trim()).filter(Boolean);
  return String(raw).split(',').map((v) => v.trim()).filter(Boolean);
}
