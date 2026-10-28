// Paystack client: initialise a transaction, verify it, and check webhook signatures.
// In "mock" mode (no key set) it serves a fake checkout page so the whole flow can be tested offline.
import crypto from 'node:crypto';

export class PaystackError extends Error {
  constructor(message, { retryable = false, status = null } = {}) {
    super(message);
    this.retryable = retryable;
    this.status = status;
  }
}

// Paystack transaction statuses, collapsed into what the agent needs to decide.
// https://paystack.com/docs/api/transaction/#verify
const STATUS_MAP = {
  success: 'success',
  failed: 'failed',
  reversed: 'failed',
  abandoned: 'abandoned',
  ongoing: 'pending',
  pending: 'pending',
  processing: 'pending',
  queued: 'pending',
};

export class Paystack {
  constructor({ mode, secretKey, baseUrl, callbackUrl, timeoutMs }, { publicUrl }) {
    this.mode = mode;
    this.secretKey = secretKey;
    this.baseUrl = baseUrl;
    this.callbackUrl = callbackUrl;
    this.timeoutMs = timeoutMs;
    this.publicUrl = publicUrl;
    this.mockTransactions = new Map(); // reference → { status, amount, gateway_response }
  }

  async #request(method, path, body) {
    let res;
    try {
      res = await fetch(`${this.baseUrl}${path}`, {
        method,
        headers: { Authorization: `Bearer ${this.secretKey}`, 'Content-Type': 'application/json' },
        body: body ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (err) {
      const timedOut = err.name === 'TimeoutError';
      throw new PaystackError(timedOut ? 'Paystack did not respond in time' : `Could not reach Paystack: ${err.message}`, { retryable: true });
    }
    let json = null;
    try {
      json = await res.json();
    } catch {
      // Empty or non-JSON body (e.g. an HTML error page from a proxy).
    }
    if (!res.ok || !json?.status) {
      const msg = json?.message || `Paystack returned HTTP ${res.status} with no usable body`;
      throw new PaystackError(msg, { retryable: res.status >= 500 || res.status === 429, status: res.status });
    }
    if (!json.data) throw new PaystackError('Paystack returned success with no data', { retryable: true });
    return json.data;
  }

  /** Creates a checkout link. amountNgn is converted to kobo. */
  async initialize({ email, amountNgn, reference, metadata }) {
    if (this.mode === 'mock') {
      this.mockTransactions.set(reference, { status: 'abandoned', amount: amountNgn * 100, gateway_response: 'Awaiting payment' });
      return { authorization_url: `${this.publicUrl}/mock-pay/${encodeURIComponent(reference)}`, reference };
    }
    const data = await this.#request('POST', '/transaction/initialize', {
      email,
      amount: Math.round(amountNgn * 100),
      currency: 'NGN',
      reference,
      metadata,
      ...(this.callbackUrl ? { callback_url: this.callbackUrl } : {}),
    });
    return { authorization_url: data.authorization_url, reference: data.reference };
  }

  /**
   * Returns { status: success|failed|abandoned|pending|not_found, amount_kobo, currency, gateway_response, paid_at }.
   * Retries once on network errors and 5xx, because verify is a safe read.
   */
  async verify(reference) {
    if (this.mode === 'mock') {
      const t = this.mockTransactions.get(reference);
      if (!t) return { status: 'not_found' };
      return { status: t.status, amount_kobo: t.amount, currency: 'NGN', gateway_response: t.gateway_response, paid_at: t.paid_at || null };
    }
    for (let attempt = 1; ; attempt++) {
      try {
        const data = await this.#request('GET', `/transaction/verify/${encodeURIComponent(reference)}`);
        return {
          status: STATUS_MAP[data.status] || 'pending',
          raw_status: data.status,
          amount_kobo: data.amount,
          currency: data.currency,
          gateway_response: data.gateway_response,
          paid_at: data.paid_at || null,
        };
      } catch (err) {
        if (err.status === 400 || err.status === 404) return { status: 'not_found', gateway_response: err.message };
        if (!err.retryable || attempt >= 2) throw err;
        await new Promise((r) => setTimeout(r, 800));
      }
    }
  }

  /** Paystack signs webhooks with HMAC-SHA512 of the raw body, keyed with the secret key. */
  isValidSignature(rawBody, signature) {
    if (!signature) return false;
    const key = this.mode === 'mock' ? 'mock-secret' : this.secretKey;
    const expected = crypto.createHmac('sha512', key).update(rawBody).digest('hex');
    const a = Buffer.from(expected);
    const b = Buffer.from(String(signature));
    return a.length === b.length && crypto.timingSafeEqual(a, b);
  }

  // Mock checkout only.
  mockComplete(reference, outcome) {
    const t = this.mockTransactions.get(reference);
    if (!t) return false;
    if (outcome === 'success') Object.assign(t, { status: 'success', gateway_response: 'Approved', paid_at: new Date().toISOString() });
    else Object.assign(t, { status: 'failed', gateway_response: 'Declined: insufficient funds' });
    return true;
  }
}
