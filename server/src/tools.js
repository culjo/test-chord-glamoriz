// The MCP tools the Chord teammate can call. Each returns JSON text; business outcomes such as
// "payment failed" are normal results the agent acts on, while unexpected exceptions come back as isError.
import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { summarise } from './orders.js';

const phone = z.string().describe("Customer's WhatsApp number in any format, e.g. 0803 000 0001 or +2348030000001");
const orderId = z.string().describe('Glamoriz order number, e.g. GLZ-1001');

function ok(data) {
  return { content: [{ type: 'text', text: JSON.stringify(data) }] };
}

function wrap(name, fn) {
  return async (args) => {
    try {
      return ok(await fn(args));
    } catch (err) {
      console.error(`[tool:${name}]`, err);
      return { isError: true, content: [{ type: 'text', text: `Tool ${name} failed unexpectedly: ${err.message}. Try once more; if it fails again, hand over to a human.` }] };
    }
  };
}

export function buildMcpServer({ store, orders, alertOwner }) {
  const server = new McpServer({ name: 'glamoriz-tools', version: '0.1.0' });

  const tool = (name, description, inputSchema, fn) =>
    server.registerTool(name, { title: name, description, inputSchema }, wrap(name, fn));

  tool(
    'get_customer',
    'Look up a customer by WhatsApp number. Returns their name, last order, referral code and whether they opted out. Unknown numbers return found:false (a new customer).',
    { phone },
    async ({ phone: p }) => {
      const c = store.customer(p);
      const history = store.ordersFor(p).filter((o) => o.status === 'paid');
      if (!c && !history.length) return { found: false };
      const last = history[0];
      return {
        found: true,
        name: c?.name || last?.customer_name || null,
        city: c?.city || null,
        area: c?.area || null,
        saved_address: c?.address || null,
        referral_code: c?.referral_code || null,
        discount: c?.discount || null,
        opt_out: Boolean(c?.opt_out),
        notes: c?.skin_notes || null,
        paid_orders: history.length,
        last_order: last ? { order_id: last.id, paid_at: last.paid_at, items: last.items.map((i) => i.name) } : null,
      };
    },
  );

  tool(
    'search_products',
    'Find products for a skin concern (e.g. "dark spots", "acne", "dryness", "oiliness", "sensitivity"). In-stock items come first. Always mention the caution field when present.',
    {
      concern: z.string().describe('Main skin concern in plain words'),
      skin_type: z.string().optional().describe('oily, dry, combination, normal or sensitive'),
      max_price_ngn: z.number().int().positive().optional(),
      exclude_pregnancy_unsafe: z.boolean().optional().describe('true if the customer is pregnant or breastfeeding'),
    },
    async ({ concern, skin_type, max_price_ngn, exclude_pregnancy_unsafe }) => {
      const words = concern.toLowerCase().split(/[^a-z]+/).filter((w) => w.length > 2);
      const scored = store
        .products()
        .filter((p) => !max_price_ngn || p.price_ngn <= max_price_ngn)
        .filter((p) => !exclude_pregnancy_unsafe || !/pregnan/i.test(p.caution || ''))
        .map((p) => {
          const hay = `${p.name} ${p.category} ${p.concerns.join(' ')}`.toLowerCase();
          let score = words.filter((w) => hay.includes(w)).length * 2;
          if (skin_type && p.skin_types.includes(skin_type.toLowerCase())) score += 1;
          return { p, score };
        })
        .filter((x) => x.score > 0)
        .sort((a, b) => (b.p.stock > 0) - (a.p.stock > 0) || b.score - a.score);
      return {
        results: scored.slice(0, 5).map(({ p }) => ({
          sku: p.sku,
          name: p.name,
          category: p.category,
          price_ngn: p.price_ngn,
          in_stock: p.stock > 0,
          lasts_days: p.days_supply,
          suits: p.skin_types,
          how_to_use: p.how_to_use,
          caution: p.caution,
        })),
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
    'create_order',
    'Create an order once the customer has confirmed products, quantity, city, area and full address. The server calculates the delivery fee and total; quote those exact numbers.',
    {
      phone,
      customer_name: z.string().optional(),
      items: z.array(z.object({ sku: z.string(), qty: z.number().int().min(1) })).min(1),
      city: z.string().describe('Lagos or Abuja'),
      area: z.string().describe('Neighbourhood, e.g. Lekki, Yaba, Wuse, Gwarinpa'),
      address: z.string().describe('Full delivery address'),
      conversation_id: z.string().optional().describe('The Chord thread id of this chat, if you know it (used to schedule follow-ups)'),
    },
    async (args) => orders.createOrder(args),
  );

  tool(
    'create_payment_link',
    'Create (or re-send) a Paystack payment link for an order. If a valid link already exists it is reused.',
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
    'Get an order and whether a follow-up message is allowed. Call this first in every scheduled follow-up.',
    { order_id: orderId },
    async (args) => orders.getOrder(args),
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
