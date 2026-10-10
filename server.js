import "dotenv/config";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import express from "express";
import { rateLimit } from "express-rate-limit";
import twilio from "twilio";
import { registerMediaStreamServer } from "./src/media-stream.js";
import {
  isAuthorizedPrivateChat,
  parseBotCommand,
  parseTelegramAdminIds,
  TelegramBot
} from "./src/telegram.js";
import { validateLead, validatePhoneNumber } from "./src/validation.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// типу, перевіряємо середовище, бо без .env і підписів Twilio сервак просто вмре на пустому місці
const config = {
  port: Number(process.env.PORT || 3000),
  publicBaseUrl: (process.env.PUBLIC_BASE_URL || "").replace(/\/+$/, ""),
  databasePath: path.resolve(process.env.DATABASE_PATH || "./data/autocaller.sqlite"),
  twilioSid: process.env.TWILIO_ACCOUNT_SID,
  twilioToken: process.env.TWILIO_AUTH_TOKEN,
  twilioNumber: process.env.TWILIO_PHONE_NUMBER,
  deepseekKey: process.env.DEEPSEEK_API_KEY,
  deepseekModel: process.env.DEEPSEEK_MODEL || "deepseek-chat",
  deepgramKey: process.env.DEEPGRAM_API_KEY,
  elevenLabsKey: process.env.ELEVENLABS_API_KEY,
  elevenLabsVoiceId: process.env.ELEVENLABS_VOICE_ID,
  telegramToken: process.env.TELEGRAM_BOT_TOKEN,
  telegramAdminChatIds: parseTelegramAdminIds(process.env.TELEGRAM_ADMIN_CHAT_IDS || ""),
  greeting: process.env.BOT_GREETING || "Вітаю! Ви говорите з автоматизованим асистентом підтримки. Чим можемо допомогти?",
  systemPrompt: process.env.BOT_SYSTEM_PROMPT || "Ти — привітний технічний асистент підтримки. Відповідай коротко і зрозуміло українською. Не проси паролі, реквізити карток або коди підтвердження. Якщо не можеш допомогти, попроси клієнта звернутися до служби підтримки звичайним каналом.",
  sttLanguage: process.env.STT_LANGUAGE || "uk-UA"
};

const missing = [
  ["PUBLIC_BASE_URL", config.publicBaseUrl],
  ["TWILIO_ACCOUNT_SID", config.twilioSid],
  ["TWILIO_AUTH_TOKEN", config.twilioToken],
  ["TWILIO_PHONE_NUMBER", config.twilioNumber],
  ["DEEPSEEK_API_KEY", config.deepseekKey],
  ["DEEPGRAM_API_KEY", config.deepgramKey],
  ["ELEVENLABS_API_KEY", config.elevenLabsKey],
  ["ELEVENLABS_VOICE_ID", config.elevenLabsVoiceId],
  ["TELEGRAM_BOT_TOKEN", config.telegramToken]
].filter(([, value]) => !value).map(([key]) => key);

if (missing.length) {
  throw new Error(`Не вистачає обов'язкових змінних середовища: ${missing.join(", ")}`);
}
if (!/^https:\/\/[^/]+$/i.test(config.publicBaseUrl)) {
  throw new Error("PUBLIC_BASE_URL має бути відкритим HTTPS-origin без шляху.");
}
if (!Number.isInteger(config.port) || config.port < 1 || config.port > 65535) {
  throw new Error("PORT має бути коректним портом TCP.");
}

await fs.mkdir(path.dirname(config.databasePath), { recursive: true });
const audioDirectory = path.join(path.dirname(config.databasePath), "audio");
await fs.mkdir(audioDirectory, { recursive: true });

const db = new Database(config.databasePath);
db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = ON");
db.exec(`
  CREATE TABLE IF NOT EXISTS leads (
    id TEXT PRIMARY KEY,
    first_name TEXT NOT NULL,
    last_name TEXT NOT NULL,
    phone TEXT NOT NULL,
    created_at TEXT NOT NULL,
    call_status TEXT NOT NULL DEFAULT 'queued',
    call_sid TEXT,
    turns INTEGER NOT NULL DEFAULT 0
  );
  CREATE TABLE IF NOT EXISTS messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    lead_id TEXT NOT NULL REFERENCES leads(id),
    role TEXT NOT NULL CHECK (role IN ('user', 'assistant')),
    content TEXT NOT NULL,
    created_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS audio_files (
    id TEXT PRIMARY KEY,
    lead_id TEXT NOT NULL REFERENCES leads(id),
    file_path TEXT NOT NULL,
    created_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS lead_notifications (
    lead_id TEXT NOT NULL REFERENCES leads(id),
    chat_id TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending',
    attempts INTEGER NOT NULL DEFAULT 0,
    next_attempt_at TEXT NOT NULL,
    sent_at TEXT,
    PRIMARY KEY (lead_id, chat_id)
  );
  CREATE TABLE IF NOT EXISTS stream_tokens (
    lead_id TEXT NOT NULL REFERENCES leads(id),
    call_sid TEXT NOT NULL,
    token_hash TEXT NOT NULL,
    created_at TEXT NOT NULL,
    used_at TEXT,
    PRIMARY KEY (lead_id, call_sid)
  );
`);

if (db.pragma("table_info(leads)").some(({ name }) => name === "consent_at")) {
  db.exec("ALTER TABLE leads DROP COLUMN consent_at");
}

const twilioClient = twilio(config.twilioSid, config.twilioToken);
const telegramBot = new TelegramBot(config.telegramToken);
const app = express();
app.disable("x-powered-by");
app.set("trust proxy", 1);
app.use(express.urlencoded({ extended: false, limit: "32kb" }));
app.use(express.json({ limit: "32kb" }));

const leadRateLimit = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 5,
  standardHeaders: "draft-7",
  legacyHeaders: false,
  message: { error: "Забагато заявок. Спробуйте пізніше." }
});

function asyncRoute(handler) {
  return (req, res, next) => Promise.resolve(handler(req, res, next)).catch(next);
}

function twilioWebhook(req, res, next) {
  const signature = req.get("X-Twilio-Signature");
  const requestUrl = `${config.publicBaseUrl}${req.originalUrl}`;
  if (!signature || !twilio.validateRequest(config.twilioToken, signature, requestUrl, req.body)) {
    return res.status(403).send("Невірний підпис Twilio.");
  }
  next();
}

function callbackUrl(route, query = {}) {
  const url = new URL(route, `${config.publicBaseUrl}/`);
  for (const [key, value] of Object.entries(query)) {
    url.searchParams.set(key, value);
  }
  return url.toString();
}

function getLead(id) {
  return db.prepare("SELECT * FROM leads WHERE id = ?").get(id);
}

function saveLead(lead, createdAt) {
  // типу, записали лід і шлепнули нотифікації адмінам, бо без цього вони не помітять новий треп
  const insertLead = db.prepare(`
    INSERT INTO leads (id, first_name, last_name, phone, created_at, call_status)
    VALUES (?, ?, ?, ?, ?, 'pending')
  `);
  const insertNotification = db.prepare(`
    INSERT INTO lead_notifications (lead_id, chat_id, next_attempt_at)
    VALUES (?, ?, ?)
  `);
  const transaction = db.transaction(() => {
    insertLead.run(
      lead.id,
      lead.firstName,
      lead.lastName,
      lead.phone,
      createdAt
    );
    for (const chatId of config.telegramAdminChatIds) {
      insertNotification.run(lead.id, chatId, createdAt);
    }
  });
  transaction();
}

let dispatchingNotifications = false;

async function dispatchPendingNotifications() {
  if (dispatchingNotifications) {
    return;
  }
  dispatchingNotifications = true;
  try {
    const pending = db.prepare(`
      SELECT n.lead_id, n.chat_id, n.attempts, l.first_name, l.last_name, l.phone, l.created_at
      FROM lead_notifications n
      JOIN leads l ON l.id = n.lead_id
      WHERE n.status = 'pending' AND n.next_attempt_at <= ?
      ORDER BY l.created_at ASC
      LIMIT 25
    `).all(new Date().toISOString());
    const markSent = db.prepare(`
      UPDATE lead_notifications
      SET status = 'sent', sent_at = ?
      WHERE lead_id = ? AND chat_id = ? AND status = 'pending'
    `);
    const retryLater = db.prepare(`
      UPDATE lead_notifications
      SET attempts = ?, next_attempt_at = ?
      WHERE lead_id = ? AND chat_id = ? AND status = 'pending'
    `);

    for (const item of pending) {
      const lead = {
        id: item.lead_id,
        first_name: item.first_name,
        last_name: item.last_name,
        phone: item.phone,
        created_at: item.created_at
      };
      const text = [
        "Нова заявка на дзвінок",
        `Ім'я: ${lead.first_name} ${lead.last_name}`,
        `Телефон: ${lead.phone}`,
        `Час: ${lead.created_at}`,
        `ID: ${lead.id}`,
        `Щоб розпочати дзвінок, надішліть: /call ${lead.id}`
      ].join("\n");

      try {
        await telegramBot.sendMessage(item.chat_id, text);
        markSent.run(new Date().toISOString(), item.lead_id, item.chat_id);
      } catch (error) {
        const attempts = item.attempts + 1;
        const delaySeconds = Math.min(300, 5 * (2 ** Math.min(attempts - 1, 6)));
        retryLater.run(
          attempts,
          new Date(Date.now() + delaySeconds * 1000).toISOString(),
          item.lead_id,
          item.chat_id
        );
        console.error(`Unable to notify Telegram chat ${item.chat_id} about lead ${item.lead_id}:`, error.message);
      }
    }
  } finally {
    dispatchingNotifications = false;
  }
}

async function startLeadCall(leadId) {
  const lock = db.prepare(`
    UPDATE leads SET call_status = 'starting'
    WHERE id = ? AND call_status IN ('pending', 'failed')
  `).run(leadId);
  if (lock.changes !== 1) {
    return false;
  }

  const lead = getLead(leadId);
  try {
    const call = await twilioClient.calls.create({
      to: lead.phone,
      from: config.twilioNumber,
      url: callbackUrl("/voice", { leadId }),
      method: "POST",
      statusCallback: callbackUrl("/call-status", { leadId }),
      statusCallbackMethod: "POST",
      statusCallbackEvent: ["initiated", "ringing", "answered", "completed"]
    });
    db.prepare(`
      UPDATE leads
      SET call_status = CASE WHEN call_status = 'starting' THEN ? ELSE call_status END,
          call_sid = ?
      WHERE id = ?
    `).run(call.status || "queued", call.sid, leadId);
    return true;
  } catch (error) {
    db.prepare("UPDATE leads SET call_status = 'failed' WHERE id = ?").run(leadId);
    console.error(`Unable to start outbound call for lead ${leadId}:`, error.message);
    throw error;
  }
}

function telegramHelp() {
  return [
    "Команди керування заявками:",
    "/leads — останні заявки, що чекають на дзвінок",
    "/call ID — розпочати дзвінок за ID заявки",
    "/dial НОМЕР — зателефонувати напряму на номер США або Канади",
    "/help — показати цю довідку"
  ].join("\n");
}

async function handleTelegramMessage(message) {
  // гопський варіант: приймаємо команди, перевіряємо, що чат приватний і не застарілий, і вуаля
  const chatId = String(message.chat?.id || "");
  if (!isAuthorizedPrivateChat(message, config.telegramAdminChatIds)) {
    return;
  }

  if (typeof message.date === "number" && Date.now() / 1000 - message.date > 300) {
    await telegramBot.sendMessage(chatId, "Ця команда застаріла і не виконана. Надішліть нову команду.");
    return;
  }

  const parsed = parseBotCommand(message.text);
  if (!parsed || !["/start", "/help", "/leads", "/call", "/dial"].includes(parsed.command)) {
    return;
  }

  if (parsed.command === "/start" || parsed.command === "/help") {
    await telegramBot.sendMessage(chatId, telegramHelp());
    return;
  }

  if (parsed.command === "/leads") {
    const leads = db.prepare(`
      SELECT id, first_name, last_name, phone, created_at, call_status
      FROM leads
      WHERE call_status IN ('pending', 'failed')
      ORDER BY created_at DESC
      LIMIT 10
    `).all();
    const text = leads.length
      ? leads.map((lead) => [
        `${lead.first_name} ${lead.last_name} — ${lead.phone}`,
        `ID: ${lead.id} (${lead.call_status})`,
        `Команда: /call ${lead.id}`
      ].join("\n")).join("\n\n")
      : "Немає заявок, що чекають на дзвінок.";
    await telegramBot.sendMessage(chatId, text);
    return;
  }

  if (parsed.command === "/dial") {
    if (parsed.args.length !== 1) {
      await telegramBot.sendMessage(chatId, "Формат команди: /dial НОМЕР_ТЕЛЕФОНА");
      return;
    }

    const phone = validatePhoneNumber(parsed.args[0]);
    if (phone.error) {
      await telegramBot.sendMessage(chatId, phone.error);
      return;
    }

    const leadId = crypto.randomUUID();
    db.prepare(`
      INSERT INTO leads (id, first_name, last_name, phone, created_at, call_status)
      VALUES (?, 'there', '', ?, ?, 'pending')
    `).run(leadId, phone.value, new Date().toISOString());

    try {
      const started = await startLeadCall(leadId);
      await telegramBot.sendMessage(
        chatId,
        started
          ? `Дзвінок на номер ${phone.value} запущено.`
          : "Не вдалося запустити дзвінок. Спробуйте ще раз."
      );
    } catch {
      await telegramBot.sendMessage(chatId, "Не вдалося запустити дзвінок. Перевірте налаштування Twilio та журнал сервера.");
    }
    return;
  }

  if (parsed.args.length !== 1 || !/^[0-9a-f-]{4,36}$/i.test(parsed.args[0])) {
    await telegramBot.sendMessage(chatId, "Формат команди: /call ID_ЗАЯВКИ");
    return;
  }

  const matches = db.prepare(`
    SELECT id FROM leads
    WHERE id LIKE ?
    LIMIT 2
  `).all(`${parsed.args[0]}%`);
  if (matches.length === 0) {
    await telegramBot.sendMessage(chatId, "Заявку не знайдено.");
    return;
  }
  if (matches.length > 1) {
    await telegramBot.sendMessage(chatId, "ID неоднозначний. Використовуйте повний ID зі списку заявок.");
    return;
  }

  try {
    const started = await startLeadCall(matches[0].id);
    await telegramBot.sendMessage(
      chatId,
      started
        ? `Дзвінок запущено для заявки ${matches[0].id}.`
        : "Дзвінок уже запущено, заявка ще обробляється або має невідповідний статус."
    );
  } catch {
    await telegramBot.sendMessage(chatId, "Не вдалося запустити дзвінок. Перевірте налаштування Twilio та журнал сервера.");
  }
}

async function synthesizeSpeech(text, leadId) {
  const response = await fetch(
    `https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(config.elevenLabsVoiceId)}?output_format=mp3_44100_128`,
    {
      method: "POST",
      headers: {
        "xi-api-key": config.elevenLabsKey,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        text,
        model_id: "eleven_multilingual_v2",
        voice_settings: { stability: 0.5, similarity_boost: 0.75 }
      }),
      signal: AbortSignal.timeout(30000)
    }
  );
  if (!response.ok) {
    const details = (await response.text()).slice(0, 500);
    throw new Error(`ElevenLabs TTS failed (${response.status}): ${details}`);
  }

  const id = crypto.randomUUID();
  const filePath = path.join(audioDirectory, `${id}.mp3`);
  await fs.writeFile(filePath, Buffer.from(await response.arrayBuffer()));
  db.prepare("INSERT INTO audio_files (id, lead_id, file_path, created_at) VALUES (?, ?, ?, ?)").run(
    id,
    leadId,
    filePath,
    new Date().toISOString()
  );
  return `${config.publicBaseUrl}/audio/${id}`;
}

async function cleanupCallArtifacts(leadId) {
  const audioFiles = db.prepare("SELECT id, file_path FROM audio_files WHERE lead_id = ?").all(leadId);
  for (const audio of audioFiles) {
    try {
      await fs.unlink(audio.file_path);
      db.prepare("DELETE FROM audio_files WHERE id = ?").run(audio.id);
    } catch (error) {
      if (error.code === "ENOENT") {
        db.prepare("DELETE FROM audio_files WHERE id = ?").run(audio.id);
      } else {
        console.error("Unable to remove generated call audio:", error.message);
      }
    }
  }
  db.prepare("DELETE FROM messages WHERE lead_id = ?").run(leadId);
}

app.get("/health", (_req, res) => res.json({ status: "ok" }));
app.use(express.static(path.join(__dirname, "public"), { index: "index.html" }));

app.post("/api/leads", leadRateLimit, asyncRoute(async (req, res) => {
  const validation = validateLead(req.body);
  if (validation.error) {
    return res.status(400).json({ error: validation.error });
  }

  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  saveLead({ id, ...validation.value }, now);
  void dispatchPendingNotifications().catch((error) => {
    console.error("Unable to dispatch Telegram lead notifications:", error.message);
  });
  res.status(202).json({ id, status: "pending_review" });
}));

app.post("/voice", twilioWebhook, asyncRoute(async (req, res) => {
  const lead = getLead(req.query.leadId);
  const response = new twilio.twiml.VoiceResponse();
  if (!lead) {
    response.say({ language: config.sttLanguage }, "Ця заявка більше недоступна.");
    response.hangup();
    return res.type("text/xml").send(response.toString());
  }

  const callSid = req.body.CallSid;
  if (typeof callSid !== "string" || callSid !== lead.call_sid) {
    response.hangup();
    return res.type("text/xml").send(response.toString());
  }

  const token = crypto.randomBytes(32).toString("base64url");
  db.prepare(`
    INSERT OR REPLACE INTO stream_tokens (lead_id, call_sid, token_hash, created_at)
    VALUES (?, ?, ?, ?)
  `).run(
    lead.id,
    callSid,
    crypto.createHash("sha256").update(token).digest("hex"),
    new Date().toISOString()
  );

  const streamUrl = new URL("/media-stream", config.publicBaseUrl);
  streamUrl.protocol = "wss:";
  const connect = response.connect();
  const stream = connect.stream({ url: streamUrl.toString() });
  stream.parameter({ name: "leadId", value: lead.id });
  stream.parameter({ name: "token", value: token });
  response.hangup();
  res.type("text/xml").send(response.toString());
}));

app.post("/call-status", twilioWebhook, asyncRoute(async (req, res) => {
  const status = typeof req.body.CallStatus === "string" ? req.body.CallStatus : "unknown";
  const storedStatus = ["busy", "no-answer", "canceled", "failed"].includes(status)
    ? "failed"
    : status;
  db.prepare("UPDATE leads SET call_status = ? WHERE id = ?").run(storedStatus, req.query.leadId);
  if (status === "completed") {
    await cleanupCallArtifacts(req.query.leadId);
    db.prepare("DELETE FROM stream_tokens WHERE lead_id = ?").run(req.query.leadId);
  }
  res.sendStatus(204);
}));

app.get("/audio/:id", asyncRoute(async (req, res) => {
  if (!/^[0-9a-f-]{36}$/i.test(req.params.id)) {
    return res.sendStatus(404);
  }
  const audio = db.prepare("SELECT file_path FROM audio_files WHERE id = ?").get(req.params.id);
  if (!audio) {
    return res.sendStatus(404);
  }
  res.type("audio/mpeg").sendFile(audio.file_path);
}));

app.use((error, _req, res, _next) => {
  console.error("Request failed:", error.message);
  if (res.headersSent) {
    return;
  }
  res.status(500).json({ error: "Внутрішня помилка сервера." });
});

const server = app.listen(config.port, "0.0.0.0", () => {
  console.log(`Voice support service listening on port ${config.port}`);
  const mediaStreamServer = registerMediaStreamServer(server, { db, config });
  const telegramAbortController = new AbortController();
  const notificationTimer = setInterval(() => {
    void dispatchPendingNotifications().catch((error) => {
      console.error("Unable to dispatch Telegram lead notifications:", error.message);
    });
  }, 5000);
  void telegramBot.poll(handleTelegramMessage, telegramAbortController.signal);

  const shutdown = () => {
    clearInterval(notificationTimer);
    telegramAbortController.abort();
    for (const client of mediaStreamServer.clients) {
      client.close(1001, "Server shutting down.");
    }
    mediaStreamServer.close();
    server.close(() => {
      db.close();
    });
  };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
});
