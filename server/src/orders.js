// Order, payment and follow-up logic shared by the MCP tools and the Paystack webhook.
import { FREE_DELIVERY_THRESHOLD_NGN, quoteDelivery } from './delivery.js';
import { normalisePhone } from './store.js';

const MAX_UNITS_PER_ORDER = 10;
const LINK_REUSE_HOURS = 23;
// Suggest topping up to free delivery when the customer is this close to the threshold.
const FREE_DELIVERY_NUDGE_NGN = 15000;

/** The VAT inside a VAT-inclusive amount, to the kobo: ₦10,750 at 7.5% includes ₦750. */
export function vatIncluded(amountNgn, ratePct) {
  return Math.round((amountNgn * ratePct * 100) / (100 + ratePct)) / 100;
}

export class Orders {
  constructor({ store, paystack, chord, pricing, config, alertOwner }) {
    this.store = store;
    this.pricing = pricing;
    this.paystack = paystack;
    this.chord = chord;
    this.config = config;
    this.alertOwner = alertOwner;
  }

  createOrder({ phone, customer_name, items, city, area, address, referral_code, deal_ids, conversation_id }) {
    const key = normalisePhone(phone);
    if (key.length < 10) return { ok: false, reason: 'invalid_phone', message: 'That phone number does not look valid.' };
    const priced = this.#priceCart(key, items, referral_code, deal_ids);
    if (!priced.ok) return priced;
    const lines = priced.lines;
    const subtotal = priced.subtotal_ngn;
    const delivery = quoteDelivery(city, area, subtotal);
    if (!delivery.ok) return delivery;
    if (!address || address.trim().length < 8) {
      return { ok: false, reason: 'address_missing', message: 'Ask for the full delivery address (street, area, landmark).' };
    }

    this.store.upsertCustomer(key, { name: customer_name, city: delivery.city, area, address });
    this.pricing.linkDeals(lines, key);
    const order = this.store.putOrder({
      id: this.store.newOrderId(),
      phone: key,
      customer_name: customer_name || this.store.customer(key)?.name || null,
      items: lines,
      list_subtotal_ngn: priced.list_subtotal_ngn,
      discounts: priced.discounts,
      referral: priced.referral?.code ? priced.referral : null,
      subtotal_ngn: subtotal,
      delivery_fee_ngn: delivery.fee_ngn,
      total_ngn: subtotal + delivery.fee_ngn,
      vat_rate_pct: this.config.vatRatePct,
      vat_included_ngn: vatIncluded(subtotal + delivery.fee_ngn, this.config.vatRatePct),
      city: delivery.city,
      area,
      zone: delivery.zone,
      zone_uncertain: delivery.zone_uncertain,
      delivery_days: delivery.delivery_days,
      address: address.trim(),
      status: 'pending_payment',
      conversation_id: conversation_id || null,
      payment: null,
      payment_attempts: [],
      followups: [],
      followups_suppressed: false,
      created_at: new Date().toISOString(),
      paid_at: null,
    });
    this.store.save();
    const gap = FREE_DELIVERY_THRESHOLD_NGN - subtotal;
    return {
      ok: true,
      order: summarise(order),
      ...(priced.referral?.rejected && { referral_rejected: priced.referral.rejected }),
      ...(priced.discount_capped && { discount_capped: true }),
      ...(!delivery.free_delivery && gap <= FREE_DELIVERY_NUDGE_NGN && {
        free_delivery_gap_ngn: gap,
        hint: `₦${gap.toLocaleString('en-NG')} more in products gets free delivery (saves ₦${delivery.fee_ngn.toLocaleString('en-NG')}). Mention it once; don't push.`,
      }),
    };
  }

  /** Validates the items and prices them (negotiated prices, referral, credit). Shared by quoteCart and createOrder. */
  #priceCart(phone, items, referralCode, dealIds) {
    if (!items?.length) return { ok: false, reason: 'no_items', message: 'An order needs at least one product.' };
    const totalUnits = items.reduce((n, i) => n + i.qty, 0);
    if (totalUnits > MAX_UNITS_PER_ORDER) {
      return { ok: false, reason: 'bulk_order', message: `Orders over ${MAX_UNITS_PER_ORDER} units are handled by the team. Hand over to a human.` };
    }
    const lines = [];
    for (const { sku, qty } of items) {
      const p = this.store.product(sku);
      if (!p) return { ok: false, reason: 'unknown_sku', message: `No product with SKU ${sku}. Use search_products to find the right one.` };
      if (p.stock < qty) {
        return { ok: false, reason: 'insufficient_stock', sku: p.sku, in_stock: p.stock, message: `Only ${p.stock} of ${p.name} left.` };
      }
      lines.push({ sku: p.sku, name: p.name, qty });
    }
    // Negotiated prices, referral discount and store credit are all applied server-side.
    return this.pricing.priceLines(phone, lines, referralCode, dealIds);
  }

  /**
   * The running total of what the customer has picked, before an order exists. Delivery is added only when the
   * city and area are known, so the agent can show the products total first and the full total later.
   */
  quoteCart({ phone, items, referral_code, deal_ids, city, area }) {
    const priced = this.#priceCart(phone ? normalisePhone(phone) : null, items, referral_code, deal_ids);
    if (!priced.ok) return priced;
    const productsTotal = priced.subtotal_ngn;
    const delivery = city ? quoteDelivery(city, area, productsTotal) : null;
    if (delivery && !delivery.ok) return delivery;
    const gap = FREE_DELIVERY_THRESHOLD_NGN - productsTotal;
    return {
      ok: true,
      items: priced.lines.map((l) => ({
        name: l.name,
        qty: l.qty,
        unit_price_ngn: l.unit_price_ngn,
        line_total_ngn: l.unit_price_ngn * l.qty,
        ...(l.negotiated && { agreed_price: true }),
      })),
      discounts: priced.discounts,
      ...(priced.referral?.rejected && { referral_rejected: priced.referral.rejected }),
      products_total_ngn: productsTotal,
      delivery_fee_ngn: delivery ? delivery.fee_ngn : null,
      total_ngn: delivery ? productsTotal + delivery.fee_ngn : null,
      vat_rate_pct: this.config.vatRatePct,
      // VAT inside the largest total shown: the full total once delivery is known, otherwise the products total.
      vat_included_ngn: vatIncluded(delivery ? productsTotal + delivery.fee_ngn : productsTotal, this.config.vatRatePct),
      ...(delivery?.zone_uncertain && { zone_uncertain: true }),
      ...(gap > 0 && gap <= FREE_DELIVERY_NUDGE_NGN && { free_delivery_gap_ngn: gap }),
      message: delivery
        ? 'Show each item with its line total, the delivery fee, the total and the VAT it includes.'
        : `Show each item with its line total, the products total and the VAT it includes, and say delivery is added once you know their area (free from ₦${FREE_DELIVERY_THRESHOLD_NGN.toLocaleString('en-NG')}).`,
    };
  }

  async createPaymentLink({ order_id, email }) {
    const order = this.store.order(order_id);
    if (!order) return { ok: false, reason: 'order_not_found', message: `No order ${order_id}.` };
    if (order.status === 'paid') return { ok: false, reason: 'already_paid', message: 'This order is already paid. Do not send another link.' };
    if (order.status === 'needs_review') return { ok: false, reason: 'needs_review', message: 'This order is with the team for review. Hand over to a human.' };

    // Reuse a live link instead of creating duplicates if the customer asks twice.
    const p = order.payment;
    const ageHours = p ? (Date.now() - Date.parse(p.created_at)) / 3600000 : Infinity;
    if (p && p.status !== 'failed' && ageHours < LINK_REUSE_HOURS) {
      return { ok: true, reused: true, payment_url: p.authorization_url, reference: p.reference, amount_ngn: order.total_ngn };
    }

    const attempt = order.payment_attempts.length + 1;
    const reference = `${order.id}-${attempt}-${Date.now().toString(36)}`;
    try {
      const init = await this.paystack.initialize({
        // WhatsApp customers rarely give an email; Paystack requires one, so use a reserved placeholder domain.
        email: email || `wa-${order.phone}@example.com`,
        amountNgn: order.total_ngn,
        reference,
        metadata: { order_id: order.id, phone: order.phone, source: 'glamoriz-whatsapp' },
      });
      order.payment = { reference: init.reference, authorization_url: init.authorization_url, status: 'pending', created_at: new Date().toISOString() };
      order.payment_attempts.push({ reference: init.reference, created_at: order.payment.created_at });
      order.status = 'pending_payment';
      this.store.save();
      return { ok: true, reused: false, payment_url: init.authorization_url, reference: init.reference, amount_ngn: order.total_ngn, mode: this.paystack.mode };
    } catch (err) {
      // The tool result only carries the message; log the full error (status, cause, stack) for debugging.
      console.error(`[create_payment_link] Paystack initialize failed for ${order.id} (reference ${reference}, ₦${order.total_ngn}):`, err);
      return {
        ok: false,
        reason: 'paystack_error',
        retryable: Boolean(err.retryable),
        message: `Could not create a payment link: ${err.message}. ${err.retryable ? 'Try once more; if it fails again, hand over to a human.' : 'Hand over to a human.'}`,
      };
    }
  }

  /** Checks Paystack and applies the result to the order. Safe to call repeatedly (and from the webhook). */
  async verifyPayment({ order_id, reference }) {
    const order = reference ? this.store.orderByReference(reference) : this.store.order(order_id);
    if (!order) return { ok: false, reason: 'order_not_found', message: `No order ${order_id || reference}.` };
    if (order.status === 'paid') return { ok: true, status: 'success', already_confirmed: true, order: summarise(order) };
    if (!order.payment) return { ok: true, status: 'no_payment_link', message: 'No payment link has been sent for this order yet.' };

    const ref = reference || order.payment.reference;
    if (ref !== order.payment.reference) {
      // An earlier link was paid: make it the order's current payment before applying the result.
      order.payment = { ...order.payment, reference: ref };
    }
    let result;
    try {
      result = await this.paystack.verify(ref);
    } catch (err) {
      return { ok: false, reason: 'paystack_unavailable', message: `Couldn't check with Paystack: ${err.message}. Tell the customer you'll confirm shortly, and don't confirm the order.` };
    }
    order.payment.last_checked_at = new Date().toISOString();
    order.payment.gateway_response = result.gateway_response || null;

    if (result.status === 'success') {
      const expectedKobo = order.total_ngn * 100;
      if (result.amount_kobo !== expectedKobo || (result.currency && result.currency !== 'NGN')) {
        order.status = 'needs_review';
        order.payment.status = 'amount_mismatch';
        this.store.save();
        await this.alertOwner(`Payment amount mismatch on ${order.id}: expected ₦${order.total_ngn}, Paystack reported ${result.amount_kobo / 100} ${result.currency}.`);
        return { ok: true, status: 'needs_review', message: 'The amount paid does not match the order. Do not confirm it. Hand over to a human.' };
      }
      this.#markPaid(order, result.paid_at);
      return { ok: true, status: 'success', order: summarise(order) };
    }

    if (result.status === 'failed') {
      order.payment.status = 'failed';
      order.status = 'payment_failed';
      this.store.save();
      return { ok: true, status: 'failed', reason: result.gateway_response || 'Payment was declined', message: 'Payment failed. Offer a fresh link (create_payment_link) or a different payment method on the Paystack page.' };
    }

    this.store.save();
    // abandoned, pending or not_found: nothing has been paid yet.
    return {
      ok: true,
      status: result.status === 'not_found' ? 'pending' : result.status,
      message: 'Paystack has not received this payment yet. Do not confirm the order. Offer to resend the link or check again in a minute.',
      payment_url: order.payment.authorization_url,
    };
  }

  #markPaid(order, paidAt) {
    const shortfalls = [];
    for (const line of order.items) {
      const p = this.store.product(line.sku);
      if (!p || p.stock < line.qty) shortfalls.push(line.name);
      this.store.decrementStock(line.sku, line.qty);
    }
    order.status = 'paid';
    order.payment.status = 'success';
    order.paid_at = paidAt || new Date().toISOString();
    const referrer = this.pricing.settle(order);
    if (referrer) order.referral.rewarded = true;
    if (shortfalls.length) {
      // Two customers paid for the last unit at once. Money is in, so confirm, and get a human to sort stock.
      order.stock_shortfall = shortfalls;
      this.alertOwner(`Stock shortfall on paid order ${order.id}: ${shortfalls.join(', ')}. Restock or contact the customer.`);
    }
    this.store.save();
  }

  getOrder({ order_id }) {
    const order = this.store.order(order_id);
    if (!order) return { ok: false, reason: 'order_not_found' };
    const customer = this.store.customer(order.phone);
    let followup_allowed = true;
    let reason = null;
    if (order.status !== 'paid') [followup_allowed, reason] = [false, `order status is ${order.status}`];
    else if (order.followups_suppressed) [followup_allowed, reason] = [false, 'follow-ups suppressed after a complaint or "no thanks"'];
    else if (customer?.opt_out) [followup_allowed, reason] = [false, 'customer opted out of messages'];
    return { ok: true, order: summarise(order), followup_allowed, followup_blocked_reason: reason, completed_followups: order.completed_followups || [] };
  }

  /** Works out when each follow-up is due. Demo mode compresses days into minutes. */
  followupPlan(order) {
    const base = Date.parse(order.paid_at);
    const { checkinAfterMinutes, reorderLeadDays, demoMinutes } = this.config.followups;
    const supplyDays = Math.min(...order.items.map((l) => this.store.product(l.sku)?.days_supply ?? 30));
    const minute = 60000;
    const checkinAt = demoMinutes ? Date.now() + demoMinutes * minute : base + checkinAfterMinutes * minute;
    const reorderAt = demoMinutes ? Date.now() + 2 * demoMinutes * minute : base + Math.max(supplyDays - reorderLeadDays, 7) * 1440 * minute;
    return [
      { type: 'day3_checkin', due_at: new Date(checkinAt).toISOString() },
      { type: 'reorder', due_at: new Date(reorderAt).toISOString() },
    ];
  }

  async scheduleFollowups({ order_id, conversation_id }) {
    const order = this.store.order(order_id);
    if (!order) return { ok: false, reason: 'order_not_found' };
    if (order.status !== 'paid') return { ok: false, reason: 'not_paid', message: 'Follow-ups are only scheduled for paid orders.' };
    if (order.followups.some((f) => f.status === 'scheduled')) {
      return { ok: true, already_scheduled: true, followups: order.followups };
    }
    if (conversation_id) order.conversation_id = conversation_id;

    const plan = this.followupPlan(order);
    const results = [];
    for (const f of plan) {
      const prompt = followupPrompt(order, f.type);
      if (!this.chord.configured || !order.conversation_id) {
        results.push({ ...f, status: 'needs_agent_reminder', prompt });
        continue;
      }
      try {
        const { task_id } = await this.chord.scheduleAgentRun({
          scheduledAt: f.due_at,
          prompt,
          conversationId: order.conversation_id,
          idempotencyKey: `${order.id}-${f.type}`,
        });
        results.push({ ...f, status: 'scheduled', task_id });
      } catch (err) {
        results.push({ ...f, status: 'needs_agent_reminder', prompt, error: err.message });
      }
    }
    order.followups = results;
    this.store.save();

    const fallback = results.filter((r) => r.status === 'needs_agent_reminder');
    return {
      ok: true,
      followups: results.map(({ prompt, ...r }) => r),
      ...(fallback.length && {
        action_needed:
          'The server could not schedule these follow-ups itself (no Chord API access or conversation id). ' +
          'Use your schedule_reminder tool to schedule each one at its due_at with the prompt given.',
        reminders: fallback.map((r) => ({ type: r.type, due_at: r.due_at, prompt: r.prompt })),
      }),
    };
  }

  markFollowupDone(order, type) {
    order.completed_followups = [...new Set([...(order.completed_followups || []), type])];
  }
}

function followupPrompt(order, type) {
  const who = `${order.customer_name || 'the customer'} (WhatsApp ${order.phone})`;
  const what = order.items.map((l) => `${l.qty} x ${l.name}`).join(', ');
  const task =
    type === 'day3_checkin'
      ? 'Send the day-3 delivery and first-impressions check-in.'
      : 'Send the reorder nudge: the product is about to run out.';
  return (
    `Glamoriz aftercare follow-up "${type}" for order ${order.id}, ${who}, who bought ${what}. ` +
    `Follow the glamoriz-aftercare skill. First call get_order for ${order.id}; if followup_allowed is false, send the customer ` +
    `nothing at all (no explanation). Otherwise: ${task} Send one short WhatsApp message only, with no reasoning or tool details.`
  );
}

export function summarise(order) {
  return {
    order_id: order.id,
    status: order.status,
    customer_name: order.customer_name,
    phone: order.phone,
    items: order.items,
    list_subtotal_ngn: order.list_subtotal_ngn ?? order.subtotal_ngn,
    discounts: order.discounts || null,
    subtotal_ngn: order.subtotal_ngn,
    delivery_fee_ngn: order.delivery_fee_ngn,
    total_ngn: order.total_ngn,
    vat_rate_pct: order.vat_rate_pct ?? null,
    vat_included_ngn: order.vat_included_ngn ?? null,
    city: order.city,
    area: order.area,
    zone: order.zone,
    zone_uncertain: order.zone_uncertain || false,
    delivery_days: order.delivery_days ?? null,
    address: order.address,
    created_at: order.created_at,
    paid_at: order.paid_at,
    payment_status: order.payment?.status || null,
    stock_shortfall: order.stock_shortfall || null,
  };
}
