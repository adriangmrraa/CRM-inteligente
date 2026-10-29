/* eslint-disable @typescript-eslint/no-require-imports -- modules must load after the stubs */
/**
 * M6 — channel server actions (node:test, FakeDb, mocked fetch).
 *
 * Covers the two safety surfaces added for the workshop path:
 * checkChannelAccount (local proof only, never secret material) and
 * registerZernioWebhookAction (read-back verification, L3 — a bare
 * "accepted" must never be reported as registered).
 */

import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it, mock } from "node:test";

import { channelAccounts } from "@/db/schema";
import { FakeDb, installFakeDb } from "@/lib/messaging/test-support/fake-db";

const fake = new FakeDb();
installFakeDb(fake);

let adminOk = true;

const Module = require("node:module") as {
  _load: (request: string, parent: unknown, isMain: boolean) => unknown;
};
const prevLoad = Module._load;
Module._load = function (
  request: string,
  parent: unknown,
  isMain: boolean
): unknown {
  if (request === "@/lib/auth/require-admin") {
    return { requireAdmin: async () => adminOk };
  }
  if (request === "next/headers") {
    return {
      cookies: async () => ({
        get: () => undefined,
        set: () => undefined,
        delete: () => undefined,
      }),
    };
  }
  if (request === "next/cache") {
    return { revalidatePath: () => undefined };
  }
  return prevLoad.call(this, request, parent, isMain);
};

const { checkChannelAccount, registerZernioWebhookAction } =
  require("./actions") as typeof import("./actions");
const { invalidateIntegrationSecretsCache } =
  require("@/lib/integrations") as typeof import("@/lib/integrations");

const BASE = "https://crm.test";
const INGRESS_URL = `${BASE}/api/webhooks/ingress/zernio`;

const envKeys = [
  "ZERNIO_API_KEY",
  "ZERNIO_WEBHOOK_SECRET",
  "ZTEST_API_KEY",
  "NEXT_PUBLIC_APP_URL",
  "AUTH_URL",
  "RENDER_EXTERNAL_URL",
  "VERCEL_URL",
] as const;
let savedEnv: Record<string, string | undefined> = {};

/** Mutable upstream fixtures — each test shapes the Zernio responses. */
let settingsBody: unknown = { webhooks: [] };
let settingsStatus = 200;
let accountsBody: unknown = { accounts: [] };

beforeEach(() => {
  adminOk = true;
  savedEnv = {};
  for (const key of envKeys) {
    savedEnv[key] = process.env[key];
    delete process.env[key];
  }
  settingsBody = { webhooks: [] };
  settingsStatus = 200;
  accountsBody = { accounts: [] };
  fake.rows("channel_accounts").length = 0;
  fake.rows("agent_config").length = 0;
  invalidateIntegrationSecretsCache();
  mock.method(globalThis, "fetch", async (url: string, init?: RequestInit) => {
    const u = String(url);
    if (u.endsWith("/webhooks/settings") && init?.method === "POST") {
      return new Response(JSON.stringify({ id: "wh_1" }), { status: 200 });
    }
    if (u.endsWith("/webhooks/settings")) {
      return new Response(JSON.stringify(settingsBody), {
        status: settingsStatus,
      });
    }
    if (u.includes("/accounts?search=")) {
      return new Response(JSON.stringify(accountsBody), { status: 200 });
    }
    return new Response("{}", { status: 404 });
  });
});

afterEach(() => {
  mock.restoreAll();
  for (const key of envKeys) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
  invalidateIntegrationSecretsCache();
});

describe("registerZernioWebhookAction", () => {
  it("rejects non-admins", async () => {
    adminOk = false;
    const res = await registerZernioWebhookAction();
    assert.equal(res.ok, false);
  });

  it("fails closed when the API key/secret cannot be resolved", async () => {
    process.env.NEXT_PUBLIC_APP_URL = BASE;
    invalidateIntegrationSecretsCache();
    const res = await registerZernioWebhookAction();
    assert.equal(res.ok, false);
    assert.match(res.error ?? "", /Zernio/);
  });

  it("requires a public base URL", async () => {
    process.env.ZERNIO_API_KEY = "k";
    process.env.ZERNIO_WEBHOOK_SECRET = "s";
    invalidateIntegrationSecretsCache();
    const res = await registerZernioWebhookAction();
    assert.equal(res.ok, false);
    assert.match(res.error ?? "", /URL pública/);
  });

  it("refuses a loopback base — a localhost webhook can never be delivered", async () => {
    // The runbook promises refusal on non-public bases: registering
    // http://localhost:3000 would read back as "verified" while Zernio
    // could never reach it — a false verification.
    process.env.ZERNIO_API_KEY = "k";
    process.env.ZERNIO_WEBHOOK_SECRET = "s";
    process.env.NEXT_PUBLIC_APP_URL = "http://localhost:3000";
    invalidateIntegrationSecretsCache();
    const res = await registerZernioWebhookAction();
    assert.equal(res.ok, false);
    assert.match(res.error ?? "", /local|HTTPS|pública/i);
  });

  it("reports verified:true only when read-back shows the URL", async () => {
    process.env.ZERNIO_API_KEY = "k";
    process.env.ZERNIO_WEBHOOK_SECRET = "s";
    process.env.NEXT_PUBLIC_APP_URL = BASE;
    invalidateIntegrationSecretsCache();
    settingsBody = { webhooks: [{ url: INGRESS_URL }] };
    const res = await registerZernioWebhookAction();
    assert.equal(res.ok, true);
    assert.equal(res.verified, true);
  });

  it("reports ok:false when read-back lists other URLs but not ours", async () => {
    process.env.ZERNIO_API_KEY = "k";
    process.env.ZERNIO_WEBHOOK_SECRET = "s";
    process.env.NEXT_PUBLIC_APP_URL = BASE;
    invalidateIntegrationSecretsCache();
    settingsBody = { webhooks: [{ url: "https://other.test/hook" }] };
    const res = await registerZernioWebhookAction();
    assert.equal(res.ok, false);
    assert.match(res.error ?? "", /no aparece/);
  });

  it("downgrades to verified:false with a note when read-back is unreadable", async () => {
    process.env.ZERNIO_API_KEY = "k";
    process.env.ZERNIO_WEBHOOK_SECRET = "s";
    process.env.NEXT_PUBLIC_APP_URL = BASE;
    invalidateIntegrationSecretsCache();
    settingsStatus = 500;
    const res = await registerZernioWebhookAction();
    assert.equal(res.ok, true);
    assert.equal(res.verified, false);
    assert.ok(res.note);
  });
});

describe("checkChannelAccount", () => {
  it("rejects non-admins", async () => {
    adminOk = false;
    const res = await checkChannelAccount(1);
    assert.equal(res.ok, false);
    assert.equal(res.checks.length, 0);
  });

  it("reports a missing row without leaking internals", async () => {
    const res = await checkChannelAccount(999);
    assert.equal(res.ok, false);
    assert.match(res.error ?? "", /Cuenta no encontrada/);
  });

  it("confirms a resolvable Zernio account upstream without returning secrets", async () => {
    process.env.ZTEST_API_KEY = "ztest_api_key_fixture";
    fake.seed(channelAccounts, [
      {
        id: 30,
        provider: "zernio",
        channel: "instagram",
        providerAccountId: "acct_ig1",
        credentialsRef: "env:ZTEST_",
        status: "active",
      },
    ]);
    accountsBody = { accounts: [{ id: "acct_ig1", username: "brand" }] };
    const res = await checkChannelAccount(30);
    assert.equal(res.ok, true);
    const zernioCheck = res.checks.find((c) => c.label === "Cuenta en Zernio");
    assert.equal(zernioCheck?.ok, true);
    assert.ok(!JSON.stringify(res).includes("ztest_api_key_fixture"));
  });

  it("marks an inactive account's status check and skips credential probing", async () => {
    fake.seed(channelAccounts, [
      {
        id: 31,
        provider: "zernio",
        channel: "instagram",
        providerAccountId: "acct_ig2",
        credentialsRef: "env:ZTEST_",
        status: "disconnected",
      },
    ]);
    const res = await checkChannelAccount(31);
    assert.equal(res.ok, false);
    const status = res.checks.find((c) => c.label === "Estado");
    assert.equal(status?.ok, false);
    const creds = res.checks.find((c) => c.label === "Credenciales");
    assert.equal(creds?.ok, "warn");
  });

  it("warns when multiple WhatsApp accounts are active (mixed-provider ambiguity)", async () => {
    process.env.ZTEST_API_KEY = "ztest_api_key_fixture";
    fake.seed(channelAccounts, [
      {
        id: 40,
        provider: "zernio",
        channel: "whatsapp",
        providerAccountId: "acct_wa1",
        credentialsRef: "env:ZTEST_",
        status: "active",
      },
      {
        id: 41,
        provider: "ycloud",
        channel: "whatsapp",
        providerAccountId: "waba_1",
        credentialsRef: "env:ZTEST_",
        status: "active",
      },
    ]);
    const res = await checkChannelAccount(40);
    const mixed = res.checks.find((c) => c.label === "WhatsApp multi-cuenta");
    assert.equal(mixed?.ok, "warn");
    assert.match(mixed?.detail ?? "", /zernio \+ ycloud|ycloud \+ zernio/);
  });
});
