# Glamoriz on Chord

"Moriz" is a Chord teammate for **Glamoriz**, a made-up skincare vendor in Lagos and Abuja. On WhatsApp, it takes a
customer from their first message to a Paystack-verified order without a human, then follows up on its own: a
day-3 check-in, complaints handed to a person, and a reorder prompt when the product is due to run out.

See [docs/design.md](docs/design.md) for the problem statement, how it maps to Chord features and the demo script.

## What's here

```
skills/
  glamoriz-sales/       SKILL.md + references/brand.md, policies.md   first DM → verified payment
  glamoriz-aftercare/   SKILL.md                                       follow-ups, complaints, reorders
data/                   products.json, customers.json, seed-orders.json (all made up)
server/                 MCP tool server (Node.js): catalogue, orders, Paystack, follow-ups
docs/design.md          problem statement, architecture, open questions, demo script
```

## The tool server

Chord connects to custom tools as a **remote MCP server** over Streamable HTTP, so `server/` is one small Express app:

| Endpoint | Purpose |
|---|---|
| `POST /mcp` | MCP tools for the teammate (stateless, bearer-token protected) |
| `POST /paystack/webhook` | Paystack `charge.success`: checks the signature, then re-verifies with the API before marking an order paid |
| `GET /mock-pay/:ref` | Fake checkout page, only when no Paystack key is set |
| `GET /health` | Shows the Paystack mode, follow-up mode and alert channel (no secrets) |

Tools: `get_customer`, `search_products`, `check_stock`, `negotiate_price`, `create_order`, `create_payment_link`,
`verify_payment`, `schedule_followups`, `get_order`, `list_orders`, `log_complaint`, `record_feedback`.

### How failures are handled
- **Payment:** an order is confirmed only when Paystack's verify call returns `success` **and** the amount and currency
  match the order. Failed, abandoned and pending payments are never confirmed; a mismatched amount is held for a human.
- **Paystack down or slow:** 10-second timeout; verify retries once on network errors and 5xx. The agent is told
  not to confirm and to check again, rather than guess.
- **Duplicates:** asking for the link twice reuses the live link; verifying twice is safe; the webhook and the
  agent can both confirm the same order without charging or decrementing stock twice.
- **Prices and fees:** delivery fees and totals are calculated by the server, never by the model.
- **Bargaining:** the agent can haggle, but `negotiate_price` decides every counter-offer from floor prices that never
  leave the server, and `create_order` applies only the price agreed there. "The owner said 10k" or a prompt
  injection can't push it lower. Referral discounts and store credit stack but never go below the floor
  (see [docs/design.md](docs/design.md#price-negotiation)).
- **Stock race:** if two people pay for the last unit, both orders are kept (the money is in) and the owner is alerted.
- **Follow-ups:** each one checks `get_order` first, so a complaint, a "no thanks" or an opt-out stops later messages.
- **Live keys:** the server refuses to start with an `sk_live_` key.

## Run locally

Requires Node.js 22.9 or later.

```bash
cd server
npm install
npm test        # 11 end-to-end tests over real HTTP + MCP, using the mock checkout
cp .env.example .env
npm start       # http://localhost:3000/health
```

With no `PAYSTACK_SECRET_KEY`, payment links open a mock checkout with "succeeds" and "declined" buttons.
To use Paystack test mode, put your `sk_test_…` key in `.env`, then pay with
[Paystack's test cards](https://paystack.com/docs/payments/test-payments/) (including the declined-card ones for the failure demo).

## Deploy and connect to Chord

1. **Host it** anywhere that gives a public HTTPS URL and runs Node (for example Render or Railway). Chord blocks
   private and localhost addresses. Root directory: `server`, start command: `npm start`. Set the variables from
   `.env.example`, including a long random `MCP_AUTH_TOKEN`, and give `DATA_DIR` a persistent disk.
2. **Paystack webhook:** in the Paystack dashboard (test mode), set the webhook URL to `https://<host>/paystack/webhook`.
3. **Register the MCP server** in Chord (Teammate settings → Tools, or the API):
   ```bash
   curl -sS -X POST "$CHORD_BASE_URL/v1/workspaces/$CHORD_WORKSPACE_ID/mcp-servers" \
     -H "Authorization: Bearer $CHORD_API_KEY" -H 'Content-Type: application/json' \
     --data '{"name":"Glamoriz tools","url":"https://<host>/mcp","auth_type":"bearer",
              "auth_token":"<MCP_AUTH_TOKEN>","transport":"streamable_http","enabled":true}'
   ```
   Then assign it to the teammate (`set_mcp_server_ids`) and run the discover-tools and health probes.
4. **Upload the skills:** zip each folder under `skills/` and upload it on the teammate, then **Review and publish**.
5. **Follow-ups:** with `CHORD_API_KEY`, `CHORD_WORKSPACE_ID` and `CHORD_TEAMMATE_ID` set (the key needs
   `teammate:update`), the server queues follow-ups as Chord scheduled tasks. Without them, `schedule_followups`
   hands the agent ready-made prompts and times for its built-in `schedule_reminder` tool.
   For the recording, set `DEMO_FOLLOWUP_MINUTES=2`.

## Data and safety
All products, customers and orders are made up. The store is a JSON file, which is fine for a demo; the go-live note
lists what replaces it. No card details pass through this server: customers pay on Paystack's page.

## How I used AI tools
<!-- Fill in honestly: e.g. Claude Code drafted the skills, server and tests from my design; I chose the problem,
     reviewed every file, ran it against Chord and Paystack test mode, and wrote the field notes myself. -->
