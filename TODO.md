# To do

## Revisit how the agent gets the customer's phone number
**Why:** in the Chord WhatsApp simulator, the agent only sees the sender's display name, not their WhatsApp number.
Several tools key customers by phone (`get_customer`, `create_order`, follow-ups), so the agent had to ask for the
number, even in the middle of bargaining.

**What we did for now:**
- `get_customer` works without a phone and returns `phone_known: false`; the skill treats the customer as new and
  asks for the number only at checkout.
- `negotiate_price` works without a phone: it returns a `deal_id` that the agent passes to `quote_cart` and
  `create_order`, and the deal is tied to the number once the order is created
  (`TODO(simulator-phone)` in [server/src/pricing.js](server/src/pricing.js)).

**To check:**
- [ ] How does the simulator, and the real WhatsApp channel, pass the sender to the agent? Is the number in the
      conversation context, a thread or contact field, or a Chord API we can call? Ask TSG if the docs don't say.
- [ ] Can an MCP tool call receive the sender or thread id directly (this is also open question 1 in
      [docs/design.md](docs/design.md))? If so, the server could look the customer up without relying on the model.
- [ ] If the number is reliably available, update the sales skill to always pass it, drop the "ask at checkout"
      fallback, and decide whether `deal_id` is still needed or can stay as a backup.
- [ ] Record what we find in the field notes.
