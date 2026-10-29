/**
 * Account lifecycle sync (H1): provider `account.*` events keep
 * `channel_accounts.status` reflecting provider reality. The durable record
 * of every lifecycle event already lands in `channel_events`; this module
 * additionally flips the bound row's status so `/admin/channels` shows a
 * disconnect/reconnect without manual intervention.
 *
 * Only the row the event resolved to is ever updated — the
 * ambiguity/provider-mismatch fail-closed rules of account resolution apply
 * unchanged, so a cross-account lifecycle event cannot touch a foreign row.
 */

import { and, eq, ne } from "drizzle-orm";

import { db } from "@/db";
import { channelAccounts } from "@/db/schema";

import type { NormalizedInboundEvent } from "./types";

type LifecycleStatus = "active" | "disconnected";

/** eventName tails (the verb after the last ".") → target row status. */
const LIFECYCLE_STATUS: Record<string, LifecycleStatus> = {
  connected: "active",
  reconnected: "active",
  authorized: "active",
  enabled: "active",
  restored: "active",
  disconnected: "disconnected",
  revoked: "disconnected",
  deauthorized: "disconnected",
  deauthorised: "disconnected",
  expired: "disconnected",
  removed: "disconnected",
  disabled: "disconnected",
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/**
 * Target status for a normalized lifecycle event, or null when the verb is
 * unknown (the event is still persisted to channel_events; unknown verbs
 * just don't move the row). The event name travels on `raw.eventName`,
 * stamped by adapters at parse time.
 */
export function lifecycleStatusForEvent(
  event: Pick<NormalizedInboundEvent, "kind" | "raw">
): LifecycleStatus | null {
  if (event.kind !== "account.lifecycle") return null;
  const raw = isRecord(event.raw) ? event.raw : undefined;
  const eventName =
    typeof raw?.eventName === "string" ? raw.eventName : undefined;
  const verb = eventName?.split(".").pop();
  if (!verb) return null;
  return LIFECYCLE_STATUS[verb] ?? null;
}

/**
 * Flip `channel_accounts.status` to match a lifecycle event. No-op for
 * non-lifecycle kinds, unknown verbs, or ctx without a real row id
 * (legacy placeholder accounts have no row to update). The UPDATE is
 * conditional on the status actually changing so idempotent redeliveries
 * don't write. Throws on DB error — callers run this BEFORE the durable
 * channel_events insert so a retryable failure surfaces as 503 and the
 * provider redelivers instead of acking a status that never landed.
 */
export async function applyChannelAccountLifecycle(
  event: NormalizedInboundEvent,
  channelAccountId: number | undefined
): Promise<void> {
  const status = lifecycleStatusForEvent(event);
  if (status === null || channelAccountId == null) return;
  await db
    .update(channelAccounts)
    .set({ status, updatedAt: new Date() })
    .where(
      and(eq(channelAccounts.id, channelAccountId), ne(channelAccounts.status, status))
    );
}
