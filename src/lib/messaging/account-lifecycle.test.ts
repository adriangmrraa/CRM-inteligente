/* eslint-disable @typescript-eslint/no-require-imports -- modules must load after the @/db hook */
/**
 * H1 — account lifecycle events keep channel_accounts.status in sync.
 *
 * Zernio emits account.connected / account.disconnected on the same webhook;
 * previously they were recorded in channel_events but the row never moved,
 * so a disconnected account looked active (and a reconnect was invisible)
 * until a human toggled it. These tests pin:
 * - eventName → status mapping (unknown verbs record but don't move rows);
 * - the status write happens BEFORE the durable event row (retryable fail);
 * - status-agnostic lifecycle resolution: a disconnected row still matches
 *   `account.connected`, ambiguity/provider-mismatch stay fail-closed;
 * - end-to-end through handlePassiveChannelEvent: status flips + event row
 *   persists under the right account partition.
 *
 * Synthetic ids only — no real phones, no DATABASE_URL, no network.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { FakeDb, installFakeDb } from "./test-support/fake-db";

const fake = new FakeDb();
const restoreDb = installFakeDb(fake);

const {
  applyChannelAccountLifecycle,
  lifecycleStatusForEvent,
} = require("./account-lifecycle") as typeof import("./account-lifecycle");
const {
  resolveChannelAccountIncludingInactive,
} = require("./accounts") as typeof import("./accounts");
const { handlePassiveChannelEvent } =
  require("./ingress") as typeof import("./ingress");
const { zernioProvider } =
  require("./providers/zernio") as typeof import("./providers/zernio");
import type { IngressContext } from "./ingress";
import type { NormalizedInboundEvent } from "./types";

function seedAccount(over: Record<string, unknown>): void {
  fake.rows("channel_accounts").push({
    id: fake.rows("channel_accounts").length + 1,
    tenantId: "default",
    provider: "zernio",
    channel: "instagram",
    providerAccountId: "acc-1",
    senderAddress: "@demo",
    displayName: null,
    credentialsRef: "env:ZERNIO_TEST_",
    agentConfigId: null,
    status: "active",
    createdAt: new Date(),
    updatedAt: new Date(),
    ...over,
  });
}

function makeEvent(over: Partial<NormalizedInboundEvent> = {}): NormalizedInboundEvent {
  return {
    provider: "zernio",
    deliveryId: "lc-del-1",
    kind: "account.lifecycle",
    direction: "na",
    providerAccountId: "acc-1",
    sender: {},
    timestamp: "2026-01-01T00:00:00.000Z",
    raw: { platform: "instagram", eventName: "account.disconnected" },
    ...over,
  };
}

const ACCOUNT = {
  id: "7",
  tenantId: "default",
  provider: "zernio" as const,
  channel: "instagram" as const,
  providerAccountId: "acc-1",
  senderAddress: "@demo",
  credentials: { apiKey: "k", webhookSecret: "" },
  status: "active" as const,
};

function ctx(over: Partial<IngressContext> = {}): IngressContext {
  return { channel: "instagram", account: ACCOUNT, channelAccountId: 7, ...over };
}

const accountRow = (id: number) =>
  fake.rows("channel_accounts").find((row) => row.id === id);

describe("lifecycleStatusForEvent — eventName → target status", () => {
  it("maps connect-family verbs to active", () => {
    for (const eventName of [
      "account.connected",
      "account.reconnected",
      "account.authorized",
    ]) {
      assert.equal(
        lifecycleStatusForEvent(makeEvent({ raw: { eventName } })),
        "active",
        eventName
      );
    }
  });

  it("maps disconnect-family verbs to disconnected", () => {
    for (const eventName of [
      "account.disconnected",
      "account.revoked",
      "account.deauthorized",
      "account.expired",
    ]) {
      assert.equal(
        lifecycleStatusForEvent(makeEvent({ raw: { eventName } })),
        "disconnected",
        eventName
      );
    }
  });

  it("returns null for unknown verbs and non-lifecycle kinds", () => {
    assert.equal(
      lifecycleStatusForEvent(makeEvent({ raw: { eventName: "account.created" } })),
      null
    );
    assert.equal(
      lifecycleStatusForEvent(makeEvent({ kind: "message.status" })),
      null
    );
    // No eventName at all → nothing to key on.
    assert.equal(
      lifecycleStatusForEvent(makeEvent({ raw: { platform: "instagram" } })),
      null
    );
  });
});

describe("applyChannelAccountLifecycle — status sync", () => {
  it("flips the bound row's status (idempotently)", async () => {
    seedAccount({ id: 7 });
    const event = makeEvent();
    await applyChannelAccountLifecycle(event, 7);
    assert.equal(accountRow(7)?.status, "disconnected");
    // Same redelivery: still disconnected, no error.
    await applyChannelAccountLifecycle(event, 7);
    assert.equal(accountRow(7)?.status, "disconnected");
    // Reconnect flips it back.
    await applyChannelAccountLifecycle(
      makeEvent({ raw: { eventName: "account.connected" } }),
      7
    );
    assert.equal(accountRow(7)?.status, "active");
  });

  it("no-ops without a real row id or a mappable verb", async () => {
    seedAccount({ id: 8, providerAccountId: "acc-8" });
    await applyChannelAccountLifecycle(makeEvent(), undefined);
    await applyChannelAccountLifecycle(
      makeEvent({ raw: { eventName: "account.created" } }),
      8
    );
    assert.equal(accountRow(8)?.status, "active");
  });
});

describe("resolveChannelAccountIncludingInactive", () => {
  it("matches a disconnected row the strict resolver can't see", async () => {
    process.env.ZERNIO_TEST_API_KEY = "k";
    try {
      seedAccount({ id: 9, status: "disconnected", providerAccountId: "acc-9" });
      const res = await resolveChannelAccountIncludingInactive(
        "instagram",
        ["acc-9"],
        "zernio"
      );
      assert.equal(res.kind, "resolved");
      if (res.kind === "resolved") {
        assert.equal(res.rowId, 9);
        assert.equal(res.account.status, "disconnected");
      }
    } finally {
      delete process.env.ZERNIO_TEST_API_KEY;
    }
  });

  it("stays fail-closed on ambiguity and provider mismatch", async () => {
    process.env.ZERNIO_TEST_API_KEY = "k";
    try {
      seedAccount({ id: 10, status: "disconnected", providerAccountId: "acc-10" });
      seedAccount({ id: 11, status: "active", providerAccountId: "acc-10" });
      const ambiguous = await resolveChannelAccountIncludingInactive(
        "instagram",
        ["acc-10"],
        "zernio"
      );
      assert.equal(ambiguous.kind, "mismatch");

      const wrongProvider = await resolveChannelAccountIncludingInactive(
        "instagram",
        ["acc-9"],
        "kapso"
      );
      assert.equal(wrongProvider.kind, "mismatch");

      const foreign = await resolveChannelAccountIncludingInactive(
        "instagram",
        ["someone-elses-account"],
        "zernio"
      );
      assert.equal(foreign.kind, "not-found");
    } finally {
      delete process.env.ZERNIO_TEST_API_KEY;
    }
  });

  it("materializes with empty credentials when scoped creds can't resolve", async () => {
    // A revoked account may no longer have usable credentials — lifecycle
    // resolution only needs the row identity (signature falls back to the
    // provider secret); it must not fail closed on MissingScopedCredential.
    seedAccount({
      id: 12,
      status: "disconnected",
      providerAccountId: "acc-12",
      credentialsRef: "env:ZERNIO_MISSING_", // resolves nothing
    });
    const res = await resolveChannelAccountIncludingInactive(
      "instagram",
      ["acc-12"],
      "zernio"
    );
    assert.equal(res.kind, "resolved");
    if (res.kind === "resolved") {
      assert.equal(res.account.credentials.apiKey, "");
    }
  });
});

describe("handlePassiveChannelEvent — lifecycle end-to-end", () => {
  it("disconnect flips the row and persists the event under its partition", async () => {
    seedAccount({ id: 7 });
    const res = await handlePassiveChannelEvent(makeEvent(), ctx());
    assert.equal(res.status, 200);
    assert.equal(accountRow(7)?.status, "disconnected");
    const persisted = fake
      .rows("channel_events")
      .filter((row) => row.deliveryId === "lc-del-1");
    assert.equal(persisted.length, 1);
    assert.equal(persisted[0].channelAccountId, 7);
    assert.equal(persisted[0].kind, "account.lifecycle");
  });

  it("reconnect revives a disconnected row", async () => {
    seedAccount({ id: 13, status: "disconnected", providerAccountId: "acc-13" });
    const res = await handlePassiveChannelEvent(
      makeEvent({
        deliveryId: "lc-del-2",
        providerAccountId: "acc-13",
        raw: { platform: "instagram", eventName: "account.connected" },
      }),
      ctx({ channelAccountId: 13, account: { ...ACCOUNT, id: "13", providerAccountId: "acc-13" } })
    );
    assert.equal(res.status, 200);
    assert.equal(accountRow(13)?.status, "active");
  });

  it("an unknown verb persists but does not move the row", async () => {
    seedAccount({ id: 14, providerAccountId: "acc-14" });
    const res = await handlePassiveChannelEvent(
      makeEvent({
        deliveryId: "lc-del-3",
        providerAccountId: "acc-14",
        raw: { platform: "instagram", eventName: "account.verified" },
      }),
      ctx({ channelAccountId: 14, account: { ...ACCOUNT, id: "14" } })
    );
    assert.equal(res.status, 200);
    assert.equal(accountRow(14)?.status, "active");
    const persisted = fake
      .rows("channel_events")
      .filter((row) => row.deliveryId === "lc-del-3");
    assert.equal(persisted.length, 1);
  });
});

// The zernio adapter must stamp the event name on raw so lifecycleStatusForEvent
// can key off it — pin the seam at the normalizer level.
describe("zernio normalizer — eventName stamping", () => {
  it("carries the header event name into raw.eventName", () => {
    const events = zernioProvider.parseWebhook({
      headers: { "x-zernio-event": "account.disconnected" },
      rawBody: JSON.stringify({
        account: { accountId: "acc-1", platform: "instagram" },
      }),
    });
    assert.equal(events.length, 1);
    assert.equal(events[0].kind, "account.lifecycle");
    assert.equal(
      (events[0].raw as Record<string, unknown>).eventName,
      "account.disconnected"
    );
  });
});

process.on("exit", () => {
  restoreDb();
});
