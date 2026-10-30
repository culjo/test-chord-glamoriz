# Glamoriz on Chord

"Moriz" is a Chord teammate for **Glamoriz**, a made-up skincare vendor in Lagos and Abuja. On WhatsApp, it takes a
customer from their first message to a Paystack-verified order without a human, then follows up on its own: a
day-3 check-in, complaints handed to a person, and a reorder prompt when the product is due to run out.

See [docs/design.md](docs/design.md) for the problem statement, how it maps to Chord features, price negotiation
and the demo script.

## What's here

```
skills/
  glamoriz-sales/       SKILL.md + references/brand.md, policies.md   first DM → verified payment
  glamoriz-aftercare/   SKILL.md                                       follow-ups, complaints, reorders
server/                 MCP tool server (Node.js): catalogue, pricing, orders, Paystack, follow-ups
  chord.http            Chord API requests (VS Code REST Client): find IDs, register the server, test tools
data/                   products.json, customers.json, seed-orders.json (all made up)
docs/design.md          problem statement, architecture, open questions, demo script
Dockerfile, docker-compose.yml, .github/workflows/deploy.yml   VPS deployment
TODO.md                 open items
```

## Run locally

Requires Node.js 22.9 or later.

```bash
cd server
npm install
npm test        # end-to-end tests over real HTTP and MCP, using the mock checkout
cp .env.example .env
npm start       # http://localhost:3000/health
```

With no `PAYSTACK_SECRET_KEY`, payment links open a mock checkout with "succeeds" and "declined" buttons.
To use Paystack test mode, put your `sk_test_…` key in `.env`, then pay with
[Paystack's test cards](https://paystack.com/docs/payments/test-payments/), including the declined ones for the
failure demo.

To run the Docker image instead: `APP_ENV_FILE=server/.env docker compose up --build`, then open
`http://127.0.0.1:3013/health`.

## The tool server

Chord connects to custom tools as a **remote MCP server** over Streamable HTTP, so `server/` is one small Express app:

| Endpoint | Purpose |
|---|---|
| `POST /mcp` | MCP tools for the teammate (stateless, bearer-token protected) |
| `POST /paystack/webhook` | Paystack `charge.success`: checks the signature, then re-verifies with the API before marking an order paid |
| `GET /mock-pay/:ref` | Fake checkout page, only when no Paystack key is set |
| `GET /health` | Paystack mode, follow-up mode, VAT rate, reply format and alert channel (no secrets) |

Tools: `get_customer`, `save_customer_details`, `search_products`, `check_stock`, `negotiate_price`, `quote_cart`,
`create_order`, `create_payment_link`, `verify_payment`, `schedule_followups`, `get_order`, `list_orders`,
`log_complaint`, `record_feedback`.

### Prices and replies
The model handles the conversation; the server decides every number.
- **Totals:** prices, delivery fees, discounts and totals come from the server, never from the model.
- **VAT:** prices and delivery fees include 7.5% VAT (`VAT_RATE`). `quote_cart` and `create_order` show the VAT
  portion, worked out after discounts and rounded to the kobo; the total and the Paystack amount don't change.
- **Bargaining:** `negotiate_price` decides every counter-offer from floor prices that never leave the server, and
  `create_order` applies only the price agreed there, so "the owner said 10k" or a prompt injection can't push it
  lower. Each pushback brings a smaller step down until the floor. Referral discounts and store credit stack but
  never go below the floor (see [docs/design.md](docs/design.md#price-negotiation)).
- **Reply formatting:** the WhatsApp simulator shows Markdown symbols as they are, so the agent writes plain text by
  default. `get_customer` and `get_order` return a `reply_format` (`plain`, `whatsapp`, `markdown` or `html`) with
  rules the skills follow. Change it with `REPLY_FORMAT`, or per channel with `REPLY_FORMAT_BY_CHANNEL`, without
  re-uploading the skills.

### How failures are handled
- **Payment:** an order is confirmed only when Paystack's verify call returns `success` **and** the amount and currency
  match the order. Failed, abandoned and pending payments are never confirmed; a mismatched amount is held for a human.
- **Payment links:** the agent sends only the `payment_url` that `create_payment_link` returns, and never writes one.
- **Paystack down or slow:** 10-second timeout; verify retries once on network errors and 5xx. The agent is told
  not to confirm and to check again, rather than guess.
- **Duplicates:** asking for the link twice reuses the live link; verifying twice is safe; the webhook and the
  agent can both confirm the same order without charging or decrementing stock twice.
- **Stock race:** if two people pay for the last unit, both orders are kept (the money is in) and the owner is alerted.
- **Follow-ups:** each one checks `get_order` first, so a complaint, a "no thanks" or an opt-out stops later messages.
- **Live keys:** the server refuses to start with an `sk_live_` key.
- **Logs:** failed `create_order` and `create_payment_link` calls, Paystack errors and every payment link created
  are written to the console (`docker compose logs tools` on the VPS).

## Deploy and connect to Chord

1. **Host it** on a public HTTPS URL; Chord blocks private and localhost addresses.
   - **Your own VPS (recommended):** [docker-compose.yml](docker-compose.yml) runs the server on `127.0.0.1:3013`
     (change it with `TOOLS_PORT`), and [.github/workflows/deploy.yml](.github/workflows/deploy.yml) tests, builds
     and deploys it on every push to `main` through a self-hosted GitHub runner on the VPS. One-time setup:
     - Install Docker, and add a self-hosted runner (Settings → Actions → Runners) with the label `glamoriz-vps`,
       running as a user in the `docker` group who can write to `/opt/glamoriz`.
     - Put the app's `.env` in `/opt/glamoriz/.env`, or paste it into an `APP_ENV` Actions secret.
     - Point your hostname at the VPS and add a site block to the VPS's Caddy, which handles HTTPS, then reload
       Caddy once (`sudo systemctl reload caddy`):
       ```
       tools.yourdomain.com {
       	reverse_proxy 127.0.0.1:3013
       }
       ```
     The workflow never runs on pull requests, so code from forks can't reach the runner.
   - **Or a Node host** such as Render or Railway: root directory `server`, start command `npm start`.

   Either way, set the variables from [server/.env.example](server/.env.example), including a long random
   `MCP_AUTH_TOKEN`, and keep the data on persistent storage (`DATA_DIR`; Docker uses a volume).
2. **Paystack webhook:** in the Paystack dashboard (test mode), set the webhook URL to `https://<host>/paystack/webhook`.
3. **Register the MCP server** in Chord (Teammate settings → Tools, or the API):
   ```bash
   curl -sS -X POST "$CHORD_BASE_URL/v1/workspaces/$CHORD_WORKSPACE_ID/mcp-servers" \
     -H "Authorization: Bearer $CHORD_API_KEY" -H 'Content-Type: application/json' \
     --data '{"name":"Glamoriz tools","url":"https://<host>/mcp","auth_type":"bearer",
              "auth_token":"<MCP_AUTH_TOKEN>","transport":"streamable_http","enabled":true}'
   ```
   Then assign it to the teammate (`set_mcp_server_ids`) and run the discover-tools and health probes.
   [server/chord.http](server/chord.http) has these requests, plus `GET /v1/teammates` to find the workspace and
   teammate IDs.
4. **Upload the skills:** zip each folder under `skills/`, upload it on the teammate, then **Review and publish**.
   Re-upload after every skill change.
5. **Follow-ups:** with `CHORD_API_KEY`, `CHORD_WORKSPACE_ID` and `CHORD_TEAMMATE_ID` set (the key needs
   `teammate:update`), the server queues follow-ups as Chord scheduled tasks. Without them, `schedule_followups`
   hands the agent ready-made prompts and times for its built-in `schedule_reminder` tool.
   For the recording, set `DEMO_FOLLOWUP_MINUTES=2`.

## Test data
All products, customers and orders are made up.

The catalogue ([data/products.json](data/products.json)) has 22 products across 11 categories: cleansers, toners,
serums, a spot treatment, an eye cream, a mask, moisturisers, sunscreens, a body lotion, a lip balm and two routine
sets. The salicylic serum and the tinted sunscreen are out of stock on purpose, to test alternatives.

Five test customers ([data/customers.json](data/customers.json)) cover the main cases. Use their numbers as the
WhatsApp sender, or as `sender_id` in [server/chord.http](server/chord.http):

| Customer | Number | Addressed as | What it tests |
|---|---|---|---|
| Ada Obi, Lekki | 2348030000001 | Ada | Returning customer; serum bought 26 days ago, so a reorder is due; referral code `ADA2K` |
| Zainab Musa, Wuse | 2348090000002 | Madam Zainab | Pregnant: retinol and salicylic must be excluded; no orders yet |
| Tunde Bakare, Ikeja | 2348050000003 | Sir | ₦2,000 store credit to use; last order 40 days ago |
| Chiamaka Eze, Gwarinpa | 2347060000004 | Aunty Chi | Paid 3 days ago: the day-3 check-in; sensitive skin |
| Funmilayo Adeyemi, Ikorodu | 2348160000005 | Ma | Opted out: no follow-ups may be sent |

Any other number is a new customer. The simulator doesn't pass the sender's number to the agent, so give one of
these numbers when Moriz asks for it at checkout (see [TODO.md](TODO.md)).

Seeding only adds what's missing, so a running store picks up new products and customers without losing its stock
levels or changes. The store is a JSON file, which is fine for a demo; the go-live note lists what replaces it.
No card details pass through this server: customers pay on Paystack's page.

## How I used AI tools
I used AI tools to:
1. Bootstrap the codebase.
2. Summarise the Chord documentation.
3. Write the tests and test scenarios.
4. Simulate customer conversations locally.
5. Generate a suitable product range for a beauty store.
6. Debug problems.
