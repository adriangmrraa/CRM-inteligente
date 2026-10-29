/* eslint-disable @typescript-eslint/no-require-imports -- modules must load after the @/db hook */
/**
 * F15: getIntegrationSecrets() caches decrypted values for 30s — admin write
 * paths must invalidate that cache so a rotated webhook/app/cron secret takes
 * effect immediately instead of staying accepted until the TTL expires.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

import { agentConfig } from "@/db/schema";
import { FakeDb, installFakeDb } from "@/lib/messaging/test-support/fake-db";

// Needed by encrypt()/decryptIfEncrypted() for the zernio *Enc columns.
process.env.AUTH_SECRET ??= "test-secret-for-integration-secrets";

const fake = new FakeDb();
installFakeDb(fake);

const { getIntegrationSecrets, invalidateIntegrationSecretsCache } =
  require("./integrations") as typeof import("./integrations");
const { resolveWebhookSecret } =
  require("./messaging/ingress") as typeof import("./messaging/ingress");

describe("F15 — integration secrets cache", () => {
  it("serves the 30s cache until invalidateIntegrationSecretsCache() is called", async () => {
    fake.seed(agentConfig, [{ id: 1, cronSecret: "plain-secret-v1" }]);

    const first = await getIntegrationSecrets();
    assert.equal(first.cronSecret, "plain-secret-v1");

    // The row rotates out from under the cache.
    fake.rows("agent_config")[0].cronSecret = "rotated-v2";
    const stillCached = await getIntegrationSecrets();
    assert.equal(stillCached.cronSecret, "plain-secret-v1");

    invalidateIntegrationSecretsCache();
    const fresh = await getIntegrationSecrets();
    assert.equal(fresh.cronSecret, "rotated-v2");
  });

  it("is exported and called from every owned secret-write path", () => {
    assert.equal(typeof invalidateIntegrationSecretsCache, "function");

    const agentActions = readFileSync(
      "src/app/(admin)/admin/agent/actions.ts",
      "utf8"
    );
    const calls = agentActions.match(/invalidateIntegrationSecretsCache\(\)/g);
    // saveAgentConfig + copyAgentConfig both write agent_config secrets.
    assert.ok(calls && calls.length >= 2);

    const metaActions = readFileSync(
      "src/app/(admin)/admin/meta/actions.ts",
      "utf8"
    );
    assert.match(metaActions, /invalidateIntegrationSecretsCache\(\)/);
  });
});

describe("Zernio global-scope secrets (H5)", () => {
  it("resolves the admin-stored enc columns before env, per field", async () => {
    // FakeDb returns the seeded row verbatim — keys mirror the select
    // aliases (zernioApiKey := zernioApiKeyEnc on the real driver).
    fake.seed(agentConfig, [
      {
        id: 1,
        zernioApiKey: "db-api-key", // plaintext tolerated on read
        zernioWebhookSecret: "db-webhook-secret",
      },
    ]);
    process.env.ZERNIO_API_KEY = "env-api-key";
    process.env.ZERNIO_WEBHOOK_SECRET = "env-webhook-secret";
    try {
      invalidateIntegrationSecretsCache();
      const secrets = await getIntegrationSecrets();
      assert.equal(secrets.zernioApiKey, "db-api-key");
      assert.equal(secrets.zernioWebhookSecret, "db-webhook-secret");
      // The provider-level ingress secret reads the same chain.
      assert.equal(await resolveWebhookSecret("zernio"), "db-webhook-secret");
    } finally {
      delete process.env.ZERNIO_API_KEY;
      delete process.env.ZERNIO_WEBHOOK_SECRET;
    }
  });

  it("env is the fallback when the global row has no zernio fields", async () => {
    fake.seed(agentConfig, [{ id: 1, systemPrompt: "x" }]);
    process.env.ZERNIO_WEBHOOK_SECRET = "env-only-secret";
    try {
      invalidateIntegrationSecretsCache();
      assert.equal(await resolveWebhookSecret("zernio"), "env-only-secret");
    } finally {
      delete process.env.ZERNIO_WEBHOOK_SECRET;
    }
  });

  it("an encrypted stored value decrypts for resolution", async () => {
    const { encrypt } = require("./encryption") as typeof import("./encryption");
    fake.seed(agentConfig, [
      { id: 1, zernioWebhookSecret: encrypt("enc-webhook-secret") },
    ]);
    invalidateIntegrationSecretsCache();
    assert.equal(await resolveWebhookSecret("zernio"), "enc-webhook-secret");
  });
});
