// End-to-end test over real HTTP and the MCP protocol, using the mock Paystack checkout.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { loadConfig } from '../src/config.js';
import { createApp } from '../src/index.js';

const TOKEN = 'test-token';
let server, base, client, paystack, dataDir;

async function call(name, args) {
  const res = await client.callTool({ name, arguments: args });
  assert.ok(!res.isError, `${name} errored: ${res.content?.[0]?.text}`);
  return JSON.parse(res.content[0].text);
}

before(async () => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'glamoriz-test-'));
  const config = loadConfig({ PORT: '0', MCP_AUTH_TOKEN: TOKEN, DATA_DIR: dataDir });
  const built = createApp(config);
  paystack = built.paystack;
  server = built.app.listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;
  // Mock checkout links point at PUBLIC_URL; align it with the random test port.
  paystack.publicUrl = base;
  client = new Client({ name: 'test', version: '1.0.0' });
  await client.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${TOKEN}` } } }));
});

after(async () => {
  await client?.close();
  server?.close();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

test('rejects MCP calls without the bearer token', async () => {
  const res = await fetch(`${base}/mcp`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
  assert.equal(res.status, 401);
});

test('lists every tool', async () => {
  const { tools } = await client.listTools();
  assert.deepEqual(
    tools.map((t) => t.name).sort(),
    ['check_stock', 'create_order', 'create_payment_link', 'get_customer', 'get_order', 'list_orders', 'log_complaint', 'negotiate_price', 'record_feedback', 'save_customer_details', 'schedule_followups', 'search_products', 'verify_payment'],
  );
});

test('recognises a returning customer from any phone format', async () => {
  const ada = await call('get_customer', { phone: '0803 000 0001' });
  assert.equal(ada.found, true);
  assert.equal(ada.name, 'Ada Obi');
  assert.equal(ada.last_order.order_id, 'GLZ-1000');
  const stranger = await call('get_customer', { phone: '+234 812 345 6789' });
  assert.equal(stranger.found, false);
  assert.equal(stranger.reply_format.format, 'plain', 'plain text by default, for the WhatsApp simulator');
  const noNumber = await call('get_customer', {});
  assert.equal(noNumber.phone_known, false, 'a chat without a number still gets the reply format');
  assert.ok(noNumber.reply_format);
});

test('search and stock: out-of-stock items come with alternatives', async () => {
  const { results } = await call('search_products', { concern: 'dark spots', skin_type: 'oily' });
  assert.ok(results.length > 0 && results[0].in_stock);
  const pregnant = await call('search_products', { concern: 'acne', exclude_pregnancy_unsafe: true });
  assert.ok(pregnant.results.every((p) => !/pregnan/i.test(p.caution || '')));
  const browse = await call('search_products', {});
  assert.equal(browse.overview, true);
  assert.deepEqual(browse.results.map((p) => p.category).sort(), ['cleanser', 'moisturiser', 'serum', 'set', 'sunscreen']);
  assert.ok(browse.results.every((p) => p.in_stock));
  const sal = await call('check_stock', { sku: 'GLM-SER-02' });
  assert.equal(sal.in_stock, false);
  assert.ok(sal.alternatives.length > 0);
});

test('order validation: delivery area, bulk, stock', async () => {
  const kano = await call('create_order', { phone: '08120000003', items: [{ sku: 'GLM-SPF-01', qty: 1 }], city: 'Kano', area: 'Nassarawa', address: '1 Example Road, Kano' });
  assert.equal(kano.reason, 'outside_delivery_area');
  const bulk = await call('create_order', { phone: '08120000003', items: [{ sku: 'GLM-SPF-01', qty: 11 }], city: 'Lagos', area: 'Yaba', address: '1 Example Road, Yaba' });
  assert.equal(bulk.reason, 'bulk_order');
  const oos = await call('create_order', { phone: '08120000003', items: [{ sku: 'GLM-SER-02', qty: 1 }], city: 'Lagos', area: 'Yaba', address: '1 Example Road, Yaba' });
  assert.equal(oos.reason, 'insufficient_stock');
});

test('happy path: order → link → pending → paid → follow-ups', async () => {
  const created = await call('create_order', {
    phone: '08120000003',
    customer_name: 'Tolu Adeyemi',
    items: [{ sku: 'GLM-SER-01', qty: 1 }, { sku: 'GLM-SPF-01', qty: 1 }],
    city: 'lagos',
    area: 'Yaba',
    address: '5 Herbert Macaulay Way, Yaba, Lagos',
  });
  assert.equal(created.ok, true);
  const order = created.order;
  assert.equal(order.delivery_fee_ngn, 3000);
  assert.equal(order.total_ngn, 14500 + 15000 + 3000);

  const link = await call('create_payment_link', { order_id: order.order_id });
  assert.equal(link.ok, true);
  const again = await call('create_payment_link', { order_id: order.order_id });
  assert.equal(again.reused, true);
  assert.equal(again.payment_url, link.payment_url);

  assert.equal((await call('verify_payment', { order_id: order.order_id })).status, 'abandoned');

  const pay = await fetch(`${link.payment_url}/success`, { method: 'POST' });
  assert.equal(pay.status, 200);

  const verified = await call('verify_payment', { order_id: order.order_id });
  assert.equal(verified.status, 'success');
  assert.ok((await call('check_stock', { sku: 'GLM-SER-01' })).units_left === 24);
  assert.equal((await call('verify_payment', { order_id: order.order_id })).already_confirmed, true);

  const fu = await call('schedule_followups', { order_id: order.order_id });
  assert.equal(fu.ok, true);
  assert.equal(fu.reminders.length, 2, 'without Chord API access the agent is told to use schedule_reminder');
  assert.match(fu.reminders[0].prompt, /get_order/);

  const got = await call('get_order', { order_id: order.order_id });
  assert.equal(got.followup_allowed, true);

  const tolu = await call('get_customer', { phone: '+2348120000003' });
  assert.equal(tolu.name, 'Tolu Adeyemi');
  assert.ok(tolu.referral_code);
});

test('failed payment is never confirmed and gets a fresh link', async () => {
  const { order } = await call('create_order', { phone: '08120000004', customer_name: 'Ngozi', items: [{ sku: 'GLM-MOI-01', qty: 1 }], city: 'Abuja', area: 'Gwarinpa', address: '7 3rd Avenue, Gwarinpa, Abuja' });
  assert.equal(order.delivery_fee_ngn, 3500);
  const link = await call('create_payment_link', { order_id: order.order_id });
  await fetch(`${link.payment_url}/fail`, { method: 'POST' });
  const v = await call('verify_payment', { order_id: order.order_id });
  assert.equal(v.status, 'failed');
  assert.match(v.reason, /insufficient funds/i);
  const fresh = await call('create_payment_link', { order_id: order.order_id });
  assert.equal(fresh.reused, false);
  assert.notEqual(fresh.reference, link.reference);
  const fu = await call('schedule_followups', { order_id: order.order_id });
  assert.equal(fu.reason, 'not_paid');
});

test('amount mismatch is held for review, not confirmed', async () => {
  const { order } = await call('create_order', { phone: '08120000005', items: [{ sku: 'GLM-CLN-01', qty: 1 }], city: 'Abuja', area: 'Wuse', address: '2 Example Close, Wuse 2, Abuja' });
  const link = await call('create_payment_link', { order_id: order.order_id });
  paystack.mockComplete(link.reference, 'success');
  paystack.mockTransactions.get(link.reference).amount = 100; // ₦1 instead of the total
  const v = await call('verify_payment', { order_id: order.order_id });
  assert.equal(v.status, 'needs_review');
});

test('Paystack webhook: bad signature rejected, valid charge.success marks the order paid', async () => {
  const { order } = await call('create_order', { phone: '08120000006', items: [{ sku: 'GLM-CLN-02', qty: 1 }], city: 'Lagos', area: 'Lekki', address: '9 Example Street, Lekki, Lagos' });
  const link = await call('create_payment_link', { order_id: order.order_id });
  const body = JSON.stringify({ event: 'charge.success', data: { reference: link.reference } });

  const bad = await fetch(`${base}/paystack/webhook`, { method: 'POST', headers: { 'x-paystack-signature': 'nope' }, body });
  assert.equal(bad.status, 401);

  paystack.mockComplete(link.reference, 'success');
  const sig = crypto.createHmac('sha512', 'mock-secret').update(body).digest('hex');
  const good = await fetch(`${base}/paystack/webhook`, { method: 'POST', headers: { 'x-paystack-signature': sig, 'Content-Type': 'application/json' }, body });
  assert.equal(good.status, 200);
  await new Promise((r) => setTimeout(r, 100));
  assert.equal((await call('get_order', { order_id: order.order_id })).order.status, 'paid');
});

test('reply format: plain by default, overridable per channel, bad values refused at startup', async () => {
  const { replyFormat } = await import('../src/formatting.js');
  const config = loadConfig({ REPLY_FORMAT: 'whatsapp', REPLY_FORMAT_BY_CHANNEL: 'web=markdown, email=html' });
  assert.equal(replyFormat(config, 'WhatsApp').format, 'whatsapp');
  assert.equal(replyFormat(config, 'web').format, 'markdown');
  assert.equal(replyFormat(config, 'email').format, 'html');
  assert.equal(replyFormat(config).format, 'whatsapp');
  assert.throws(() => loadConfig({ REPLY_FORMAT: 'rtf' }), /REPLY_FORMAT must be one of/);
  assert.throws(() => loadConfig({ REPLY_FORMAT_BY_CHANNEL: 'web' }), /look like/);

  const got = await call('get_order', { order_id: 'GLZ-1000' });
  assert.equal(got.reply_format.format, 'plain');
  assert.match(got.reply_format.rules.join(' '), /no Markdown/i);
});

test('addressing: a new customer says how to be addressed, and it sticks', async () => {
  assert.equal((await call('get_customer', { phone: '08030000001' })).address_as, 'Ada');
  const phone = '08120000012';
  const saved = await call('save_customer_details', { phone, name: 'Chioma Okeke', address_as: 'ma' });
  assert.equal(saved.address_as, 'Ma');
  const c = await call('get_customer', { phone });
  assert.equal(c.found, true);
  assert.equal(c.paid_orders, 0);
  assert.equal(c.address_as, 'Ma');
  assert.equal((await call('save_customer_details', { phone, address_as: 'Aunty Chi' })).address_as, 'Aunty Chi');
  assert.equal((await call('get_customer', { phone })).name, 'Chioma Okeke', 'a correction keeps the name');
  assert.equal((await call('get_order', { order_id: 'GLZ-1000' })).address_as, 'Ada');
});

async function pay(orderId) {
  const link = await call('create_payment_link', { order_id: orderId });
  await fetch(`${link.payment_url}/success`, { method: 'POST' });
  return call('verify_payment', { order_id: orderId });
}

test('negotiation: counters step down, stop at a final price and never reveal the floor', async () => {
  const phone = '08120000007';
  const asks = [];
  for (const offer of [10000, undefined, 12000, 12000]) asks.push(await call('negotiate_price', { phone, sku: 'GLM-SER-01', offer_ngn: offer }));
  assert.deepEqual(asks.map((a) => a.counter_price_ngn), [13900, 13400, 12900, 12900], 'a first-time buyer stops above the floor');
  assert.equal(asks[0].lowball, true);
  assert.deepEqual(asks.map((a) => a.final), [false, false, true, true]);
  assert.ok(asks[2].alternatives.length > 0);
  for (const a of asks) assert.ok(!JSON.stringify(a).includes('floor'), 'floor price must never reach the agent');
  const { results } = await call('search_products', { concern: 'dark spots' });
  assert.ok(results.every((r) => !('floor_price_ngn' in r)));

  const yes = await call('negotiate_price', { phone, sku: 'GLM-SER-01', offer_ngn: 12900 });
  assert.equal(yes.accepted, true);
  const { order } = await call('create_order', { phone, items: [{ sku: 'GLM-SER-01', qty: 1 }], city: 'Lagos', area: 'Yaba', address: '3 Example Street, Yaba, Lagos' });
  assert.equal(order.items[0].unit_price_ngn, 12900);
  assert.equal(order.discounts.negotiated_ngn, 1600);
  assert.equal(order.total_ngn, 12900 + 3000);
});

test('negotiation: a fair offer is taken as-is; returning customers and 3+ units can reach the floor', async () => {
  const fair = await call('negotiate_price', { phone: '08120000010', sku: 'GLM-SER-01', offer_ngn: 14000 });
  assert.equal(fair.accepted, true);
  assert.equal(fair.price_ngn, 14000, "don't go lower than the customer asked");

  const ada = [];
  for (let i = 0; i < 4; i++) ada.push((await call('negotiate_price', { phone: '08030000001', sku: 'GLM-SER-01' })).counter_price_ngn);
  assert.deepEqual(ada, [13700, 13100, 12500, 12500]);

  const set = await call('negotiate_price', { phone: '08120000010', sku: 'GLM-SET-01' });
  assert.equal(set.negotiable, false);

  const bulk = await call('negotiate_price', { phone: '08120000011', sku: 'GLM-SPF-01', qty: 3 });
  assert.equal(bulk.counter_price_ngn, 14200);
  const fewer = await call('create_order', { phone: '08120000011', items: [{ sku: 'GLM-SPF-01', qty: 1 }], city: 'Lagos', area: 'Yaba', address: '3 Example Street, Yaba, Lagos' });
  assert.equal(fewer.reason, 'deal_qty_mismatch', 'a bulk price cannot be used on one unit');
});

test('referral: friend gets ₦2,000 off a first order, referrer gets ₦2,000 credit once it is paid', async () => {
  const own = await call('create_order', { phone: '08030000001', items: [{ sku: 'GLM-CLN-01', qty: 1 }], referral_code: 'ADA2K', city: 'Lagos', area: 'Lekki', address: '12 Admiralty Way, Lekki' });
  assert.equal(own.referral_rejected, 'own_referral_code');
  assert.equal(own.order.discounts.referral_ngn, 0);

  const before = (await call('get_customer', { phone: '08030000001' })).credit_ngn;
  const { order } = await call('create_order', { phone: '08120000008', items: [{ sku: 'GLM-SER-03', qty: 1 }], referral_code: 'ada2k', city: 'Abuja', area: 'Wuse', address: '5 Example Close, Wuse 2, Abuja' });
  assert.equal(order.discounts.referral_ngn, 2000);
  assert.equal(order.subtotal_ngn, 16000);
  assert.equal((await pay(order.order_id)).status, 'success');
  assert.equal((await call('get_customer', { phone: '08030000001' })).credit_ngn, before + 2000);

  const again = await call('create_order', { phone: '08120000008', items: [{ sku: 'GLM-CLN-01', qty: 1 }], referral_code: 'ADA2K', city: 'Abuja', area: 'Wuse', address: '5 Example Close, Wuse 2, Abuja' });
  assert.equal(again.referral_rejected, 'referral_first_order_only');
});

test('discounts never take an order below its floor, and near-threshold orders get a free-delivery hint', async () => {
  // Ada now has ₦2,000 credit; the cleanser only has ₦1,000 of room above its floor.
  const { order, discount_capped } = await call('create_order', { phone: '08030000001', items: [{ sku: 'GLM-CLN-01', qty: 1 }], city: 'Lagos', area: 'Lekki', address: '12 Admiralty Way, Lekki' });
  assert.equal(order.discounts.credit_ngn, 1000);
  assert.equal(order.subtotal_ngn, 7500);
  assert.equal(discount_capped, true);
  await pay(order.order_id);
  assert.equal((await call('get_customer', { phone: '08030000001' })).credit_ngn, 1000, 'unused credit is kept');

  const near = await call('create_order', { phone: '08120000009', items: [{ sku: 'GLM-SET-01', qty: 1 }], city: 'Lagos', area: 'Lekki', address: '8 Example Road, Lekki' });
  assert.equal(near.free_delivery_gap_ngn, 5000);
  assert.match(near.hint, /free delivery/);
});

test('a reaction complaint stops further follow-ups', async () => {
  const c = await call('log_complaint', { order_id: 'GLM-none', phone: '08030000001', type: 'other', details: 'test' });
  assert.ok(c.ticket_id);
  const r = await call('log_complaint', { order_id: 'GLZ-1000', phone: '08030000001', type: 'reaction', details: 'Serum is burning my cheeks' });
  assert.match(r.ticket_id, /^TKT-/);
  const got = await call('get_order', { order_id: 'GLZ-1000' });
  assert.equal(got.followup_allowed, false);
});

test('opt-out is respected', async () => {
  await call('record_feedback', { order_id: 'GLZ-1000', followup_type: 'reorder', opt_out: true, text: 'Please stop messaging me' });
  assert.equal((await call('get_customer', { phone: '2348030000001' })).opt_out, true);
});
