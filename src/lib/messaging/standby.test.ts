/* eslint-disable @typescript-eslint/no-require-imports -- modules must load after the @/db hook */
/**
 * M3 — standby/handover gate (node:test, no real DB, no network).
 *
 * A message flagged `metadata.standby` means another app owns the thread.
 * It must persist to the inbox but never reach the reply machinery:
 * auto-reply, the durable turn job, the session transition, or the buffer.
 * Covers the pure classifier, the zernio normalizer's raw.standby stamp,
 * and the pipeline's suppression surfaces (source-scan, auto-reply.test.ts
 * style).
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

import type { NormalizedInboundEvent } from "./types";
import { FakeDb, installFakeDb } from "./test-support/fake-db";

const fake = new FakeDb();
installFakeDb(fake);

const { isStandbyInboundEvent } =
  require("./inbound-pipeline") as typeof import("./inbound-pipeline");
const { zernioProvider } =
  require("./providers/zernio") as typeof import("./providers/zernio");

function event(raw: unknown, kind = "message.received"): NormalizedInboundEvent {
  return {
    provider: "zernio",
    deliveryId: "evt_standby_test",
    kind: kind as NormalizedInboundEvent["kind"],
    direction: "inbound",
    providerAccountId: "acct_1",
    sender: { phone: "+15550000001" },
    type: "text",
    text: "hola",
    timestamp: new Date(0).toISOString(),
    raw,
  };
}

describe("M3 — isStandbyInboundEvent", () => {
  it("flags every known standby surface", () => {
    for (const raw of [
      { standby: true },
      { metadata: { standby: true } },
      { message: { metadata: { standby: true } } },
      { conversation: { metadata: { standby: "true" } } },
      { whatsappInboundMessage: { metadata: { standby: 1 } } },
    ]) {
      assert.equal(isStandbyInboundEvent(event(raw)), true, JSON.stringify(raw));
    }
  });

  it("does not flag normal or falsy-flagged messages", () => {
    for (const raw of [
      {},
      { metadata: {} },
      { metadata: { standby: false } },
      { message: { metadata: { standby: "no" } } },
      "not-an-object",
      null,
    ]) {
      assert.equal(isStandbyInboundEvent(event(raw)), false, JSON.stringify(raw));
    }
  });

  it("only applies to message.received — echoes/statuses/lifecycle pass through", () => {
    const raw = { metadata: { standby: true } };
    for (const kind of ["message.echo", "message.status", "comment.received", "account.lifecycle", "other"]) {
      assert.equal(isStandbyInboundEvent(event(raw, kind)), false, kind);
    }
  });
});

describe("M3 — zernio normalizer stamps raw.standby", () => {
  const base = {
    event: "message.received",
    account: { accountId: "acct_1" },
    message: {
      id: "m1",
      platformMessageId: "pm1",
      platform: "whatsapp",
      text: "hola",
      sender: { id: "15550000001" },
      sentAt: "2026-01-01T00:00:00Z",
    },
    conversation: { id: "conv_1" },
  };

  it("body-level metadata.standby stamps raw.standby", () => {
    const body = { ...base, metadata: { standby: true } };
    const [e] = zernioProvider.parseWebhook({ headers: {}, rawBody: JSON.stringify(body) });
    assert.equal((e.raw as Record<string, unknown>).standby, true);
    assert.equal(isStandbyInboundEvent(e), true);
  });

  it("message-level metadata.standby stamps raw.standby", () => {
    const body = {
      ...base,
      message: { ...base.message, metadata: { standby: true } },
    };
    const [e] = zernioProvider.parseWebhook({ headers: {}, rawBody: JSON.stringify(body) });
    assert.equal((e.raw as Record<string, unknown>).standby, true);
  });

  it("unflagged messages carry no standby hint", () => {
    const [e] = zernioProvider.parseWebhook({ headers: {}, rawBody: JSON.stringify(base) });
    assert.equal((e.raw as Record<string, unknown>).standby, undefined);
    assert.equal(isStandbyInboundEvent(e), false);
  });
});

describe("M3 — pipeline suppression surfaces", () => {
  const pipeline = readFileSync("src/lib/messaging/inbound-pipeline.ts", "utf8");

  it("the durable turn job is never claimed for standby events", () => {
    const block = pipeline.slice(
      pipeline.indexOf("const ensureDurableTurnJob"),
      pipeline.indexOf("await enqueueInboundTurnJob({")
    );
    assert.match(block, /if \(standby\) return;/);
  });

  it("the auto-reply gate excludes standby events", () => {
    const block = pipeline.slice(
      pipeline.indexOf("actor === \"customer\""),
      pipeline.indexOf("const claimKey = autoReplyClaimKey")
    );
    assert.match(block, /!standby/);
  });

  it("the post-persistence gate returns before the turn claim", () => {
    const gateAt = pipeline.indexOf("if (standby) {");
    const claimAt = pipeline.indexOf(
      "await ensureDurableTurnJob(conversationId);",
      gateAt === -1 ? 0 : gateAt
    );
    const redirectAt = pipeline.indexOf("webOrderRedirectEnabled)");
    assert.ok(gateAt !== -1 && claimAt !== -1 && redirectAt !== -1);
    assert.ok(
      gateAt < claimAt && claimAt < redirectAt,
      "the standby return must precede the durable turn claim and the redirect"
    );
  });
});
