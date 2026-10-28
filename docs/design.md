# Glamoriz agent: problem statement and design

## Problem statement (for the top of the submission)

**Roles:** Technical Product Lead / Lead Engineer.

Glamoriz is a skincare vendor in Lagos and Abuja that sells almost entirely through WhatsApp, where customers
wait hours for a human to reply and many drop off before paying, especially in the evening and at weekends.
"Moriz", a Chord teammate, replies instantly, recommends products from live stock, takes and verifies payment
through Paystack, then follows up on its own: it checks in three days after delivery, hands complaints to a
human, and prompts a reorder when the product is due to run out. Every unanswered DM is a lost sale and every
repeat order costs nothing to acquire, so the business pays for faster first sales and a higher reorder rate.
I deliberately left out ad integration, delivery logistics, multi-city stock and refunds: a human approves every
refund, and complaints always reach a person.

**Measures of success:** first reply time (hours down to seconds), DM-to-paid conversion,
sales made outside 9am–6pm, and the 30-day repeat purchase rate.

## How it maps to Chord

| Need | Chord feature | Notes from the docs |
|---|---|---|
| Brand, sales and aftercare rules | Skills: `glamoriz-sales`, `glamoriz-aftercare` | SKILL.md plus `references/`; entrypoints share a 64,000-character budget |
| Catalogue, orders, Paystack | Remote MCP server (our code) | Streamable HTTP at a public HTTPS URL, bearer auth; private addresses are blocked |
| Recognise returning customers | Memory plus our `get_customer` tool | Memory is per customer; the teammate writes its own memories |
| Day-3 check-in and reorder nudge | Scheduled tasks: `REPORT` with `platform: WHATSAPP` and `conversation_id` | Runs the full agent with tools later and delivers into the chat. A built-in `schedule_reminder` tool also exists |
| Complaints and reactions | Built-in `handover_to_human` plus escalation triggers | The thread moves to `human_active`; owner alerted by the `conversation.escalated` webhook or email. Stored escalation rules ship off |
| Paystack confirms payment without the customer asking | Event subscriptions (stretch goal) | Paystack webhook → our server → signed Chord event → agent run. It has no thread, so it can't message the customer directly |

## MCP tools (our server)

| Tool | Backed by | Failure handling |
|---|---|---|
| `get_customer(phone)` | Store (JSON or SQLite) | Unknown number → `{found: false}`, never an error |
| `save_customer_details(phone, name?, address_as?)` | Store | Saves how the customer likes to be addressed (Ma, Sir, Aunty Ada, a first name); returned by `get_customer` and `get_order` |
| `search_products(concern, skin_type?, max_price?)` | `data/products.json` | No match → empty list plus a suggestion to ask a different question |
| `check_stock(sku)` | Store | Out of stock → `{in_stock: false, alternatives: [...]}` |
| `negotiate_price(phone, sku, qty?, offer_ngn?)` | Store, using floor prices that only the server knows | Accepts a fair offer as-is, otherwise counters in up to 3 steps; first-time buyers stop above the floor; a final offer comes with alternatives |
| `quote_cart(items, phone?, referral_code?, city?, area?)` | Store | Running total once the customer has picked products, before the address; adds delivery when the area is known; same pricing code as `create_order`, so the quote matches the charge |
| `create_order(phone, items, city, area, address, referral_code?)` | Store | Rejects unknown SKU, zero stock or an unknown city; applies the agreed price, referral and credit without going below the floor; calculates the delivery fee on the server, not the model |
| `create_payment_link(order_id)` | Paystack `POST /transaction/initialize` (test key) | Paystack error or timeout → `{ok: false, reason}`; reuses an existing pending link (idempotent) |
| `verify_payment(order_id)` | Paystack `GET /transaction/verify/:reference` | Maps to `success`, `pending`, `abandoned` or `failed` and checks that the amount and currency match the order |
| `schedule_followups(order_id)` | Chord `POST /v1/scheduled-tasks` | Only for paid orders; doesn't schedule twice; demo mode compresses days into minutes |
| `get_order(order_id)` | Store | Used by follow-ups to stop stale or duplicate messages |
| `log_complaint(order_id, type, details)` | Store plus an owner alert (webhook or email) | Returns a ticket ID to quote to the customer |
| `record_feedback(order_id, sentiment, text, opt_out?)` | Store | An opt-out suppresses all future follow-ups |

## Price negotiation
Nigerian customers expect to bargain ("last price?"). A sales agent that can't bargain sends them to a human, which is
the delay we're removing; one that bargains on its own judgement can be talked into anything. So the model handles
the conversation and the server decides the price:
- Each product has `floor_price_ngn` in the catalogue. No tool ever returns it.
- `negotiate_price` takes the customer's offer. If it's at or above the next step, the server accepts it as-is
  (it never goes lower than the customer asked). Otherwise it counters, moving 30%, 55%, then 80% of the way from the
  list price to the floor for a first-time buyer, or 40%, 70% and 100% for a returning customer or 3+ units.
  Prices round up to the nearest ₦100, and the last step is final.
- An agreed price is stored on the server for 24 hours under a `deal_id`; `quote_cart` and `create_order` apply it,
  so the model can't quote one price and charge another. It only applies to the quantity agreed.
- Bargaining doesn't need the customer's phone number (the WhatsApp simulator doesn't show it to the agent). Without
  one, first-time prices apply and the `deal_id` carries the price to the order, which then ties the deal to the
  customer's number. A returning customer's better prices apply once the number is known. See [TODO.md](../TODO.md).
- At the final step the agent gets non-price alternatives: free delivery from ₦50,000, store credit, a referral code
  or buying 3+ units.
- Referral: a friend's code gives ₦2,000 off a first order. When that order is paid, the code's owner gets ₦2,000
  store credit, used automatically on their next order. That closes the loop the day-3 check-in starts.
- Stacking rule: negotiated price, referral and credit can combine, but never take an order below the sum of its
  floor prices. Unused credit is kept.
- `create_order` also returns a free-delivery hint when the customer is within ₦15,000 of the threshold, as a way
  to grow the basket instead of cutting the price.
- VAT (7.5%, `VAT_RATE`) is inside every price, as customers expect from an advertised price. Quotes and orders
  show the VAT portion of what's actually paid (after discounts, including delivery); nothing is added on top.
- Every order records `list_subtotal_ngn` and a `discounts` breakdown, so the owner can see what bargaining costs.

## Open questions for TSG Labs (ask on day one)
1. Can an MCP tool call find out which thread or conversation it was called from (to get the `conversation_id`
   for scheduled tasks, and the sender's phone number)? If not, does the agent need to call `schedule_reminder`
   itself? The simulator currently shows the agent only the sender's name.
2. Does the WhatsApp simulator accept agent-initiated (scheduled) messages, and does it apply WhatsApp's
   24-hour window or template rules?
3. Which keys and scopes does the exercise account get (for example `teammate:update` for scheduled tasks
   and the MCP permissions)?
4. Is Memory enabled on the exercise tenant, or will we get `403 FEATURE_DISABLED`?

## Demo script (3 minutes)
1. A new customer asks about dark spots → two recommendations → the out-of-stock salicylic serum gets swapped
   for an alternative.
2. Order → Paystack test link → paid with a test card → "I've paid" → verified → order number.
3. A second attempt with Paystack's failing test card → the agent refuses to confirm and offers a fresh link.
4. The day-3 follow-up fires (compressed to about 2 minutes) → the customer reports a reaction → a complaint is
   logged and handed to a human.
5. The customer returns → recognised by name and last purchase → reorder in one tap.
