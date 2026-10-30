// The MCP tools the Chord teammate can call. Each returns JSON text; business outcomes such as
// "payment failed" are normal results the agent acts on, while unexpected exceptions come back as isError.
import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { summarise } from './orders.js';
import { replyFormat } from './formatting.js';

const phone = z.string().describe("Customer's WhatsApp number in any format, e.g. 0803 000 0001 or +2348030000001");
const orderId = z.string().describe('Glamoriz order number, e.g. GLZ-1001');
const dealIds = z.array(z.string()).optional().describe('Every deal_id negotiate_price gave you in this chat, so agreed prices are applied');
const channel = z.string().optional().describe('The channel this chat is on, if you know it: whatsapp, web, instagram or email');

function ok(data) {
  return { content: [{ type: 'text', text: JSON.stringify(data) }] };
}

// Refusals from these tools (bad input, out of stock, Paystack errors) come back as normal results, so log them to make
// failed checkouts easy to debug. Addresses and emails are left out of the log.
const LOGGED_FAILURES = new Set(['create_order', 'create_payment_link']);

function logFailure(name, args, result) {
  const { address, email, ...input } = args ?? {};
  const { ok: _ok, message, ...details } = result;
  console.warn(`[tool:${name}] failed: ${message}`, JSON.stringify({ ...details, input }));
}

function wrap(name, fn) {
  return async (args) => {
    try {
      const result = await fn(args);
      if (result?.ok === false && LOGGED_FAILURES.has(name)) logFailure(name, args, result);
      return ok(result);
    } catch (err) {
      console.error(`[tool:${name}]`, err);
      return { isError: true, content: [{ type: 'text', text: `Tool ${name} failed unexpectedly: ${err.message}. Try once more; if it fails again, hand over to a human.` }] };
    }
  };
}

/** Tidies common honorifics ("ma" → "Ma", "madam" → "Madam") and keeps anything else as the customer wrote it. */
function normaliseAddressAs(value) {
  const v = value?.trim().replace(/\s+/g, ' ');
  if (!v) return undefined;
  const known = { ma: 'Ma', sir: 'Sir', madam: 'Madam', aunty: 'Aunty', auntie: 'Aunty', uncle: 'Uncle', mummy: 'Mummy', daddy: 'Daddy' };
  return known[v.toLowerCase()] || v.replace(/^./, (ch) => ch.toUpperCase());
}

export function buildMcpServer({ store, orders, pricing, config, alertOwner }) {
  const server = new McpServer({ name: 'glamoriz-tools', version: '0.1.0' });

  const tool = (name, description, inputSchema, fn) =>
    server.registerTool(name, { title: name, description, inputSchema }, wrap(name, fn));

  tool(
    'get_customer',
    'Look up a customer by WhatsApp number. Returns their name, last order, referral code, store credit and whether they opted out. ' +
      'Unknown numbers return found:false (a new customer). Call it at the start of every chat, even without a number, ' +
      'to get reply_format: format every message you send by its rules.',
    { phone: phone.optional(), channel },
    async ({ phone: p, channel: ch }) => {
      const reply_format = replyFormat(config, ch);
      if (!p) return { found: false, phone_known: false, reply_format };
      const c = store.customer(p);
      const history = store.ordersFor(p).filter((o) => o.status === 'paid');
      if (!c && !history.length) return { found: false, reply_format };
      const last = history[0];
      return {
        found: true,
        reply_format,
        name: c?.name || last?.customer_name || null,
        city: c?.city || null,
        area: c?.area || null,
        saved_address: c?.address || null,
        referral_code: c?.referral_code || null,
        credit_ngn: c?.credit_ngn || 0,
        opt_out: Boolean(c?.opt_out),
        // How they like to be addressed ("Ma", "Sir", "Aunty Ada", "Ada"). null means not asked yet.
        address_as: c?.address_as || null,
        notes: c?.skin_notes || null,
        paid_orders: history.length,
        last_order: last ? { order_id: last.id, paid_at: last.paid_at, items: last.items.map((i) => i.name) } : null,
      };
    },
  );

  tool(
    'save_customer_details',
    'Save what a customer tells you about themselves: their name and how they like to be addressed (e.g. "Ma", "Sir", ' +
      '"Madam", "Aunty Ada", "Mr Okafor" or just their first name). Call it as soon as they tell you, and again if they correct it.',
    {
      phone,
      name: z.string().max(80).optional().describe("Customer's name as they gave it"),
      address_as: z.string().max(40).optional().describe('Exactly how they want to be addressed, in their words'),
    },
    async ({ phone: p, name, address_as }) => {
      const c = store.upsertCustomer(p, { name: name?.trim(), address_as: normaliseAddressAs(address_as) });
      store.save();
      return { ok: true, name: c.name || null, address_as: c.address_as || null };
    },
  );

  tool(
    'search_products',
    'Find products for a skin concern (e.g. "dark spots", "acne", "dryness", "oiliness", "sensitivity"). In-stock items come first. ' +
      'Leave concern out when the customer asks what you sell: you get one in-stock product per category. Always mention the caution field when present.',
    {
      concern: z.string().optional().describe('Main skin concern in plain words; leave out to browse the range'),
      skin_type: z.string().optional().describe('oily, dry, combination, normal or sensitive'),
      max_price_ngn: z.number().int().positive().optional(),
      exclude_pregnancy_unsafe: z.boolean().optional().describe('true if the customer is pregnant or breastfeeding'),
    },
    async ({ concern, skin_type, max_price_ngn, exclude_pregnancy_unsafe }) => {
      const view = (p) => ({
        sku: p.sku,
        name: p.name,
        category: p.category,
        price_ngn: p.price_ngn,
        in_stock: p.stock > 0,
        lasts_days: p.days_supply,
        suits: p.skin_types,
        how_to_use: p.how_to_use,
        caution: p.caution,
      });
      const allowed = store
        .products()
        .filter((p) => !max_price_ngn || p.price_ngn <= max_price_ngn)
        .filter((p) => !exclude_pregnancy_unsafe || !/pregnan/i.test(p.caution || ''));
      if (!concern?.trim()) {
        // Browsing: the cheapest in-stock product in each category, as a short overview.
        const byCategory = new Map();
        for (const p of allowed.filter((x) => x.stock > 0).sort((a, b) => a.price_ngn - b.price_ngn)) {
          if (!byCategory.has(p.category)) byCategory.set(p.category, p);
        }
        return { overview: true, results: [...byCategory.values()].map(view), hint: 'Show these as a short numbered list, then ask about their skin concern.' };
      }
      const words = concern.toLowerCase().split(/[^a-z]+/).filter((w) => w.length > 2);
      const scored = allowed
        .map((p) => {
          const hay = `${p.name} ${p.category} ${p.concerns.join(' ')}`.toLowerCase();
          let score = words.filter((w) => hay.includes(w)).length * 2;
          if (skin_type && p.skin_types.includes(skin_type.toLowerCase())) score += 1;
          return { p, score };
        })
        .filter((x) => x.score > 0)
        .sort((a, b) => (b.p.stock > 0) - (a.p.stock > 0) || b.score - a.score);
      return {
        results: scored.slice(0, 5).map(({ p }) => view(p)),
        ...(scored.length === 0 && { hint: 'No match. Ask the customer to describe their concern differently, or suggest the Starter Routine Set (GLM-SET-01).' }),
      };
    },
  );

  tool(
    'check_stock',
    'Check whether a product is in stock. If it is out, returns in-stock alternatives for the same need.',
    { sku: z.string().describe('Product SKU, e.g. GLM-SER-01') },
    async ({ sku }) => {
      const p = store.product(sku);
      if (!p) return { found: false, message: `No product ${sku}.` };
      const alternatives =
        p.stock > 0
          ? []
          : store
              .products()
              .filter((x) => x.sku !== p.sku && x.stock > 0 && x.category === p.category && x.concerns.some((c) => p.concerns.includes(c)))
              .map((x) => ({ sku: x.sku, name: x.name, price_ngn: x.price_ngn, caution: x.caution }));
      return { found: true, sku: p.sku, name: p.name, in_stock: p.stock > 0, units_left: p.stock, alternatives };
    },
  );

  tool(
    'negotiate_price',
    'Call this whenever the customer asks for a discount or a better price, says it is too expensive, gives a budget, ' +
      'mentions a cheaper seller or names their own price ("can you do 12k?"). ' +
      'Pass their offer if they gave one. The server decides: it accepts the offer, makes a counter-offer, or says the price is final. ' +
      'Quote exactly the price it returns and never offer a price or discount yourself. Keep the deal_id it returns: pass it back on ' +
      'the next ask, and to quote_cart and create_order, which apply the agreed price for 24 hours.',
    {
      phone: phone.optional().describe("Customer's WhatsApp number if you have it. Never ask the customer for it just to bargain"),
      deal_id: z.string().optional().describe('The deal_id from your last negotiate_price call for this product, if any'),
      sku: z.string().describe('Product SKU being bargained on, e.g. GLM-SER-01'),
      qty: z.number().int().min(1).max(10).optional().describe('Units the customer wants (3 or more can unlock a better price)'),
      offer_ngn: z.number().int().positive().optional().describe("The customer's offer per unit in naira, if they named one"),
    },
    async (args) => pricing.negotiate(args),
  );

  tool(
    'quote_cart',
    'Work out the running total of the products the customer has picked, before you have their address. Applies any agreed ' +
      'price, referral code and store credit. Pass city and area if you know them to include delivery. Quote its numbers exactly; ' +
      'never add up prices yourself. Call it again whenever the selection changes.',
    {
      phone: phone.optional(),
      items: z.array(z.object({ sku: z.string(), qty: z.number().int().min(1) })).min(1),
      referral_code: z.string().optional(),
      deal_ids: dealIds,
      city: z.string().optional().describe('Lagos or Abuja, if known'),
      area: z.string().optional().describe('Neighbourhood, if known'),
    },
    async (args) => orders.quoteCart(args),
  );

  tool(
    'create_order',
    'Create an order once the customer has confirmed products, quantity, city, area and full address. The server applies any agreed price, ' +
      'referral discount and store credit, and calculates the delivery fee and total; quote those exact numbers.',
    {
      phone,
      customer_name: z.string().optional(),
      items: z.array(z.object({ sku: z.string(), qty: z.number().int().min(1) })).min(1),
      city: z.string().describe('Lagos or Abuja'),
      area: z.string().describe('Neighbourhood, e.g. Lekki, Yaba, Wuse, Gwarinpa'),
      address: z.string().describe('Full delivery address'),
      referral_code: z.string().optional().describe("A friend's referral code, if a first-time customer gives one"),
      deal_ids: dealIds,
      conversation_id: z.string().optional().describe('The Chord thread id of this chat, if you know it (used to schedule follow-ups)'),
    },
    async (args) => orders.createOrder(args),
  );

  tool(
    'create_payment_link',
    'Create (or re-send) a Paystack payment link for an order. If a valid link already exists it is reused. ' +
      'payment_url is the only link to send: copy it exactly. Call this again to resend a link; never write one yourself.',
    { order_id: orderId, email: z.string().email().optional().describe("Customer's email if they gave one, for the Paystack receipt") },
    async (args) => orders.createPaymentLink(args),
  );

  tool(
    'verify_payment',
    'Ask Paystack whether an order has been paid. Only confirm the order when status is "success". Never rely on screenshots.',
    { order_id: orderId },
    async ({ order_id }) => orders.verifyPayment({ order_id }),
  );

  tool(
    'schedule_followups',
    'After a successful payment, schedule the day-3 check-in and the reorder nudge. If the result has action_needed, use your schedule_reminder tool with the reminders given.',
    { order_id: orderId, conversation_id: z.string().optional().describe('The Chord thread id of this chat, if you know it') },
    async (args) => orders.scheduleFollowups(args),
  );

  tool(
    'get_order',
    'Get an order and whether a follow-up message is allowed. Call this first in every scheduled follow-up. ' +
      'Also returns reply_format: format the follow-up message by its rules.',
    { order_id: orderId, channel },
    async ({ order_id, channel: ch }) => {
      const result = orders.getOrder({ order_id });
      const c = result.ok ? store.customer(result.order.phone) : null;
      return { ...result, ...(result.ok && { address_as: c?.address_as || null }), reply_format: replyFormat(config, ch) };
    },
  );

  tool(
    'list_orders',
    "List a customer's recent orders (newest first).",
    { phone },
    async ({ phone: p }) => ({ orders: store.ordersFor(p).slice(0, 5).map(summarise) }),
  );

  tool(
    'log_complaint',
    'Log a complaint and alert the Glamoriz team. Then call handover_to_human. Types: reaction, delivery, wrong_item, damaged, return, other.',
    {
      order_id: orderId.optional(),
      phone,
      type: z.enum(['reaction', 'delivery', 'wrong_item', 'damaged', 'return', 'other']),
      details: z.string().describe("What the customer said, in their words"),
    },
    async ({ order_id, phone: p, type, details }) => {
      const order = order_id ? store.order(order_id) : null;
      if (order && ['reaction', 'return', 'damaged', 'wrong_item'].includes(type)) {
        order.followups_suppressed = true; // no reorder nudge after a complaint
      }
      const ticket = store.addComplaint({ order_id: order?.id || order_id || null, phone: p, type, details });
      store.save();
      const urgent = type === 'reaction';
      const alerted = await alertOwner(`${urgent ? 'URGENT ' : ''}Complaint ${ticket.id} (${type}) from ${p}${order ? ` on ${order.id}` : ''}: ${details}`);
      return {
        ok: true,
        ticket_id: ticket.id,
        owner_alerted: alerted,
        next_step: 'Give the customer the ticket number, then call handover_to_human with a one-line reason.',
      };
    },
  );

  tool(
    'record_feedback',
    'Record how a follow-up went: sentiment, review text, a "no thanks" to reorder, or an opt-out from messages.',
    {
      order_id: orderId,
      followup_type: z.enum(['day3_checkin', 'reorder', 'other']).optional(),
      sentiment: z.enum(['positive', 'neutral', 'negative']).optional(),
      text: z.string().optional().describe("Customer's words"),
      shareable_review: z.boolean().optional().describe('true if the customer agreed we can share their review'),
      declined_reorder: z.boolean().optional(),
      opt_out: z.boolean().optional().describe('true if the customer asked not to be messaged again'),
    },
    async ({ order_id, followup_type, opt_out, declined_reorder, ...rest }) => {
      const order = store.order(order_id);
      if (!order) return { ok: false, reason: 'order_not_found' };
      if (followup_type) orders.markFollowupDone(order, followup_type);
      if (declined_reorder || opt_out) order.followups_suppressed = true;
      if (opt_out) store.upsertCustomer(order.phone, { opt_out: true });
      store.addFeedback({ order_id: order.id, phone: order.phone, followup_type, opt_out: Boolean(opt_out), declined_reorder: Boolean(declined_reorder), ...rest });
      store.save();
      return { ok: true };
    },
  );

  return server;
}
