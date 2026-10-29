import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  normalizeBaseUrl,
  resolvePublicBaseUrl,
} from "./public-url";

describe("normalizeBaseUrl", () => {
  it("returns null for empty/blank/missing values", () => {
    assert.equal(normalizeBaseUrl(undefined), null);
    assert.equal(normalizeBaseUrl(null), null);
    assert.equal(normalizeBaseUrl(""), null);
    assert.equal(normalizeBaseUrl("   "), null);
  });

  it("enforces https:// on bare hostnames", () => {
    assert.equal(normalizeBaseUrl("app.onrender.com"), "https://app.onrender.com");
  });

  it("strips paths and trailing slashes to a clean origin", () => {
    assert.equal(
      normalizeBaseUrl("https://app.example.com/some/path/"),
      "https://app.example.com"
    );
    assert.equal(
      normalizeBaseUrl("https://app.example.com/"),
      "https://app.example.com"
    );
  });

  it("keeps http loopback origins for local development", () => {
    assert.equal(normalizeBaseUrl("http://localhost:3000"), "http://localhost:3000");
  });

  it("rejects non-http(s) schemes and garbage", () => {
    assert.equal(normalizeBaseUrl("ftp://files.example"), null);
    assert.equal(normalizeBaseUrl("javascript:alert(1)"), null);
    assert.equal(normalizeBaseUrl("http://"), null);
  });
});

describe("resolvePublicBaseUrl", () => {
  it("prefers NEXT_PUBLIC_APP_URL over every other variable", () => {
    assert.equal(
      resolvePublicBaseUrl({
        NEXT_PUBLIC_APP_URL: "https://app.example.com/",
        AUTH_URL: "https://auth.example.com",
        RENDER_EXTERNAL_URL: "service.onrender.com",
        VERCEL_URL: "app.vercel.app",
      }),
      "https://app.example.com"
    );
  });

  it("falls through AUTH_URL → RENDER_EXTERNAL_URL → VERCEL_URL in order", () => {
    assert.equal(
      resolvePublicBaseUrl({
        AUTH_URL: "https://app.example.com",
        RENDER_EXTERNAL_URL: "service.onrender.com",
      }),
      "https://app.example.com"
    );
    assert.equal(
      resolvePublicBaseUrl({ RENDER_EXTERNAL_URL: "service.onrender.com" }),
      "https://service.onrender.com"
    );
    assert.equal(
      resolvePublicBaseUrl({ VERCEL_URL: "app.vercel.app" }),
      "https://app.vercel.app"
    );
  });

  it("skips a stale loopback AUTH_URL when a deployed URL exists", () => {
    // A localhost AUTH_URL left over from development must not poison
    // generated callback/webhook URLs on a deployed service (H4).
    assert.equal(
      resolvePublicBaseUrl({
        NEXT_PUBLIC_APP_URL: "http://localhost:3000",
        AUTH_URL: "http://localhost:3000",
        RENDER_EXTERNAL_URL: "socialcrm.onrender.com",
      }),
      "https://socialcrm.onrender.com"
    );
  });

  it("returns loopback when it is the only candidate (local dev)", () => {
    assert.equal(
      resolvePublicBaseUrl({ AUTH_URL: "http://localhost:3000" }),
      "http://localhost:3000"
    );
  });

  it("returns null when nothing usable is configured", () => {
    assert.equal(resolvePublicBaseUrl({}), null);
    assert.equal(
      resolvePublicBaseUrl({ AUTH_URL: "not a url", NEXT_PUBLIC_APP_URL: "??" }),
      null
    );
  });
});
