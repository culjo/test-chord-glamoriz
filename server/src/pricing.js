// Price negotiation, referral discounts and store credit. All price decisions happen here, never in the model:
// the agent only passes the customer's offer and quotes back what this returns. Floor prices never leave the server,
// so a customer can't talk (or prompt-inject) the agent below them.
import crypto from 'node:crypto';
import { normalisePhone } from './store.js';

const DEAL_HOURS = 24;
// Share of the gap between list price and floor that each bargaining round gives away.
// Returning customers (or 3+ units) reach the floor on the third ask; a first-time buyer stops short of it.
const LADDER_RETURNING = [0.4, 0.7, 1.0];
const LADDER_NEW = [0.3, 0.55, 0.8];
// After the ladder, a customer who keeps pushing gets smaller steps: half of what's left above the floor each time,
// and the floor itself once it's within this amount.
const LAST_STEP_NGN = 500;
const BULK_UNITS = 3;
const LOWBALL_SHARE = 0.75; // an offer under 75% of list is a lowball
export const REFERRAL_DISCOUNT_NGN = 2000;
export const REFERRAL_REWARD_NGN = 2000;

const roundUp100 = (n) => Math.ceil(n / 100) * 100;

export class Pricing {
  constructor({ store }) {
    this.store = store;
    this.store.db.deals ??= {};
    // Deals used to be keyed by "phone|sku"; give those an id so they're found the same way as new ones.
    for (const [key, deal] of Object.entries(this.store.db.deals)) {
      if (deal.id) continue;
      delete this.store.db.deals[key];
      const id = newDealId();
      this.store.db.deals[id] = { ...deal, id, phone: key.split('|')[0] || null };
    }
  }

  paidOrders(phone) {
    return phone ? this.store.ordersFor(phone).filter((o) => o.status === 'paid').length : 0;
  }

  /**
   * The live agreed price for a product: by one of the given deal ids, or by the customer's phone.
   * A deal made before we knew the phone works with any phone; one tied to a phone only works for that phone.
   */
  dealFor(phone, sku, dealIds = []) {
    const key = phone ? normalisePhone(phone) : null;
    const live = (d) => d && d.sku === sku && Date.parse(d.expires_at) >= Date.now() && (!d.phone || !key || d.phone === key);
    for (const id of dealIds) {
      const d = this.store.db.deals[String(id).trim()];
      if (live(d)) return d;
    }
    if (!key) return null;
    return Object.values(this.store.db.deals).find((d) => live(d) && d.phone === key) || null;
  }

  /** Ties phone-less deals used in an order to the customer's number, so nobody else can reuse them. */
  linkDeals(lines, phone) {
    for (const line of lines) {
      const deal = line.deal_id && this.store.db.deals[line.deal_id];
      if (deal && !deal.phone) deal.phone = normalisePhone(phone);
    }
  }

  clearDeal(id) {
    delete this.store.db.deals[id];
  }

  // TODO(simulator-phone): phone is optional because the Chord WhatsApp simulator doesn't give the agent the
  // sender's number. See TODO.md: once we know how the channel passes it, revisit whether deal_id is still needed.
  negotiate({ phone, sku, qty = 1, offer_ngn, deal_id }) {
    const p = this.store.product(sku);
    if (!p) return { ok: false, reason: 'unknown_sku', message: `No product ${sku}.` };
    const floor = p.floor_price_ngn ?? p.price_ngn;
    const list = p.price_ngn;
    const gap = list - floor;
    if (gap <= 0) {
      return {
        ok: true,
        negotiable: false,
        price_ngn: list,
        message: `${p.name} is already at its lowest price. Don't offer a discount; mention free delivery from ₦50,000 or a friend's referral code instead.`,
      };
    }

    const key = phone ? normalisePhone(phone) : null;
    // Without a phone we can't tell a returning customer, so first-time prices apply until we know.
    const returning = this.paidOrders(key) > 0 || qty >= BULK_UNITS;
    const ladder = returning ? LADDER_RETURNING : LADDER_NEW;
    const steps = ladder.map((share) => Math.max(floor, roundUp100(list - share * gap)));

    const prev = this.dealFor(key, p.sku, deal_id ? [deal_id] : []);
    const deal = prev && prev.qty <= qty ? { ...prev } : { id: newDealId(), sku: p.sku, round: 0, price_ngn: list, qty, accepted: false };
    deal.qty = Math.max(deal.qty, qty);
    deal.phone = deal.phone || key; // link a phone-less deal once the number is known
    const expires_at = new Date(Date.now() + DEAL_HOURS * 3600000).toISOString();

    // The next counter: down the ladder, then smaller steps towards the floor, then the floor.
    const nextStep = () => {
      if (deal.round < steps.length) return Math.min(deal.price_ngn, steps[deal.round]);
      const left = deal.price_ngn - floor;
      return left <= LAST_STEP_NGN ? floor : Math.max(floor, roundUp100(deal.price_ngn - left / 2));
    };

    // The customer named a price we can take: take it rather than going lower than they asked.
    if (offer_ngn && offer_ngn >= nextStep()) {
      const price = Math.min(list, Math.max(floor, roundUp100(offer_ngn)));
      Object.assign(deal, { price_ngn: Math.min(deal.price_ngn, price), accepted: true, expires_at });
      this.store.db.deals[deal.id] = deal;
      this.store.save();
      return {
        ok: true,
        negotiable: true,
        accepted: true,
        deal_id: deal.id,
        price_ngn: deal.price_ngn,
        list_price_ngn: list,
        qty: deal.qty,
        valid_until: expires_at,
        message: `Accept: ₦${deal.price_ngn.toLocaleString('en-NG')} each is agreed. Pass deal_id to quote_cart and create_order so it's applied.`,
      };
    }

    // Each ask without an acceptable offer moves one step down, and stops at the floor.
    const counter = nextStep();
    deal.round += 1;
    Object.assign(deal, { price_ngn: counter, expires_at, accepted: false });
    this.store.db.deals[deal.id] = deal;
    this.store.save();

    const lastOffer = deal.price_ngn <= floor;
    const pastLadder = deal.round > steps.length;
    return {
      ok: true,
      negotiable: true,
      accepted: false,
      deal_id: deal.id,
      counter_price_ngn: deal.price_ngn,
      list_price_ngn: list,
      qty: deal.qty,
      round: deal.round,
      final: lastOffer,
      lowball: Boolean(offer_ngn && offer_ngn < list * LOWBALL_SHARE),
      valid_until: expires_at,
      ...(lastOffer && { alternatives: this.#alternatives(key) }),
      message: lastOffer
        ? `This is the best price. Offer ₦${deal.price_ngn.toLocaleString('en-NG')} as final and don't go lower. If they still say no, try the alternatives, then let it go politely.`
        : pastLadder
          ? `Counter with ₦${deal.price_ngn.toLocaleString('en-NG')} each, a small extra step, and ask them to commit ("If I do that, shall I place the order?"). Don't hint that a lower price exists. Pass deal_id to negotiate_price if they push back again, and to quote_cart and create_order if they accept.`
          : `Counter with ₦${deal.price_ngn.toLocaleString('en-NG')} each. Don't hint that a lower price exists. Pass deal_id to negotiate_price if they push back again, and to quote_cart and create_order if they accept.`,
    };
  }

  #alternatives(phone) {
    const c = this.store.customer(phone);
    const alts = ['Free delivery on orders of ₦50,000 or more'];
    if (c?.credit_ngn) alts.push(`They have ₦${c.credit_ngn.toLocaleString('en-NG')} store credit, applied automatically at create_order`);
    else if (!this.paidOrders(phone)) alts.push(`A friend's referral code gives ₦${REFERRAL_DISCOUNT_NGN.toLocaleString('en-NG')} off a first order`);
    if (!this.paidOrders(phone)) alts.push('Returning customers and orders of 3+ units can get a better price');
    return alts;
  }

  /** Checks a referral code for this (first-time) customer. */
  checkReferral(phone, code) {
    if (!code) return null;
    const wanted = String(code).trim().toUpperCase();
    const referrer = Object.values(this.store.db.customers).find((c) => c.referral_code?.toUpperCase() === wanted);
    if (!referrer) return { ok: false, reason: 'unknown_referral_code' };
    if (referrer.phone === normalisePhone(phone)) return { ok: false, reason: 'own_referral_code' };
    if (this.paidOrders(phone) > 0) return { ok: false, reason: 'referral_first_order_only' };
    return { ok: true, code: referrer.referral_code, referrer_phone: referrer.phone, amount_ngn: REFERRAL_DISCOUNT_NGN };
  }

  /**
   * Prices order lines: negotiated unit prices, then referral discount and store credit on the subtotal,
   * never taking the order below the sum of floor prices.
   */
  priceLines(phone, lines, referralCode, dealIds = []) {
    let listSubtotal = 0;
    let floorTotal = 0;
    for (const line of lines) {
      const p = this.store.product(line.sku);
      const deal = this.dealFor(phone, line.sku, dealIds);
      if (deal && line.qty < deal.qty) {
        return {
          ok: false,
          reason: 'deal_qty_mismatch',
          sku: line.sku,
          message: `The ₦${deal.price_ngn.toLocaleString('en-NG')} price for ${line.name} was agreed for ${deal.qty} units. Order ${deal.qty}, or ask again with negotiate_price for the new quantity.`,
        };
      }
      line.list_price_ngn = p.price_ngn;
      line.unit_price_ngn = deal?.price_ngn ?? p.price_ngn;
      if (deal) Object.assign(line, { negotiated: true, deal_id: deal.id });
      listSubtotal += p.price_ngn * line.qty;
      floorTotal += (p.floor_price_ngn ?? p.price_ngn) * line.qty;
    }
    const negotiatedSubtotal = lines.reduce((n, l) => n + l.unit_price_ngn * l.qty, 0);

    const referral = this.checkReferral(phone, referralCode);
    const credit = this.store.customer(phone)?.credit_ngn || 0;
    let room = Math.max(0, negotiatedSubtotal - floorTotal);
    const referralNgn = referral?.ok ? Math.min(referral.amount_ngn, room) : 0;
    room -= referralNgn;
    const creditNgn = Math.min(credit, room);

    return {
      ok: true,
      lines,
      subtotal_ngn: negotiatedSubtotal - referralNgn - creditNgn,
      list_subtotal_ngn: listSubtotal,
      discounts: { negotiated_ngn: listSubtotal - negotiatedSubtotal, referral_ngn: referralNgn, credit_ngn: creditNgn },
      discount_capped: Boolean((referral?.ok && referralNgn < referral.amount_ngn) || creditNgn < credit),
      referral: referral && (referral.ok ? { code: referral.code, referrer_phone: referral.referrer_phone } : { rejected: referral.reason }),
    };
  }

  /** On payment: use up store credit, reward the referrer and close the deals that were used. */
  settle(order) {
    const customer = this.store.customer(order.phone);
    if (customer && order.discounts?.credit_ngn) {
      customer.credit_ngn = Math.max(0, (customer.credit_ngn || 0) - order.discounts.credit_ngn);
    }
    let rewarded = null;
    if (order.referral?.referrer_phone && order.discounts?.referral_ngn) {
      const referrer = this.store.customer(order.referral.referrer_phone);
      if (referrer) {
        referrer.credit_ngn = (referrer.credit_ngn || 0) + REFERRAL_REWARD_NGN;
        rewarded = referrer;
      }
    }
    for (const line of order.items) if (line.deal_id) this.clearDeal(line.deal_id);
    return rewarded;
  }
}

function newDealId() {
  return `DL-${crypto.randomBytes(5).toString('hex').toUpperCase()}`;
}
