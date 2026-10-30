"use server";

import { requireAdmin } from "@/lib/auth/require-admin";
import { randomBytes } from "crypto";
import {
  getTelegramConfigFromDB,
  getMe,
  setTelegramWebhook,
  deleteTelegramWebhook as removeTelegramWebhook,
  getTelegramWebhookInfo,
} from "@/lib/telegram/bot";
import { db } from "@/db";
import { eq } from "drizzle-orm";
import { agentConfig } from "@/db/schema";
import { encrypt, maskToken as maskTokenUtil } from "@/lib/encryption";
import { publicBaseUrl } from "@/lib/public-url";
import { revalidatePath } from "next/cache";
import { invalidateAgentConfigScopeCache } from "@/lib/agent-config-scope";

export type TelegramStatus = {
  configured: boolean;
  botUsername: string | null;
  botToken: string;
  webhookToken: string;
  webhookUrl: string;
  allowedChatIds: number[];
  enabled: boolean;
};

export type WebhookInfo = {
  url: string;
  pendingUpdateCount: number;
};

export type TelegramActionState = {
  success: boolean;
  message: string;
};

export type SaveTelegramBotTokenState = TelegramActionState & {
  botUsername?: string;
  maskedBotToken?: string;
};

/**
 * Obtiene el estado actual de la configuración de Telegram
 */
function getPublicHost(): string | null {
  return publicBaseUrl();
}

export async function getTelegramStatus(): Promise<TelegramStatus> {
  if (!(await requireAdmin())) {
    return {
      configured: false,
      botUsername: null,
      botToken: "",
      webhookToken: "",
      webhookUrl: "",
      allowedChatIds: [],
      enabled: false,
    };
  }

  // Get from DB first, fallback to env
  const config = await getTelegramConfigFromDB();

  // Lazily generate + persist a webhook token so the admin always sees a
  // real URL — and no deployment ever ships a guessable one.
  let webhookToken = config.webhookToken;
  if (!webhookToken) {
    webhookToken = randomBytes(24).toString("hex");
    await db
      .update(agentConfig)
      .set({ telegramWebhookToken: encrypt(webhookToken), updatedAt: new Date() })
      .where(eq(agentConfig.id, 1));
  }

  const host = getPublicHost();
  const webhookUrl = host ? `${host}/api/telegram/webhook/${webhookToken}` : "— configurá AUTH_URL —";

  // Intentar obtener info del bot
  let botUsername: string | null = null;
  if (config.botToken) {
    const me = await getMe(config.botToken);
    if (me.ok && me.username) {
      botUsername = `@${me.username}`;
    }
  }

  return {
    configured: config.enabled,
    botUsername,
    botToken: config.botToken ? maskTokenUtil(config.botToken) : "",
    webhookToken: webhookToken,
    webhookUrl: webhookUrl,
    allowedChatIds: config.allowedChatIds,
    enabled: config.enabled,
  };
}

/**
 * Validates and stores a Telegram bot token encrypted at rest.
 * The raw token is never returned to the client.
 */
export async function saveTelegramBotTokenAction(
  rawToken: string
): Promise<SaveTelegramBotTokenState> {
  if (!(await requireAdmin())) {
    return { success: false, message: "No autorizado" };
  }

  const botToken = typeof rawToken === "string" ? rawToken.trim() : "";
  if (!botToken || botToken.length > 256) {
    return { success: false, message: "Ingresá un token de Telegram válido." };
  }

  const bot = await getMe(botToken);
  if (!bot.ok || !bot.username) {
    return {
      success: false,
      message: "Telegram rechazó el token. Revisalo en @BotFather e intentá nuevamente.",
    };
  }

  try {
    const encryptedToken = encrypt(botToken);
    const existing = await db
      .select({ id: agentConfig.id })
      .from(agentConfig)
      .where(eq(agentConfig.id, 1))
      .limit(1);

    if (existing.length > 0) {
      await db
        .update(agentConfig)
        .set({
          telegramBotToken: encryptedToken,
          telegramEnabled: true,
          updatedAt: new Date(),
        })
        .where(eq(agentConfig.id, 1));
    } else {
      await db.insert(agentConfig).values({
        id: 1,
        telegramBotToken: encryptedToken,
        telegramEnabled: true,
      });
    }

    invalidateAgentConfigScopeCache();
    revalidatePath("/admin/telegram");

    return {
      success: true,
      message: `Token guardado. Bot conectado como @${bot.username}.`,
      botUsername: `@${bot.username}`,
      maskedBotToken: maskTokenUtil(botToken),
    };
  } catch (error) {
    console.error("[telegram] Error saving bot token:", error);
    return {
      success: false,
      message: "No se pudo guardar el token. Intentá nuevamente.",
    };
  }
}

/**
 * Configura el webhook en Telegram
 */
export async function setTelegramWebhookAction(): Promise<TelegramActionState> {
  if (!(await requireAdmin())) {
    return { success: false, message: "No autorizado" };
  }

  const config = await getTelegramConfigFromDB();
  if (!config.botToken) {
    return {
      success: false,
      message:
        "El bot token no está configurado. Guardalo desde esta pantalla o en TELEGRAM_BOT_TOKEN.",
    };
  }

  const host = getPublicHost();
  if (!host) {
    return {
      success: false,
      message:
        "Configurá AUTH_URL (o NEXT_PUBLIC_APP_URL) con la URL pública del deploy para poder registrar el webhook.",
    };
  }

  let webhookToken = config.webhookToken;
  if (!webhookToken) {
    webhookToken = randomBytes(24).toString("hex");
    await db
      .update(agentConfig)
      .set({ telegramWebhookToken: encrypt(webhookToken), updatedAt: new Date() })
      .where(eq(agentConfig.id, 1));
  }
  const webhookUrl = `${host}/api/telegram/webhook/${webhookToken}`;

  // secret_token: Telegram signs every update with
  // X-Telegram-Bot-Api-Secret-Token carrying this value; the route verifies
  // it before parsing (F10).
  const result = await setTelegramWebhook(config.botToken, webhookUrl, webhookToken);
  if (!result.ok) {
    return {
      success: false,
      message: `Error al configurar webhook: ${result.error}`,
    };
  }

  return {
    success: true,
    message: `Webhook configurado correctamente → ${webhookUrl}`,
  };
}

/**
 * Elimina el webhook de Telegram
 */
export async function deleteTelegramWebhookAction(): Promise<TelegramActionState> {
  if (!(await requireAdmin())) {
    return { success: false, message: "No autorizado" };
  }

  const config = await getTelegramConfigFromDB();
  if (!config.botToken) {
    return { success: false, message: "TELEGRAM_BOT_TOKEN no está configurado." };
  }

  const result = await removeTelegramWebhook(config.botToken);
  if (!result.ok) {
    return {
      success: false,
      message: `Error al eliminar webhook: ${result.error}`,
    };
  }

  return { success: true, message: "Webhook eliminado correctamente" };
}

/**
 * Obtiene información del webhook actual
 */
export async function getTelegramWebhookInfoAction(): Promise<
  WebhookInfo | TelegramActionState
> {
  if (!(await requireAdmin())) {
    return { success: false, message: "No autorizado" };
  }

  const config = await getTelegramConfigFromDB();
  if (!config.botToken) {
    return { success: false, message: "El bot token no está configurado." };
  }

  const info = await getTelegramWebhookInfo(config.botToken);
  if (!info.ok) {
    return {
      success: false,
      message: `Error al obtener info del webhook: ${info.error}`,
    };
  }

  return {
    url: info.url ?? "",
    pendingUpdateCount: info.pendingUpdateCount ?? 0,
  };
}
