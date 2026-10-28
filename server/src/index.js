// Glamoriz tool server. Endpoints:
//   POST /mcp               MCP Streamable HTTP (stateless) for the Chord teammate, bearer-token protected
//   POST /paystack/webhook  Paystack events (signature checked, then re-verified with the API)
//   GET  /mock-pay/:ref     Fake checkout page, only when no Paystack key is set
//   GET  /health            Liveness and configuration summary (no secrets)
import express from 'express';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { loadConfig } from './config.js';
import { Store } from './store.js';
import { Paystack } from './paystack.js';
import { Chord } from './chord.js';
import { Orders } from './orders.js';
import { Pricing } from './pricing.js';
import { buildMcpServer } from './tools.js';

export function createApp(config = loadConfig()) {
  const store = new Store(config);
  const paystack = new Paystack(config.paystack, { publicUrl: config.publicUrl });
  const chord = new Chord(config.chord);

  // Returns true if the owner was alerted by webhook; always logs, so nothing is silently dropped.
  async function alertOwner(text) {
    console.warn(`[owner-alert] ${text}`);
    if (!config.ownerAlertWebhookUrl) return false;
    try {
      const res = await fetch(config.ownerAlertWebhookUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        // "text" works for Slack incoming webhooks; "content" for Discord.
        body: JSON.stringify({ text, content: text }),
        signal: AbortSignal.timeout(8000),
      });
      return res.ok;
    } catch (err) {
      console.error('[owner-alert] delivery failed:', err.message);
      return false;
    }
  }

  const pricing = new Pricing({ store });
  const orders = new Orders({ store, paystack, chord, pricing, config, alertOwner });
  const app = express();
  app.disable('x-powered-by');

  app.get('/health', (_req, res) => {
    res.json({
      ok: true,
      paystack_mode: paystack.mode,
      chord_followups: chord.configured ? `enabled (${config.chord.followupPlatform})` : 'disabled: agent uses schedule_reminder',
      demo_followup_minutes: config.followups.demoMinutes || null,
      vat_rate_pct: config.vatRatePct,
      reply_format: { default: config.replyFormat.default, by_channel: config.replyFormat.byChannel },
      owner_alerts: config.ownerAlertWebhookUrl ? 'webhook' : 'log only',
    });
  });

  // Paystack needs the exact raw bytes for the signature check, so this route skips JSON parsing.
  app.post('/paystack/webhook', express.raw({ type: '*/*', limit: '1mb' }), async (req, res) => {
    const raw = Buffer.isBuffer(req.body) ? req.body : Buffer.from('');
    if (!paystack.isValidSignature(raw, req.get('x-paystack-signature'))) {
      return res.status(401).json({ ok: false, error: 'bad signature' });
    }
    let event;
    try {
      event = JSON.parse(raw.toString('utf8'));
    } catch {
      return res.status(400).json({ ok: false, error: 'invalid json' });
    }
    // Acknowledge fast; Paystack retries on non-200s. Then confirm with the API rather than trusting the body.
    res.status(200).json({ ok: true });
    if (event.event !== 'charge.success' || !event.data?.reference) return;
    try {
      const result = await orders.verifyPayment({ reference: event.data.reference });
      console.log(`[paystack-webhook] ${event.data.reference} → ${result.status}`);
      if (result.status === 'success' && !result.already_confirmed) {
        await orders.scheduleFollowups({ order_id: result.order.order_id });
      }
    } catch (err) {
      console.error('[paystack-webhook] processing failed:', err);
      await alertOwner(`Paystack webhook for ${event.data.reference} could not be processed: ${err.message}`);
    }
  });

  if (paystack.mode === 'mock') {
    app.get('/mock-pay/:ref', (req, res) => {
      const ref = req.params.ref;
      const order = store.orderByReference(ref);
      if (!order) return res.status(404).send('Unknown payment reference');
      res.type('html').send(`<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Mock Paystack checkout</title>
<body style="font-family:system-ui;max-width:420px;margin:40px auto;padding:0 16px">
<p style="background:#fff3cd;padding:8px;border-radius:6px">MOCK checkout: no real money. Set PAYSTACK_SECRET_KEY to use Paystack test mode.</p>
<h2>Glamoriz order ${order.id}</h2><p>Amount: ₦${order.total_ngn.toLocaleString('en-NG')}</p>
<form method="post" action="/mock-pay/${encodeURIComponent(ref)}/success"><button style="padding:10px 16px">Pay (succeeds)</button></form><br>
<form method="post" action="/mock-pay/${encodeURIComponent(ref)}/fail"><button style="padding:10px 16px">Pay (declined)</button></form>`);
    });
    app.post('/mock-pay/:ref/:outcome', (req, res) => {
      const done = paystack.mockComplete(req.params.ref, req.params.outcome === 'success' ? 'success' : 'fail');
      if (!done) return res.status(404).send('Unknown payment reference');
      res.type('html').send(`<p style="font-family:system-ui">Payment ${req.params.outcome === 'success' ? 'approved' : 'declined'}. Return to WhatsApp.</p>`);
    });
  }

  app.use('/mcp', express.json({ limit: '1mb' }), (req, res, next) => {
    if (!config.mcpAuthToken) return next();
    if (req.get('authorization') !== `Bearer ${config.mcpAuthToken}`) {
      return res.status(401).json({ jsonrpc: '2.0', error: { code: -32001, message: 'Unauthorized' }, id: null });
    }
    next();
  });

  // Stateless mode: a fresh server and transport per request, so it scales horizontally and survives restarts.
  app.post('/mcp', async (req, res) => {
    const server = buildMcpServer({ store, orders, pricing, config, alertOwner });
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    res.on('close', () => {
      transport.close();
      server.close();
    });
    try {
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch (err) {
      console.error('[mcp] request failed:', err);
      if (!res.headersSent) res.status(500).json({ jsonrpc: '2.0', error: { code: -32603, message: 'Internal server error' }, id: null });
    }
  });
  const notAllowed = (_req, res) =>
    res.status(405).json({ jsonrpc: '2.0', error: { code: -32000, message: 'Method not allowed (stateless server)' }, id: null });
  app.get('/mcp', notAllowed);
  app.delete('/mcp', notAllowed);

  return { app, store, orders, paystack, config };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const { app, config, paystack } = createApp();
  if (!config.mcpAuthToken) console.warn('WARNING: MCP_AUTH_TOKEN is not set, so /mcp is open to anyone. Set it before deploying.');
  app.listen(config.port, () => {
    console.log(`Glamoriz tools listening on ${config.publicUrl} (Paystack: ${paystack.mode})`);
  });
}
