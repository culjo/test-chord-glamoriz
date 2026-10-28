// A small JSON-file store. Good enough for one process and a demo; the go-live note says to replace it
// with a real database (or the owner's Google Sheet) before real customers use it.
import fs from 'node:fs';
import path from 'node:path';

const EMPTY = { customers: {}, orders: {}, complaints: [], feedback: [], next_order_number: 1001, next_ticket_number: 1 };

/** Nigerian WhatsApp numbers arrive in many shapes: 0803..., +234 803..., 234803... → 234803... */
export function normalisePhone(phone) {
  let digits = String(phone || '').replace(/\D/g, '');
  if (digits.startsWith('0') && digits.length === 11) digits = `234${digits.slice(1)}`;
  return digits;
}

export class Store {
  constructor({ dataDir, catalogPath, seedCustomersPath }) {
    this.file = path.join(dataDir, 'store.json');
    this.catalog = JSON.parse(fs.readFileSync(catalogPath, 'utf8'));
    fs.mkdirSync(dataDir, { recursive: true });
    if (fs.existsSync(this.file)) {
      this.db = JSON.parse(fs.readFileSync(this.file, 'utf8'));
    } else {
      this.db = structuredClone(EMPTY);
      this.#seed(seedCustomersPath);
      this.save();
    }
    // Stock lives in the store once seeded, so sales decrement it.
    this.db.stock ??= Object.fromEntries(this.catalog.map((p) => [p.sku, p.stock]));
  }

  #seed(seedCustomersPath) {
    if (seedCustomersPath && fs.existsSync(seedCustomersPath)) {
      for (const c of JSON.parse(fs.readFileSync(seedCustomersPath, 'utf8'))) {
        this.db.customers[normalisePhone(c.phone)] = { ...c, phone: normalisePhone(c.phone) };
      }
    }
    const seedOrders = path.join(path.dirname(seedCustomersPath || ''), 'seed-orders.json');
    if (fs.existsSync(seedOrders)) {
      for (const o of JSON.parse(fs.readFileSync(seedOrders, 'utf8'))) {
        const paidAt = new Date(Date.now() - o.days_ago * 86400000).toISOString();
        const { days_ago, ...order } = o;
        this.db.orders[o.id] = { ...order, created_at: paidAt, paid_at: paidAt, payment: null, followups: [], followups_suppressed: false };
      }
    }
  }

  save() {
    // Write to a temp file and rename, so a crash mid-write can't corrupt the store.
    const tmp = `${this.file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(this.db, null, 2));
    fs.renameSync(tmp, this.file);
  }

  product(sku) {
    const p = this.catalog.find((x) => x.sku === String(sku).trim().toUpperCase());
    return p ? { ...p, stock: this.db.stock[p.sku] ?? 0 } : null;
  }

  products() {
    return this.catalog.map((p) => ({ ...p, stock: this.db.stock[p.sku] ?? 0 }));
  }

  decrementStock(sku, qty) {
    this.db.stock[sku] = Math.max(0, (this.db.stock[sku] ?? 0) - qty);
  }

  customer(phone) {
    return this.db.customers[normalisePhone(phone)] || null;
  }

  upsertCustomer(phone, fields) {
    const key = normalisePhone(phone);
    const existing = this.db.customers[key] || {
      phone: key,
      referral_code: null,
      discount: null,
      opt_out: false,
      created_at: new Date().toISOString(),
    };
    const merged = { ...existing, ...Object.fromEntries(Object.entries(fields).filter(([, v]) => v !== undefined && v !== null && v !== '')) };
    if (!merged.referral_code && merged.name) {
      merged.referral_code = `${merged.name.split(/\s+/)[0].toUpperCase().replace(/[^A-Z]/g, '').slice(0, 6)}${key.slice(-3)}`;
    }
    this.db.customers[key] = merged;
    return merged;
  }

  ordersFor(phone) {
    const key = normalisePhone(phone);
    return Object.values(this.db.orders)
      .filter((o) => o.phone === key)
      .sort((a, b) => b.created_at.localeCompare(a.created_at));
  }

  order(id) {
    return this.db.orders[String(id || '').trim().toUpperCase()] || null;
  }

  newOrderId() {
    return `GLZ-${this.db.next_order_number++}`;
  }

  putOrder(order) {
    this.db.orders[order.id] = order;
    return order;
  }

  orderByReference(reference) {
    // Includes older attempts: a customer may pay an earlier link after we've sent a fresh one.
    return (
      Object.values(this.db.orders).find(
        (o) => o.payment?.reference === reference || o.payment_attempts?.some((a) => a.reference === reference),
      ) || null
    );
  }

  addComplaint(c) {
    const ticket = { id: `TKT-${String(this.db.next_ticket_number++).padStart(4, '0')}`, ...c, created_at: new Date().toISOString(), status: 'open' };
    this.db.complaints.push(ticket);
    return ticket;
  }

  addFeedback(f) {
    const entry = { ...f, created_at: new Date().toISOString() };
    this.db.feedback.push(entry);
    return entry;
  }
}
