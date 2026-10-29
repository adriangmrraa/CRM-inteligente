"use server";

import { randomBytes } from "node:crypto";

import { and, desc, eq, inArray } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { cookies } from "next/headers";
import { z } from "zod";

import { db } from "@/db";
import { channelAccounts, channelEvents } from "@/db/schema";
import { auth } from "@/auth";
import { requireAdmin } from "@/lib/auth/require-admin";
import {
  resolveChannelAccountByIdStrict,
} from "@/lib/messaging/accounts";
import { isSchemaNotReady } from "@/lib/messaging/errors";
import {
  CHANNEL_KINDS,
  PROVIDER_IDS,
} from "@/lib/messaging/registry";
import {
  connectStateCookieName,
  fetchZernioAccount,
  fetchZernioWebhookSettings,
  getZernioConnectUrl,
  isZernioConnectPlatform,
  registerZernioWebhook,
  resolveZernioProfileId,
  ZERNIO_WHATSAPP_ONBOARDING,
} from "@/lib/messaging/providers/zernio-connect";
import type { ChannelKind, ProviderId } from "@/lib/messaging/types";
import { publicBaseUrl } from "./webhook-endpoints";

export interface ChannelAccountRow {
  id: number;
  provider: string;
  channel: string;
  providerAccountId: string;
  senderAddress: string;
  displayName: string | null;
  credentialsRef: string | null;
  status: string;
  createdAt: Date;
  /** Latest persisted channel_events row for this account (observability). */
  lastEventKind: string | null;
  lastEventStatus: string | null;
  lastEventAt: Date | null;
}

/** Read access: any authenticated admin-shell user. */
export async function fetchChannelAccounts(): Promise<ChannelAccountRow[]> {
  const session = await auth();
  if (!session) return [];
  const rows = await db
    .select({
      id: channelAccounts.id,
      provider: channelAccounts.provider,
      channel: channelAccounts.channel,
      providerAccountId: channelAccounts.providerAccountId,
      senderAddress: channelAccounts.senderAddress,
      displayName: channelAccounts.displayName,
      credentialsRef: channelAccounts.credentialsRef,
      status: channelAccounts.status,
      createdAt: channelAccounts.createdAt,
    })
    .from(channelAccounts)
    .orderBy(desc(channelAccounts.createdAt));

  // Last-event observability: newest channel_events row per account. One
  // bounded query, first hit per id wins — a missing channel_events table
  // (pre-migration install) degrades to nulls instead of breaking the page.
  const lastByAccount = new Map<
    number,
    { kind: string; status: string | null; createdAt: Date }
  >();
  const ids = rows.map((r) => r.id);
  if (ids.length > 0) {
    try {
      const recent = await db
        .select({
          channelAccountId: channelEvents.channelAccountId,
          kind: channelEvents.kind,
          status: channelEvents.status,
          createdAt: channelEvents.createdAt,
        })
        .from(channelEvents)
        .where(inArray(channelEvents.channelAccountId, ids))
        .orderBy(desc(channelEvents.createdAt))
        .limit(300);
      for (const event of recent) {
        if (event.channelAccountId == null) continue;
        if (!lastByAccount.has(event.channelAccountId)) {
          lastByAccount.set(event.channelAccountId, event);
        }
      }
    } catch (error) {
      if (!isSchemaNotReady(error)) throw error;
    }
  }

  return rows.map((row) => {
    const last = lastByAccount.get(row.id);
    return {
      ...row,
      lastEventKind: last?.kind ?? null,
      lastEventStatus: last?.status ?? null,
      lastEventAt: last?.createdAt ?? null,
    };
  });
}

export interface CreateChannelAccountInput {
  provider: string;
  channel: string;
  providerAccountId: string;
  senderAddress: string;
  displayName?: string;
  /** `env:PREFIX` (→ PREFIX_API_KEY/PREFIX_WEBHOOK_SECRET) or vault ref. */
  credentialsRef?: string;
}

// `prefix:value` refs (env:ZERNIO_, vault:…) plus the bare `agent_config`
// token that resolves scoped credentials — same grammar resolveCredentials
// accepts in src/lib/messaging/accounts.ts.
const CREDENTIALS_REF_RE = /^(agent_config|[a-z]+:[A-Za-z0-9_.-]+)$/;

export async function createChannelAccount(
  input: CreateChannelAccountInput
): Promise<{ ok: boolean; error?: string }> {
  if (!(await requireAdmin())) {
    return { ok: false, error: "Solo administradores pueden crear cuentas" };
  }
  if (!PROVIDER_IDS.includes(input.provider as ProviderId)) {
    return { ok: false, error: `Proveedor inválido: ${input.provider}` };
  }
  if (!CHANNEL_KINDS.includes(input.channel as ChannelKind)) {
    return { ok: false, error: `Canal inválido: ${input.channel}` };
  }
  const providerAccountId = input.providerAccountId.trim();
  const senderAddress = input.senderAddress.trim();
  if (!providerAccountId || !senderAddress) {
    return {
      ok: false,
      error: "providerAccountId y senderAddress son obligatorios",
    };
  }
  const credentialsRef = input.credentialsRef?.trim() || null;
  if (credentialsRef && !CREDENTIALS_REF_RE.test(credentialsRef)) {
    return {
      ok: false,
      error:
        "credentialsRef debe ser 'agent_config' o tener formato 'prefix:VALUE' (ej. env:ZERNIO_MAIN)",
    };
  }

  try {
    await db.insert(channelAccounts).values({
      provider: input.provider,
      channel: input.channel as ChannelKind,
      providerAccountId,
      senderAddress,
      displayName: input.displayName?.trim() || null,
      credentialsRef,
      status: "active",
    });
  } catch (error) {
    if ((error as { code?: string } | null)?.code === "23505") {
      return {
        ok: false,
        error: `Ya existe una cuenta ${input.provider} con providerAccountId '${providerAccountId}'`,
      };
    }
    throw error;
  }
  revalidatePath("/admin/channels");
  return { ok: true };
}

export async function setChannelAccountStatus(
  id: number,
  status: "active" | "disconnected"
): Promise<{ ok: boolean; error?: string }> {
  if (!(await requireAdmin())) {
    return { ok: false, error: "Solo administradores pueden cambiar estados" };
  }
  await db
    .update(channelAccounts)
    .set({ status, updatedAt: new Date() })
    .where(eq(channelAccounts.id, id));
  revalidatePath("/admin/channels");
  return { ok: true };
}

export interface ChannelCheckItem {
  label: string;
  ok: boolean | "warn";
  detail?: string;
}

export interface ChannelCheckResult {
  ok: boolean;
  error?: string;
  checks: ChannelCheckItem[];
}

/**
 * Safe per-account connection/config check (M2). Verifies what can be
 * proven locally — row state, credential resolvability, channel binding —
 * plus a read-only provider probe for Zernio accounts. Never returns secret
 * material and never claims delivery works without evidence.
 */
export async function checkChannelAccount(
  id: number
): Promise<ChannelCheckResult> {
  if (!(await requireAdmin())) {
    return {
      ok: false,
      error: "Solo administradores pueden verificar cuentas",
      checks: [],
    };
  }
  const rows = await db
    .select()
    .from(channelAccounts)
    .where(eq(channelAccounts.id, id))
    .limit(1);
  const row = rows[0];
  if (!row) {
    return { ok: false, error: "Cuenta no encontrada", checks: [] };
  }

  const checks: ChannelCheckItem[] = [
    { label: "Cuenta registrada", ok: true, detail: `${row.provider}/${row.channel}` },
    {
      label: "Estado",
      ok: row.status === "active",
      detail: row.status === "active" ? "active" : `${row.status} — reactivala o reconectá el proveedor`,
    },
  ];

  if (row.status !== "active") {
    checks.push({
      label: "Credenciales",
      ok: "warn",
      detail: "verificación omitida — la cuenta no está activa",
    });
    return { ok: false, checks };
  }

  const resolution = await resolveChannelAccountByIdStrict(row.id);
  if (resolution.kind === "resolved") {
    checks.push({
      label: "Credenciales",
      ok: true,
      detail: `resueltas vía ${row.credentialsRef ?? "scope agent_config"}`,
    });
    const apiKey = resolution.account.credentials.apiKey;
    if (row.provider === "zernio" && apiKey) {
      const detail = await fetchZernioAccount(apiKey, row.providerAccountId);
      checks.push(
        detail
          ? {
              label: "Cuenta en Zernio",
              ok: true,
              detail: `confirmada (${detail.username ?? detail.displayName ?? detail.phoneNumber ?? row.providerAccountId})`,
            }
          : {
              label: "Cuenta en Zernio",
              ok: "warn",
              detail:
                "las credenciales resuelven pero la cuenta no pudo confirmarse upstream",
            }
      );
    }
  } else {
    checks.push({
      label: "Credenciales",
      ok: false,
      detail:
        resolution.kind === "mismatch"
          ? resolution.reason
          : "no se pudieron resolver para esta cuenta",
    });
  }

  if (row.channel === "whatsapp") {
    const whatsappRows = await db
      .select({ provider: channelAccounts.provider })
      .from(channelAccounts)
      .where(
        and(
          eq(channelAccounts.channel, "whatsapp"),
          eq(channelAccounts.status, "active")
        )
      );
    const providers = [...new Set(whatsappRows.map((r) => r.provider))];
    if (whatsappRows.length > 1) {
      checks.push({
        label: "WhatsApp multi-cuenta",
        ok: "warn",
        detail: `${whatsappRows.length} cuentas activas (${providers.join(" + ")}) — las respuestas en conversaciones sin cuenta ligada fallan cerrado`,
      });
    }
  }

  return { ok: !checks.some((c) => c.ok === false), checks };
}

const startConnectSchema = z.strictObject({
  platform: z.string().trim().min(1).max(32),
  onboarding: z.enum(ZERNIO_WHATSAPP_ONBOARDING).optional(),
});

/**
 * Embedded connect for Zernio: returns Zernio's `authUrl` so the client
 * navigates the operator there. The callback lands on
 * /api/channels/zernio/callback and upserts the channel_accounts row.
 * Requires a global-scope Zernio API key (agent_config → ZERNIO_API_KEY) —
 * this action never sees or stores the key itself.
 */
export async function startZernioConnect(
  input: unknown
): Promise<{ ok: boolean; authUrl?: string; error?: string }> {
  if (!(await requireAdmin())) {
    return { ok: false, error: "Solo administradores pueden conectar cuentas" };
  }
  const parsed = startConnectSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: "Datos inválidos" };
  }
  const { platform, onboarding } = parsed.data;
  if (!isZernioConnectPlatform(platform)) {
    return { ok: false, error: `Conexión embebida no disponible para '${platform}'` };
  }
  const { getIntegrationSecrets } = await import("@/lib/integrations");
  // Global-scope credential: agent_config.zernioApiKeyEnc (admin UI) first,
  // ZERNIO_API_KEY env second — the same chain the account row resolves.
  const apiKey = (await getIntegrationSecrets()).zernioApiKey.trim();
  if (!apiKey) {
    return {
      ok: false,
      error:
        "Falta la API key de Zernio — cargala en /admin/agent (Integraciones) o como ZERNIO_API_KEY en el entorno",
    };
  }
  const baseUrl = publicBaseUrl();
  if (!baseUrl) {
    return {
      ok: false,
      error: "Falta la URL pública (AUTH_URL o NEXT_PUBLIC_APP_URL)",
    };
  }

  const profile = await resolveZernioProfileId(apiKey);
  if (!profile.ok) return { ok: false, error: profile.error };

  // CSRF nonce rides inside our own redirect_url — Zernio preserves the
  // query string through the OAuth roundtrip (connecting-accounts.mdx).
  // The cookie is keyed per platform: starting a second connect (another
  // tab, another platform) must not clobber the first one's state.
  const state = randomBytes(16).toString("hex");
  const cookieStore = await cookies();
  cookieStore.set(connectStateCookieName(platform), state, {
    httpOnly: true,
    sameSite: "lax",
    secure: baseUrl.startsWith("https"),
    path: "/",
    maxAge: 10 * 60,
  });

  const connect = await getZernioConnectUrl({
    platform,
    profileId: profile.profileId,
    redirectUrl: `${baseUrl}/api/channels/zernio/callback?state=${state}`,
    apiKey,
    onboarding,
  });
  if (!connect.ok) {
    // No authUrl to return — drop the nonce instead of leaving a dead
    // one-shot cookie that could only ever fail verification later.
    cookieStore.delete(connectStateCookieName(platform));
    return { ok: false, error: connect.error };
  }
  return { ok: true, authUrl: connect.authUrl };
}

/**
 * One-click webhook registration for Zernio: posts our ingress URL and the
 * resolved global-scope secret (agent_config → env) to
 * /v1/webhooks/settings. YCloud/Kapso still configure webhooks in their
 * own consoles — the URLs shown above are what to paste there.
 */
export async function registerZernioWebhookAction(): Promise<{
  ok: boolean;
  verified?: boolean;
  note?: string;
  error?: string;
}> {
  if (!(await requireAdmin())) {
    return { ok: false, error: "Solo administradores pueden registrar webhooks" };
  }
  const { getIntegrationSecrets } = await import("@/lib/integrations");
  const secrets = await getIntegrationSecrets();
  const apiKey = secrets.zernioApiKey.trim();
  const secret = secrets.zernioWebhookSecret.trim();
  if (!apiKey || !secret) {
    return {
      ok: false,
      error:
        "Faltan la API key y/o el webhook secret de Zernio — cargalos en /admin/agent (Integraciones) o como ZERNIO_API_KEY / ZERNIO_WEBHOOK_SECRET en el entorno",
    };
  }
  const baseUrl = publicBaseUrl();
  if (!baseUrl) {
    return {
      ok: false,
      error: "Falta la URL pública (AUTH_URL o NEXT_PUBLIC_APP_URL)",
    };
  }
  const url = `${baseUrl}/api/webhooks/ingress/zernio`;
  const registered = await registerZernioWebhook({ url, secret, apiKey });
  if (!registered.ok) return registered;

  // Read-back verification (L3): report what Zernio actually has, never a
  // bare "accepted". An unreadable settings endpoint downgrades to
  // verified:false with a note — it does not invent failure either.
  const settings = await fetchZernioWebhookSettings(apiKey);
  if (!settings.ok) {
    return {
      ok: true,
      verified: false,
      note: "registrado — no se pudo releer la configuración de Zernio para verificar",
    };
  }
  if (settings.urls.includes(url)) return { ok: true, verified: true };
  if (settings.urls.length === 0) {
    return {
      ok: true,
      verified: false,
      note: "registrado — el listado de webhooks de Zernio no devolvió URLs para comparar",
    };
  }
  return {
    ok: false,
    error:
      "registro aceptado pero la URL no aparece en los webhooks de Zernio — revisá el dashboard",
  };
}
