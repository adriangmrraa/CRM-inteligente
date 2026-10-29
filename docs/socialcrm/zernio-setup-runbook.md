# Zernio Setup Runbook

Attendee-first guide to wiring **Zernio** — the unified provider for
Instagram DMs, Facebook Messenger, LinkedIn, TikTok, YouTube, Threads,
Pinterest, Discord, Slack, and an optional WhatsApp path — into a SocialCRM
instance on Render + Neon.

Prerequisite: a deployed SocialCRM instance with a public HTTPS URL
(`https://<app>.onrender.com`) — the base install is
[implementer-onboarding.md](./implementer-onboarding.md). Zernio callbacks and
webhooks cannot be verified on `localhost`; do this step after the Render
service is live.

> **Honest capability scope (read first):**
>
> - **WhatsApp (via Zernio)** inbound messages run the full AI agent pipeline,
>   same as YCloud WhatsApp.
> - **Every other Zernio channel** is a *passive inbox* today: inbound
>   messages, echoes and comments persist into `/admin/conversations` bound to
>   the correct account, and **operator replies from the conversation view do
>   send** through the connected account — but there is **no AI auto-reply**
>   and no first-contact conversation open on those channels. The agent layer
>   stays WhatsApp-bound until it is provider-generalized (roadmap S15).
> - Outbound **document/file sends are not implemented** for Zernio accounts
>   (text, image, template and interactive replies only).
> - `metadata.standby` messages (another app controlling the conversation)
>   are persisted but the agent stays silent — the inbox never fights a
>   foreign pipeline.

## The two setup modes

| | A. Embedded connect ("Conexión rápida") | B. Manual account |
|---|---|---|
| Who | One-click OAuth / Embedded Signup from `/admin/channels` | You already have the Zernio `accountId` |
| Credentials | `ZERNIO_API_KEY` env var (or the scoped Zernio credential in `/admin/agent` → Integraciones) | Same — referenced per account via `credentialsRef` |
| Result | `channel_accounts` row upserted automatically | You create the row by hand |
| Best for | Workshops, first-time wiring | Pre-provisioned accounts, multiple profiles |

Both modes end in the same place: an active `channel_accounts` row plus the
ingress webhook registered in Zernio.

## Env contract

| Var | Required | Purpose |
|---|---|---|
| `ZERNIO_API_KEY` | one of env **or** scoped credential | Bearer for all Zernio API calls (connect, sends, webhook registration, account probes) |
| `ZERNIO_WEBHOOK_SECRET` | one of env **or** scoped credential | HMAC-SHA256 signature secret for `POST /api/webhooks/ingress/zernio` — you choose the value; the same string goes into Zernio webhook settings |
| `ZERNIO_PROFILE_ID` | optional | Pins the profile embedded connect uses; defaults to your first/default Zernio profile |

Scoped alternative (no env vars): per-account `credentialsRef = agent_config`
resolves `zernioApiKey` / `zernioWebhookSecret` from the agent_config chain —
per-account row → per-channel row → global row — settable from
`/admin/agent → Integraciones → Zernio`. The env vars are the last-resort
fallback in that chain too.

Per-account env refs also work: `credentialsRef = env:ZERNIO_MAIN_` resolves
`ZERNIO_MAIN_API_KEY` / `ZERNIO_MAIN_WEBHOOK_SECRET` — for a second Zernio
profile on one install.

## Mode A — Embedded connect

1. `/admin/channels → Conexión rápida con Zernio` → pick the platform.
   WhatsApp additionally offers two onboarding modes:
   - `api` — Cloud API Embedded Signup (new numbers or numbers already on
     Cloud API).
   - `business_app` — coexistence: keep the number live in the WhatsApp
     Business app while it also serves the API (Meta caps this at ~20 msg/s,
     no groups/calling).
2. The browser goes to Zernio/Meta, approves, and lands back on
   `/api/channels/zernio/callback?state=…&connected=…&accountId=…`.
3. The callback upserts the `channel_accounts` row
   (`provider=zernio`, `channel=<platform>`, `providerAccountId=<accountId>`,
   `credentialsRef=env:ZERNIO_` when the env key exists, else the scoped
   `agent_config` ref) and flashes `connected` on `/admin/channels`.

Connectable platforms today: whatsapp, instagram, facebook, linkedin, tiktok,
youtube, threads, pinterest, discord, slack. Telegram/SMS/reddit are manual —
Telegram connects by bot token (no OAuth), reddit is upstream-disabled.

CSRF: a one-shot httpOnly cookie per platform carries a random `state` nonce
through the roundtrip; mismatched or missing state fails closed with
`error=oauth-state` — just restart the connect.

## Mode B — Manual account

1. Zernio dashboard → copy the connected account's **`accountId`** (and the
   profile it belongs to). This is the routing key — without it ingress
   cannot bind events to your row.
2. `/admin/channels → Nueva cuenta`:
   - `provider`: `zernio`
   - `channel`: the platform (`instagram`, `facebook`, `whatsapp`, …)
   - `providerAccountId`: the `accountId` from step 1
   - `senderAddress`: display handle/phone for the inbox (e.g. `@mybrand` or
     the WhatsApp E.164 digits)
   - `credentialsRef`: `env:ZERNIO_` (env mode) or `agent_config` (scoped mode)
3. Register the webhook (below) pointing at your public ingress URL.

## Webhook registration

The ingress endpoint is **`POST https://<app>.onrender.com/api/webhooks/ingress/zernio`**
— shown verbatim on `/admin/channels`.

- **One click:** `/admin/channels → Registrar en Zernio` posts the URL, your
  `ZERNIO_WEBHOOK_SECRET`, and the consumed event set
  (`message.received|sent|delivered|read|failed`, `comment.received`,
  `conversation.started`, `account.connected|disconnected`) to
  `POST /v1/webhooks/settings`. Needs a public URL and a resolvable Zernio
  credential — it refuses to run against `localhost`.
- **Manual:** paste the same URL + secret in Zernio dashboard → webhook
  settings. The secret is whatever `ZERNIO_WEBHOOK_SECRET` (or the scoped
  credential) holds — HMAC over the raw body, `X-Zernio-Signature` header.

Events are deduplicated by `X-Zernio-Event-Id`/`payload.id` (synthetic-hash
fallback), so provider redelivery is safe.

## Lifecycle (connect / disconnect)

Zernio emits `account.connected` / `account.disconnected` events on the same
webhook. Ingress persists them to `channel_events` and updates the bound
`channel_accounts.status` (`active` ⇄ `disconnected`) so `/admin/channels`
reflects provider reality — a revoke in the Zernio dashboard turns the row
disconnected; a reconnect turns it back active. Unknown lifecycle verbs are
recorded but do not change status.

You can also toggle a row manually on `/admin/channels`. Disconnect does NOT
delete credentials or history — reconnecting resumes the same row.

## ⚠️ Mixed-provider WhatsApp

If **both** YCloud and Zernio WhatsApp accounts are active at once:

- Inbound events always resolve to the account that owns the provider routing
  key — no cross-talk.
- **Outbound replies on unbound legacy conversations become ambiguous**: the
  router refuses to guess between two active WhatsApp accounts and fails
  closed rather than sending through the wrong provider. Bind the
  conversation to an account (or disconnect one provider) to restore sends.
- `/admin/channels` warns when more than one WhatsApp account is active —
  treat it as a deliberate choice, not an accident.

## What needs a public URL (and what doesn't)

| Works locally | Requires the deployed HTTPS URL |
|---|---|
| Account rows, credentials, inbox persistence logic, signature verification tests | Embedded connect roundtrip (Zernio must reach the callback) |
| Deterministic tests (`npm run test:agents`, `npm run test:workshop`) | Webhook registration + real event delivery |
| One labeled read/write smoke via curl/API | `Registrar en Zernio` button (refuses non-public bases) |

## Post-deploy smoke checklist

1. `GET https://<app>.onrender.com/api/health` → `200` `"db":"connected"`.
2. `/admin/channels` shows the account `active` with the right channel.
3. Webhook registered (button or manual) — Zernio dashboard shows the URL.
4. Send a real message on the connected channel → appears in
   `/admin/conversations` bound to the account (account column populated).
5. Reply from the conversation view → the reply is actually delivered.
6. `account.disconnected` test (disconnect in Zernio dashboard) → row flips
   to `disconnected`; reconnect flips it back.
7. Signature sanity: a tampered/forged POST to the ingress URL returns 401.

## Troubleshooting

| Symptom | Cause / fix |
|---|---|
| Connect button errors `Falta ZERNIO_API_KEY` | No env key and no scoped credential — set one (`/admin/agent → Integraciones` or env) |
| Connect lands on `/admin/channels?error=oauth-state` | Stale/expired state cookie — restart the connect; only one tab per platform at a time |
| Webhook registration refuses to run | No public URL — deploy first; `NEXT_PUBLIC_APP_URL`/`AUTH_URL`/`RENDER_EXTERNAL_URL` unset or localhost-only |
| Events never arrive | Webhook not registered in Zernio, or registered against a different URL — check Zernio webhook settings |
| Events arrive but are dropped (401 in logs) | `ZERNIO_WEBHOOK_SECRET` (env or scoped) ≠ the secret in Zernio webhook settings |
| Events ack 200 but nothing persists | `channel_accounts` row missing/mismatched `providerAccountId` — the row must carry the exact Zernio `accountId` |
| Send fails `TEMPLATE_REQUIRED` / `PLATFORM_NOT_SUPPORTED` | First contact constraints: WhatsApp conversation-open needs an approved template; IG/FB threads cannot be opened API-side — the customer must write first |
| Replies fail on a whatsapp conversation | Two active WhatsApp accounts and an unbound conversation — see "Mixed-provider WhatsApp" |
| Row shows `disconnected` unexpectedly | Zernio emitted `account.disconnected` (revoked/expired upstream) — reconnect the account in Zernio, the row follows |
