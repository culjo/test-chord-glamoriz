// All configuration comes from environment variables. See ../.env.example.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertFormat, parseChannelFormats } from './formatting.js';

const here = path.dirname(fileURLToPath(import.meta.url));

function intFrom(env, name, fallback) {
  const raw = env[name];
  if (raw === undefined || raw === '') return fallback;
  const n = Number.parseInt(raw, 10);
  if (Number.isNaN(n)) throw new Error(`${name} must be a whole number, got "${raw}"`);
  return n;
}

export function loadConfig(env = process.env) {
  const int = (name, fallback) => intFrom(env, name, fallback);
  const paystackKey = env.PAYSTACK_SECRET_KEY || '';
  if (paystackKey.startsWith('sk_live')) {
    // The exercise forbids live keys, and so does the go-live checklist until the owner signs off.
    throw new Error('Refusing to start with a live Paystack key. Use an sk_test_ key.');
  }

  const port = int('PORT', 3000);
  return {
    port,
    publicUrl: (env.PUBLIC_URL || `http://localhost:${port}`).replace(/\/$/, ''),
    mcpAuthToken: env.MCP_AUTH_TOKEN || '',
    dataDir: env.DATA_DIR || path.resolve(here, '../.data'),
    catalogPath: env.CATALOG_PATH || path.resolve(here, '../../data/products.json'),
    seedCustomersPath: env.SEED_CUSTOMERS_PATH || path.resolve(here, '../../data/customers.json'),

    paystack: {
      // "mock" runs a local fake checkout page so the flow can be tested without a Paystack account.
      mode: paystackKey ? 'test' : 'mock',
      secretKey: paystackKey,
      baseUrl: env.PAYSTACK_BASE_URL || 'https://api.paystack.co',
      callbackUrl: env.PAYSTACK_CALLBACK_URL || '',
      timeoutMs: int('PAYSTACK_TIMEOUT_MS', 10000),
    },

    chord: {
      baseUrl: (env.CHORD_BASE_URL || 'https://api.chordhq.xyz').replace(/\/$/, ''),
      apiKey: env.CHORD_API_KEY || '',
      workspaceId: env.CHORD_WORKSPACE_ID || '',
      teammateId: env.CHORD_TEAMMATE_ID || '',
      // DIRECT_LINE delivers into a Chord thread by id; WHATSAPP goes through the workspace's WhatsApp connector.
      followupPlatform: env.CHORD_FOLLOWUP_PLATFORM || 'DIRECT_LINE',
    },

    followups: {
      // Real timings: day-3 check-in, and a reorder nudge 5 days before the product runs out.
      checkinAfterMinutes: int('FOLLOWUP_CHECKIN_MINUTES', 3 * 24 * 60),
      reorderLeadDays: int('FOLLOWUP_REORDER_LEAD_DAYS', 5),
      // Set for the demo recording to compress days into minutes (e.g. 2 → check-in at +2 min, reorder at +4 min).
      demoMinutes: int('DEMO_FOLLOWUP_MINUTES', 0),
    },

    // How the agent formats replies: plain, whatsapp, markdown or html. Plain suits the WhatsApp simulator.
    replyFormat: {
      default: assertFormat((env.REPLY_FORMAT || 'plain').trim().toLowerCase(), 'REPLY_FORMAT'),
      byChannel: parseChannelFormats(env.REPLY_FORMAT_BY_CHANNEL),
    },

    ownerAlertWebhookUrl: env.OWNER_ALERT_WEBHOOK_URL || '',
    timezone: 'Africa/Lagos',
  };
}
