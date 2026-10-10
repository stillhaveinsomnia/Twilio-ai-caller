const TELEGRAM_API = "https://api.telegram.org";

export function parseTelegramAdminIds(value) {
  const ids = (value || "")
    .split(",")
    .map((id) => id.trim())
    .filter(Boolean);

  if (!ids.length || ids.some((id) => !/^[1-9]\d*$/.test(id) || !Number.isSafeInteger(Number(id)))) {
    throw new Error("TELEGRAM_ADMIN_CHAT_IDS must be a comma-separated list of private Telegram chat IDs.");
  }

  return [...new Set(ids)];
}

export function parseBotCommand(text) {
  if (typeof text !== "string") {
    return null;
  }

  const [command, ...args] = text.trim().split(/\s+/);
  if (!command?.startsWith("/")) {
    return null;
  }

  return {
    command: command.split("@")[0].toLowerCase(),
    args
  };
}

export function isAuthorizedPrivateChat(message, allowedChatIds) {
  return message?.chat?.type === "private"
    && allowedChatIds.includes(String(message.chat.id));
}

function delay(milliseconds, signal) {
  // типу, зупинка на пару секунд, щоб Telegram не йобнувся від частих запитів
  return new Promise((resolve) => {
    const finish = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", finish);
      resolve();
    };
    const timer = setTimeout(finish, milliseconds);
    signal.addEventListener("abort", finish, { once: true });
  });
}

export class TelegramBot {
  constructor(token, { fetchImpl = fetch, apiBase = TELEGRAM_API } = {}) {
    this.token = token;
    this.fetchImpl = fetchImpl;
    this.apiBase = apiBase.replace(/\/+$/, "");
  }

  async request(method, payload, signal) {
    const requestController = new AbortController();
    const abortRequest = () => requestController.abort(signal?.reason);
    if (signal?.aborted) {
      abortRequest();
    } else {
      signal?.addEventListener("abort", abortRequest, { once: true });
    }
    const timeout = setTimeout(() => requestController.abort(), 35000);
    try {
      const response = await this.fetchImpl(
        `${this.apiBase}/bot${this.token}/${method}`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
          signal: requestController.signal
        }
      );
      if (!response.ok) {
        throw new Error(`Telegram ${method} failed with HTTP ${response.status}.`);
      }

      const result = await response.json();
      if (!result.ok) {
        throw new Error(`Telegram ${method} failed: ${result.description || "unknown API error"}`);
      }
      return result.result;
    } finally {
      clearTimeout(timeout);
      signal?.removeEventListener("abort", abortRequest);
    }
  }

  sendMessage(chatId, text) {
    return this.request("sendMessage", {
      chat_id: chatId,
      text,
      disable_web_page_preview: true
    });
  }

  getUpdates(offset, signal) {
    return this.request("getUpdates", {
      ...(offset === undefined ? {} : { offset }),
      timeout: 25,
      allowed_updates: ["message"]
    }, signal);
  }

  async poll(onMessage, signal) {
    let offset;
    while (!signal.aborted) {
      try {
        const updates = await this.getUpdates(offset, signal);
        for (const update of updates) {
          offset = update.update_id + 1;
          if (update.message) {
            try {
              await onMessage(update.message);
            } catch (error) {
              console.error("Unable to process Telegram update:", error.message);
            }
          }
        }
      } catch (error) {
        if (signal.aborted) {
          return;
        }
        console.error("Telegram polling failed:", error.message);
        await delay(3000, signal);
      }
    }
  }
}
