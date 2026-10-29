/* eslint-disable @typescript-eslint/no-require-imports -- modules must load after the stubs */
/**
 * HTTP-level coverage for GET /api/channels/zernio/callback (M6).
 *
 * The OAuth return URL is the only place a forged `connected=...` could
 * create a channel_accounts row — the state nonce cookie is the CSRF gate,
 * so every failure path must redirect with an error and write NOTHING.
 * requireAdmin, next/headers cookies and @/db are stubbed; fetch is mocked
 * for the account-enrichment path.
 */

import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it, mock } from "node:test";
import { NextRequest } from "next/server";

import { FakeDb, installFakeDb } from "@/lib/messaging/test-support/fake-db";
import { connectStateCookieName } from "@/lib/messaging/providers/zernio-connect";

const fake = new FakeDb();
installFakeDb(fake);

let adminOk = true;
const cookieJar = new Map<string, string>();
const cookieStore = {
  get(name: string): { value: string } | undefined {
    const value = cookieJar.get(name);
    return value === undefined ? undefined : { value };
  },
  delete(name: string): void {
    cookieJar.delete(name);
  },
};

const Module = require("node:module") as {
  _load: (request: string, parent: unknown, isMain: boolean) => unknown;
};
const originalLoad = Module._load;
Module._load = function (
  request: string,
  parent: unknown,
  isMain: boolean
): unknown {
  if (request === "next/headers") {
    return { cookies: async () => cookieStore };
  }
  if (request === "@/lib/auth/require-admin") {
    return { requireAdmin: async () => adminOk };
  }
  return originalLoad.call(this, request, parent, isMain);
};

const { GET } =
  require("./route") as typeof import("./route");
const { invalidateIntegrationSecretsCache } =
  require("@/lib/integrations") as typeof import("@/lib/integrations");

function get(query: string) {
  return GET(
    new NextRequest(
      `https://example.test/api/channels/zernio/callback?${query}`
    )
  );
}

function location(res: Response): URL {
  const target = res.headers.get("location");
  assert.ok(target, "expected a redirect");
  return new URL(target);
}

let previousApiKey: string | undefined;

beforeEach(() => {
  adminOk = true;
  cookieJar.clear();
  previousApiKey = process.env.ZERNIO_API_KEY;
  delete process.env.ZERNIO_API_KEY;
  for (const table of ["channel_accounts", "agent_config"]) {
    fake.rows(table).length = 0;
  }
  invalidateIntegrationSecretsCache();
});

afterEach(() => {
  mock.restoreAll();
  if (previousApiKey === undefined) delete process.env.ZERNIO_API_KEY;
  else process.env.ZERNIO_API_KEY = previousApiKey;
});

describe("GET /api/channels/zernio/callback (HTTP level)", () => {
  it("bounces unauthenticated visitors to /login", async () => {
    adminOk = false;
    const res = await get("connected=instagram&accountId=a&state=s");
    assert.equal(location(res).pathname, "/login");
    assert.equal(fake.rows("channel_accounts").length, 0);
  });

  it("rejects a non-connectable platform before touching the state cookie", async () => {
    const res = await get("connected=sms&accountId=a1&state=s1");
    assert.equal(location(res).searchParams.get("error"), "connect-params");
    assert.equal(fake.rows("channel_accounts").length, 0);
  });

  it("rejects a forged callback with no state cookie (CSRF)", async () => {
    const res = await get("connected=instagram&accountId=a1&state=attacker");
    assert.equal(location(res).searchParams.get("error"), "oauth-state");
    assert.equal(fake.rows("channel_accounts").length, 0);
  });

  it("rejects a state that does not match the issued cookie", async () => {
    cookieJar.set(connectStateCookieName("instagram"), "issued-state");
    const res = await get("connected=instagram&accountId=a1&state=other-state");
    assert.equal(location(res).searchParams.get("error"), "oauth-state");
    assert.equal(fake.rows("channel_accounts").length, 0);
  });

  it("consumes the state cookie so a replayed callback is rejected", async () => {
    const name = connectStateCookieName("instagram");
    cookieJar.set(name, "one-shot");
    const first = await get("connected=instagram&accountId=a1&state=one-shot");
    assert.equal(location(first).searchParams.get("connected"), "zernio:instagram");
    assert.equal(cookieJar.has(name), false);
    const replay = await get("connected=instagram&accountId=a1&state=one-shot");
    assert.equal(location(replay).searchParams.get("error"), "oauth-state");
  });

  it("requires accountId after the state check", async () => {
    cookieJar.set(connectStateCookieName("instagram"), "s1");
    const res = await get("connected=instagram&state=s1");
    assert.equal(location(res).searchParams.get("error"), "connect-params");
    assert.equal(fake.rows("channel_accounts").length, 0);
  });

  it("upserts the account with credentialsRef=null when the key is DB-scoped", async () => {
    cookieJar.set(connectStateCookieName("instagram"), "s1");
    const res = await get(
      "connected=instagram&accountId=acct_1&username=brand&state=s1"
    );
    assert.equal(location(res).searchParams.get("connected"), "zernio:instagram");
    const rows = fake.rows("channel_accounts");
    assert.equal(rows.length, 1);
    assert.equal(rows[0].provider, "zernio");
    assert.equal(rows[0].channel, "instagram");
    assert.equal(rows[0].providerAccountId, "acct_1");
    assert.equal(rows[0].credentialsRef, null);
    assert.equal(rows[0].status, "active");
  });

  it("stamps credentialsRef=env:ZERNIO_ only when the key is env-managed", async () => {
    process.env.ZERNIO_API_KEY = "env_key_fixture";
    invalidateIntegrationSecretsCache();
    mock.method(globalThis, "fetch", async () =>
      new Response(
        JSON.stringify({
          accounts: [
            { id: "acct_1", username: "brand", displayName: "Brand IG" },
          ],
        })
      )
    );
    cookieJar.set(connectStateCookieName("instagram"), "s1");
    const res = await get(
      "connected=instagram&accountId=acct_1&state=s1"
    );
    assert.equal(location(res).searchParams.get("connected"), "zernio:instagram");
    const rows = fake.rows("channel_accounts");
    assert.equal(rows[0]?.credentialsRef, "env:ZERNIO_");
    assert.equal(rows[0]?.displayName, "Brand IG");
  });
});
