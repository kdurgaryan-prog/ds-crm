# DS Systems CRM

One place for DS Systems LLC to see every customer, answer every channel, run calls, quotes and orders, and supervise the two AI agents — **Natalie** (calls & messages) and **Arev** (marketing drafts).

Built only for DS Systems. Every record carries a business ID and the database itself (row-level security) keeps businesses apart, so a second business added later gets fully separate data, channels, logins and settings.

---

## What's inside

| Area | What it does |
|---|---|
| Dashboard | Today's unanswered messages, missed calls, callbacks, overdue tasks, quotes to finish, orders due this week. Every number opens the matching list. |
| Leads & Customers | Lead 1, Lead 2… numbering. Server-side search (name, company, phone, "lead 12"), filters (created, last activity, source, status, responsible, product, quantity, deadline), Clear filters, CSV import with preview, CSV export. Duplicate review: exact phone / channel-ID matches are joined automatically; same-name-different-phone goes to a review list, never merged on its own. |
| Customer card | One card per person across all channels, with a unified history (calls, SMS, WhatsApp, Messenger, Instagram, web chat, forms, quotes, orders, status changes, AI actions). Logo/design files, permissions (marketing texts, marketing calls, Do Not Call, restrictions). |
| Inbox | SMS/MMS, WhatsApp, Messenger, Instagram, website chat and website forms. Reply on the same channel, attach files, saved replies, AI suggested reply, AI on/off per conversation, transfer to a person, Open/Waiting/Done. A staff reply pauses Natalie until someone switches her back on. |
| Calls | Browser phone (Twilio Voice), history, missed calls, transcripts, AI summary, recordings (if turned on), outcome + next step + callback. |
| Pipeline | New → Contacted → Waiting → Qualified → Quote Sent → Won / Lost board. |
| Quotes | Price list with quantity tiers; only approved prices are usable. "Draft quote from price list" matches the customer's product, decoration and quantity — no invented numbers. Owner/Admin approves final prices. Printable quote / PDF. Approved quote → order in one click. |
| Orders | New → Awaiting Artwork → Awaiting Approval → Awaiting Payment → In Production → Quality Check → Ready → Delivered. Design versions with recorded customer approval, payment status, production notes, deadlines, tasks. |
| Marketing | Arev drafts posts, ads, image prompts, video scripts, content calendars, SMS/WhatsApp campaigns and call campaigns. Draft → Waiting for approval → Owner reviews final text, files, channels, audience and time → Start/Publish → Pause/Stop. Any edit after approval sends it back to draft. |
| Tasks & Calendar | Due today, overdue, callbacks; month calendar with tasks and order deadlines. |
| Reports | Leads by source with win rate, pipeline, industries, products, quote win rate, orders, calls, reply time, campaign results, agent activity. |
| AI Agents | One-click off switch for each agent, fine-grained switches, Arev's data scope, names (changed in one place), Natalie's actual rules, and a full log: which agent, based on what, what changed, whether approval was needed, result. |
| Settings | Quote links (with a live "does this link work" check), MOQ, campaign hours, call transfer number, recording, post-call text, channels with real status, website install code, team & roles, custom fields, personal look, saved replies, Do Not Call list, failed actions with retry, activity history, backups and export. |

Roles: **Owner** (everything incl. marketing approval, AI switches, backups), **Admin** (everything except those three), **Sales**, **Marketing**, **Viewer** (read-only).

## How Natalie's rules are enforced

1. Her instructions (see AI Agents → "See her rules"): AI disclosure, English by default, switch to Armenian/Russian/Spanish only on an explicit request, never prices, never invented stock/timelines/actions, no email collection, MOQ 20 with handoff, design help without promises, the fixed outbound opener and 5-question order.
2. **Code checks every reply before it's sent** — anything that looks like a price, a "your order was sent/booked" claim, or an email request is replaced with a safe answer and logged as "stopped by rules".
3. Customer messages are passed to the model only as quoted data, and her tools can only update this one customer's order details, hand off, switch language or request design help. A customer message cannot change her rules, settings or permissions.
4. Below-MOQ quantities automatically create a review task. Handoffs pause AI on that conversation.
5. Calls use Twilio ConversationRelay with low interruption sensitivity and ignored back-channel ("uh-huh") so noise doesn't cut her off, real speech does. Silence: she checks once, then ends politely and creates a callback task. If the AI connection fails mid-call, or the caller asks for a person (or presses 0), the call is transferred to staff.

## Messaging safety

- STOP / UNSUBSCRIBE / "stop texting me" etc. opt the person out, cancel pending marketing to them and pause AI. START opts back in.
- Marketing requires consent on file (SMS) or written consent (AI calls), skips Do Not Call numbers, and only runs within campaign hours (default 09:00–17:00 Los Angeles, Mon–Fri) **and** the recipient's local hours (unknown time zone → only times that are business hours across all US zones).
- WhatsApp/Messenger/Instagram 24-hour reply windows are enforced.
- Every outgoing message has an idempotency key; a message is marked "sending" before the provider call, so a crash can never cause a silent double send — it shows "Status unknown — check before resending" instead.
- Delivery status comes only from the provider (Twilio status callbacks). Nothing is shown as sent unless the provider accepted it.
- Webhooks are signature-checked (Twilio `X-Twilio-Signature`, Meta `X-Hub-Signature-256`) and de-duplicated by provider message ID.
- Failed automatic work retries with backoff, then lands in Settings → Failed actions.

---

## Install on Render (recommended — no server to manage)

1. Put this code in a **private** GitHub repository.
2. Render dashboard → **New → Blueprint** → choose the repository. `render.yaml` creates:
   `dscrm-staging` and `dscrm-production` (web services, Oregon), each with its **own** database and file disk.
   Enter `PUBLIC_URL` and `ANTHROPIC_API_KEY` when asked (you can add the AI key later).
3. When staging is live, open its **Shell** tab and run:
   `node server/scripts/seed-test.js` (test data) — or for a real login: `node server/scripts/bootstrap.js --email you@… --name "Your Name"`.
4. Add your domain: service → Settings → Custom Domains → `crm.dssuniforms.com` (and `staging-crm.dssuniforms.com`), then create the DNS record Render shows you (in Shopify: Settings → Domains → Manage → DNS).
5. Test everything on staging (it never sends real messages), then run `bootstrap.js` on production and connect the real channels there.

Notes: services must be on a paid instance (free ones sleep and miss calls). A service with a disk restarts briefly on each deploy, so deploy production outside business hours. Render backs up the managed database daily; the in-app "Back up now" button needs the `pg_dump` tool and may not be available on Render — use Render's database backups instead. The CRM refuses to start in production if its database user could bypass the per-business separation.

## Connect the existing "Get a Quote" form on dssuniforms.com

The theme's own script (`dss.js`) already copies each submission to the form's `data-webhook` address, while Shopify keeps emailing you as before. Set that address to:

`https://<your CRM address>/api/public/<website key>/shopify-quote`

(the website key is shown in Settings → Website). In Shopify: **Online Store → Themes → Customize → Get a Quote page** — if the quote section has a webhook field, paste it there. Otherwise **Edit code**, find the form with `data-dss-quote`, and add `data-webhook="…"` to it. Each request then appears in the CRM with products, print locations, quantity, decoration, date, budget, notes and ad source, plus a follow-up task.

## Install with Docker (your own server)

You need a Linux server with Docker, a domain (e.g. `crm.dssuniforms.com`) pointing at it, and HTTPS in front (Caddy, Nginx, or your host's load balancer). Twilio and Meta must reach the server over HTTPS, and Twilio calls need WebSocket (`wss://`) through the same proxy.

```bash
cp deploy/production.env.example deploy/production.env   # fill it in
export $(grep -E '^(DB_ADMIN_PASSWORD|APP_DB_PASSWORD)=' deploy/production.env | xargs)
ENV_FILE=deploy/production.env docker compose -p dscrm-prod --env-file deploy/production.env up -d --build
docker compose -p dscrm-prod exec app node server/scripts/bootstrap.js --email you@dssystems.com --name "Your Name"
```

The last command prints your temporary password and the **website key**. Sign in at your `PUBLIC_URL`, then change the password.

**Staging** is the same with `deploy/staging.env` and `-p dscrm-staging`. Staging never delivers anything (messages, calls and posts are stored as "test mode — not delivered"), and you can load separate test data with `node server/scripts/seed-test.js` (refuses to run in production).

### Connect the channels (Settings → Channels)

A channel shows **Connected** only after the provider confirms the credentials, so you'll see exactly which ones still need work.

1. **Twilio SMS/MMS + calls** — Account SID, Auth token, your Twilio number. In the Twilio console set the number's webhooks to the addresses shown at the bottom of Settings → Channels. For the browser phone also create an API key and a TwiML App (voice URL shown there). For US texting, finish **A2P 10DLC brand & campaign registration** in Twilio or carriers will block messages.
2. **WhatsApp** — the website's WhatsApp button uses +1 (747) 588-7117. To answer it inside the CRM, that number must be registered as a WhatsApp sender in Twilio (a number can't be in the WhatsApp Business app and the API at the same time); same "message comes in" webhook. Marketing on WhatsApp needs approved templates (enter the template SID on the campaign).
3. **Messenger & Instagram** — a Meta developer app (Messenger + Instagram messaging), Page ID / Instagram account ID, a long-lived Page access token, app secret and a verify token you choose. Webhook URL: `https://<your-domain>/webhooks/meta`. Publishing posts needs `pages_manage_posts` / `instagram_content_publish` and Meta app review.
4. **AI** — put `ANTHROPIC_API_KEY` in the env file and restart, then "Check connection".
5. **Website (Shopify)** — Settings → Website shows a one-line script for `theme.liquid` (chat bubble) and a snippet for a Custom Liquid section (quote form). Both land in the CRM. Add your exact site address(es) to `SITE_ORIGINS`.

### Backups

The `backup` service dumps the database every night at 03:15 and test-restores it into a scratch database; results appear in Settings → Backups & data ("Restore tested"). Copy `/app/data/backups` off the server (e.g. `rclone` to S3/B2) — a backup on the same disk doesn't protect against losing the server. Restore with `scripts/restore.sh` into an empty database.

---

## Develop and test

```bash
npm install && (cd web && npm install)
# Postgres 16 running locally; the app role must NOT be a superuser (row-level security)
export DATABASE_URL=postgres://dscrm:dscrm@localhost/dscrm_dev APP_ENCRYPTION_KEY=<64 hex chars>
node server/scripts/seed-test.js      # test data + logins (password: test-password-123)
npm run build:web && npm start        # http://localhost:8080
TEST_DATABASE_URL=postgres://dscrm:dscrm@localhost/dscrm_test npm test
```

Tests use their own database and a scripted AI model and fake providers — they never place real calls, send real messages or publish anything.

## Known limits
- Natalie's quote link is `https://dssuniforms.com/pages/get-a-quote` (checked: the page loads and has the quote form). The site has no separate contact page, so both links point there. After any site change, press "Check links now" in Settings → Business rules.
- Campaign hours are owner-adjustable (default 09:00–17:00 Los Angeles, Mon–Fri); the recipient's local-hours check always applies on top.
- Federal Do Not Call registry checks need a separate SAN subscription; this CRM keeps your own DNC list and per-customer consent.
- Armenian voice: Twilio's speech providers have limited Armenian support. Test a live call before relying on it; text channels work in all four languages.
- Recording calls in California requires everyone's consent; the announcement is played automatically when recording is on.
- Not legal advice: have your TCPA / A2P messaging setup reviewed, especially before AI outbound calling.
