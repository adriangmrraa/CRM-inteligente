/* eslint-disable @typescript-eslint/no-require-imports -- modules must load after the @/db hook */
/**
 * HTTP-level coverage for POST /api/webhooks/ingress/<provider> (M6).
 *
 * Exercises the whole route: unknown provider, signature reject, signed
 * non-WhatsApp message → passive persistence, signed lifecycle event →
 * channel_accounts.status flip, and the fail-closed skip when no account
 * row matches. FakeDb stands in for Postgres; the provider secret comes
 * from env through the integration-secret chain.
 */

import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { afterEach, beforeEach, describe, it } from "node:test";
import { NextRequest } from "next/server";

import { channelAccounts } from "@/db/schema";
import { FakeDb, installFakeDb } from "@/lib/messaging/test-support/fake-db";

const fake = new FakeDb();
installFakeDb(fake);

const { POST } =
  require("./route") as typeof import("./route");

const SECRET = "zernio_route_test_secret";

function sign(body: string, secret = SECRET): string {
  return createHmac("sha256", secret).update(body).digest("hex");
}

function post(body: string, provider = "zernio", headers: Record<string, string> = {}) {
  return POST(
    new NextRequest("https://example.test/api/webhooks/ingress/zernio", {
      method: "POST",
      body,
      headers,
    }),
    { params: Promise.resolve({ provider }) }
  );
}

let previousSecret: string | undefined;
let previousApiKey: string | undefined;
let previousZtestApiKey: string | undefined;

beforeEach(() => {
  previousSecret = process.env.ZERNIO_WEBHOOK_SECRET;
  previousApiKey = process.env.ZERNIO_API_KEY;
  previousZtestApiKey = process.env.ZTEST_API_KEY;
  process.env.ZERNIO_WEBHOOK_SECRET = SECRET;
  process.env.ZTEST_API_KEY = "ztest_api_key_fixture";
  delete process.env.ZERNIO_API_KEY;
  for (const table of [
    "channel_accounts",
    "channel_events",
    "conversations",
    "chat_messages",
    "lead_identities",
    "leads",
  ]) {
    fake.rows(table).length = 0;
  }
});

afterEach(() => {
  if (previousSecret === undefined) delete process.env.ZERNIO_WEBHOOK_SECRET;
  else process.env.ZERNIO_WEBHOOK_SECRET = previousSecret;
  if (previousApiKey === undefined) delete process.env.ZERNIO_API_KEY;
  else process.env.ZERNIO_API_KEY = previousApiKey;
  if (previousZtestApiKey === undefined) delete process.env.ZTEST_API_KEY;
  else process.env.ZTEST_API_KEY = previousZtestApiKey;
});

function instagramMessage(id: string): string {
  return JSON.stringify({
    event: "message.received",
    account: { accountId: "acct_ig1" },
    conversation: { id: `conv-${id}` },
    message: {
      id,
      platformMessageId: id,
      platform: "instagram",
      text: "hello over the wire",
      sender: { id: "ig_user_1", name: "IG User" },
      sentAt: "2026-01-01T00:00:00Z",
    },
  });
}

describe("POST /api/webhooks/ingress/zernio (HTTP level)", () => {
  it("returns 404 for an unregistered provider", async () => {
    const res = await post("{}", "nope");
    assert.equal(res.status, 404);
  });

  it("rejects a missing signature with 401", async () => {
    const res = await post("{}");
    assert.equal(res.status, 401);
  });

  it("rejects a tampered body with 401", async () => {
    const body = instagramMessage("tampered_msg");
    const res = await post(body, "zernio", {
      "x-zernio-signature": sign(body + "tampered"),
    });
    assert.equal(res.status, 401);
  });

  it("persists a signed non-WhatsApp message passively and returns 200", async () => {
    fake.seed(channelAccounts, [
      {
        id: 11,
        provider: "zernio",
        channel: "instagram",
        providerAccountId: "acct_ig1",
        credentialsRef: "env:ZTEST_",
        status: "active",
      },
    ]);
    const body = instagramMessage("msg_http_1");
    const res = await post(body, "zernio", {
      "x-zernio-signature": sign(body),
      "x-zernio-event-id": "evt_http_1",
    });
    assert.equal(res.status, 200);
    const payload = (await res.json()) as { ok: boolean; processed: number };
    assert.equal(payload.ok, true);
    assert.equal(payload.processed, 1);
    const messages = fake.rows("chat_messages");
    assert.equal(messages.length, 1);
    assert.equal(messages[0].platformMessageId, "msg_http_1");
    const events = fake.rows("channel_events");
    assert.equal(events[0]?.kind, "message.received");
  });

  it("flips channel_accounts.status on a signed account.disconnected event", async () => {
    fake.seed(channelAccounts, [
      {
        id: 12,
        provider: "zernio",
        channel: "instagram",
        providerAccountId: "acct_ig2",
        credentialsRef: "env:ZTEST_",
        status: "active",
      },
    ]);
    const body = JSON.stringify({
      event: "account.disconnected",
      data: { reason: "route-level" },
      account: { accountId: "acct_ig2", platform: "instagram" },
    });
    const res = await post(body, "zernio", {
      "x-zernio-signature": sign(body),
      "x-zernio-event-id": "evt_http_lifecycle",
    });
    assert.equal(res.status, 200);
    assert.equal(fake.rows("channel_accounts")[0]?.status, "disconnected");
    assert.equal(fake.rows("channel_events")[0]?.kind, "account.lifecycle");
  });

  it("acks a signed delivery without processing when the account cannot be resolved", async () => {
    fake.seed(channelAccounts, []);
    const body = instagramMessage("msg_http_orphan");
    const res = await post(body, "zernio", {
      "x-zernio-signature": sign(body),
    });
    assert.equal(res.status, 200);
    const payload = (await res.json()) as { processed: number };
    assert.equal(payload.processed, 0);
    assert.equal(fake.rows("chat_messages").length, 0);
  });
});
