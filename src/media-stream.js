import crypto from "node:crypto";
import WebSocket, { WebSocketServer } from "ws";
import {
  createDeepgramUrl,
  ElevenLabsTtsStream,
  extractSpeakableChunks,
  streamDeepSeekReply
} from "./realtime-ai.js";

function sendJson(socket, message) {
  if (socket.readyState === WebSocket.OPEN) {
    socket.send(JSON.stringify(message));
  }
}

export function consumeStreamToken(db, { leadId, callSid, token, accountSid, config, now = Date.now() }) {
  if (
    accountSid !== config.twilioSid
    || typeof leadId !== "string"
    || typeof callSid !== "string"
    || typeof token !== "string"
    || !/^[0-9a-f-]{36}$/i.test(leadId)
    || !/^[A-Za-z0-9_-]{40,64}$/.test(token)
  ) {
    return null;
  }

  const tokenHash = crypto.createHash("sha256").update(token).digest("hex");
  const tokenRecord = db.prepare(`
    SELECT st.lead_id, l.first_name, l.last_name, l.turns
    FROM stream_tokens st
    JOIN leads l ON l.id = st.lead_id
    WHERE st.lead_id = ? AND st.call_sid = ? AND st.token_hash = ?
      AND st.used_at IS NULL AND st.created_at > ?
  `).get(
    leadId,
    callSid,
    tokenHash,
    new Date(now - 10 * 60 * 1000).toISOString()
  );
  if (!tokenRecord) {
    return null;
  }

  const consumed = db.prepare(`
    UPDATE stream_tokens SET used_at = ?
    WHERE lead_id = ? AND call_sid = ? AND token_hash = ? AND used_at IS NULL
  `).run(new Date(now).toISOString(), leadId, callSid, tokenHash);
  return consumed.changes === 1 ? tokenRecord : null;
}

export function registerMediaStreamServer(server, { db, config }) {
  const webSocketServer = new WebSocketServer({
    noServer: true,
    maxPayload: 1024 * 1024
  });

  server.on("upgrade", (request, socket, head) => {
    let requestUrl;
    try {
      requestUrl = new URL(request.url, "https://localhost");
    } catch {
      socket.destroy();
      return;
    }
    if (requestUrl.pathname !== "/media-stream") {
      socket.destroy();
      return;
    }
    webSocketServer.handleUpgrade(request, socket, head, (webSocket) => {
      webSocketServer.emit("connection", webSocket, request);
    });
  });

  webSocketServer.on("connection", (twilioSocket) => {
    const session = new MediaCallSession(twilioSocket, db, config);
    twilioSocket.on("message", (raw) => {
      void session.handleTwilioMessage(raw).catch((error) => {
        console.error("Unable to process Twilio media stream:", error.message);
        session.close();
      });
    });
    twilioSocket.on("close", () => session.stop());
    twilioSocket.on("error", (error) => {
      console.error("Twilio media stream socket error:", error.message);
      session.close();
    });
  });

  return webSocketServer;
}

class MediaCallSession {
  constructor(twilioSocket, db, config) {
    this.twilioSocket = twilioSocket;
    this.db = db;
    this.config = config;
    this.deepgramSocket = null;
    this.deepgramReady = false;
    this.pendingAudio = [];
    this.pendingAudioBytes = 0;
    this.streamSid = null;
    this.lead = null;
    this.turns = 0;
    this.transcript = "";
    this.transcriptTimer = null;
    this.assistantSpeaking = false;
    this.assistantAbort = null;
    this.assistantPromise = null;
    this.activeTts = null;
    this.markWaiters = new Map();
    this.closed = false;
    this.hangupAfterPlayback = false;
    this.startTimeout = setTimeout(() => this.close(), 10000);
  }

  async handleTwilioMessage(raw) {
    let message;
    try {
      message = JSON.parse(raw.toString());
    } catch {
      this.close();
      return;
    }

    if (message.event === "start") {
      await this.start(message.start);
      return;
    }

    if (message.event === "media") {
      if (message.streamSid !== this.streamSid) {
        this.close();
        return;
      }
      this.forwardInboundAudio(message.media?.payload);
      return;
    }

    if (message.event === "mark") {
      if (message.streamSid !== this.streamSid) {
        this.close();
        return;
      }
      this.resolveMark(message.mark?.name);
      return;
    }

    if (message.event === "stop") {
      this.close();
    }
  }

  async start(start) {
    if (this.lead || !start || start.accountSid !== this.config.twilioSid) {
      this.close();
      return;
    }

    const leadId = start.customParameters?.leadId;
    const token = start.customParameters?.token;
    const callSid = start.callSid;
    if (
      typeof leadId !== "string"
      || typeof token !== "string"
      || !/^[0-9a-f-]{36}$/i.test(leadId)
      || !/^[A-Za-z0-9_-]{40,64}$/.test(token)
      || typeof callSid !== "string"
      || typeof start.streamSid !== "string"
    ) {
      this.close();
      return;
    }

    const tokenRecord = consumeStreamToken(this.db, {
      leadId,
      callSid,
      token,
      accountSid: start.accountSid,
      config: this.config
    });
    if (!tokenRecord) {
      this.close();
      return;
    }

    clearTimeout(this.startTimeout);
    this.streamSid = start.streamSid;
    this.lead = tokenRecord;
    this.turns = tokenRecord.turns;
    this.deepgramSocket = new WebSocket(createDeepgramUrl(this.config.sttLanguage), {
      headers: { Authorization: `Token ${this.config.deepgramKey}` }
    });
    this.deepgramSocket.on("message", (raw) => this.handleDeepgramMessage(raw));
    this.deepgramSocket.on("error", (error) => {
      console.error("Deepgram streaming error:", error.message);
      this.close();
    });
    this.deepgramSocket.on("close", (code) => {
      this.deepgramReady = false;
      if (!this.closed && code !== 1000) {
        console.error(`Deepgram closed the speech stream (${code}).`);
        this.close();
      }
    });

    try {
      await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("Timed out connecting to Deepgram.")), 12000);
        this.deepgramSocket.once("close", (code) => {
          clearTimeout(timer);
          reject(new Error(`Deepgram closed before the connection opened (${code}).`));
        });
        this.deepgramSocket.once("open", () => {
          clearTimeout(timer);
          resolve();
        });
        this.deepgramSocket.once("error", (error) => {
          clearTimeout(timer);
          reject(error);
        });
      });
      if (this.closed) {
        return;
      }
      this.deepgramReady = true;
      for (const payload of this.pendingAudio) {
        this.deepgramSocket.send(Buffer.from(payload, "base64"));
      }
      this.pendingAudio = [];
      this.pendingAudioBytes = 0;

      const greeting = this.config.greeting.replaceAll(
        "{{name}}",
        `${this.lead.first_name} ${this.lead.last_name}`
      );
      await this.speak(greeting);
    } catch (error) {
      console.error("Unable to start the real-time voice session:", error.message);
      this.close();
    }
  }

  forwardInboundAudio(payload) {
    if (typeof payload !== "string" || !this.deepgramSocket || this.closed) {
      return;
    }
    if (this.deepgramReady && this.deepgramSocket.readyState === WebSocket.OPEN) {
      this.deepgramSocket.send(Buffer.from(payload, "base64"));
      return;
    }

    const audioBytes = Buffer.byteLength(payload, "base64");
    if (this.pendingAudioBytes + audioBytes > 256 * 1024) {
      this.close();
      return;
    }
    this.pendingAudio.push(payload);
    this.pendingAudioBytes += audioBytes;
  }

  handleDeepgramMessage(raw) {
    let message;
    try {
      message = JSON.parse(raw.toString());
    } catch (error) {
      console.error("Deepgram returned invalid JSON:", error.message);
      return;
    }

    if (message.type === "SpeechStarted" && this.assistantAbort) {
      this.interruptAssistant();
    }
    if (message.type !== "Results") {
      return;
    }

    const transcript = message.channel?.alternatives?.[0]?.transcript?.trim();
    if (transcript && !message.is_final && this.assistantAbort) {
      this.interruptAssistant();
    }
    if (transcript && message.is_final) {
      this.transcript = `${this.transcript} ${transcript}`.trim().slice(0, 2000);
    } else if (transcript && message.speech_final) {
      this.transcript = `${this.transcript} ${transcript}`.trim().slice(0, 2000);
    }
    if (message.speech_final && this.transcript) {
      clearTimeout(this.transcriptTimer);
      this.transcriptTimer = setTimeout(() => {
        const utterance = this.transcript.trim();
        this.transcript = "";
        if (utterance) {
          void this.handleUtterance(utterance).catch((error) => {
            console.error("Unable to handle caller speech:", error.message);
            this.close();
          });
        }
      }, 300);
    }
  }

  async handleUtterance(utterance) {
    if (this.closed) {
      return;
    }
    this.textBuffer = "";
    if (this.assistantPromise) {
      await this.assistantPromise.catch(() => {});
    }
    if (this.closed) {
      return;
    }
    if (this.turns >= 10) {
      this.hangupAfterPlayback = true;
      await this.speak("Thank you for calling. Goodbye.");
      return;
    }

    this.db.prepare(`
      INSERT INTO messages (lead_id, role, content, created_at)
      VALUES (?, 'user', ?, ?)
    `).run(this.lead.lead_id, utterance, new Date().toISOString());

    let answer = "";
    try {
      await this.speakWithProducer(async (tts, signal) => {
        const history = this.db.prepare(
          "SELECT role, content FROM messages WHERE lead_id = ? ORDER BY id DESC LIMIT 12"
        ).all(this.lead.lead_id).reverse();

        answer = await streamDeepSeekReply({
          apiKey: this.config.deepseekKey,
          model: this.config.deepseekModel,
          messages: [
            { role: "system", content: this.config.systemPrompt },
            ...history
          ],
          signal,
          onDelta: (delta) => {
            answer += delta;
            const extracted = extractSpeakableChunks(this.textBuffer + delta);
            this.textBuffer = extracted.remainder;
            for (const chunk of extracted.chunks) {
              tts.sendText(chunk);
            }
          }
        });
        for (const chunk of extractSpeakableChunks(this.textBuffer, true).chunks) {
          tts.sendText(chunk);
        }
        this.textBuffer = "";
      });

      if (answer) {
        this.db.prepare(`
          INSERT INTO messages (lead_id, role, content, created_at)
          VALUES (?, 'assistant', ?, ?)
        `).run(this.lead.lead_id, answer, new Date().toISOString());
        this.turns += 1;
        this.db.prepare("UPDATE leads SET turns = ? WHERE id = ?")
          .run(this.turns, this.lead.lead_id);
      }
    } catch (error) {
    console.error("Unable to generate or voice support response:", error.message);
    await this.speak("I am having trouble connecting to support right now. Please contact support again later.");
    return;
    }

    if (this.turns >= 10) {
      this.hangupAfterPlayback = true;
      await this.speak("Thank you for calling. Goodbye.");
    }
  }

  async speak(text) {
    this.textBuffer = "";
    return this.speakWithProducer(async (tts) => {
      for (const chunk of extractSpeakableChunks(text, true).chunks) {
        tts.sendText(chunk);
      }
    });
  }

  async speakWithProducer(produce) {
    if (this.closed) {
      return;
    }
    const controller = new AbortController();
    this.assistantAbort = controller;
    let producedAudio = false;
    let generatedText = "";
    const tts = new ElevenLabsTtsStream({
      apiKey: this.config.elevenLabsKey,
      voiceId: this.config.elevenLabsVoiceId,
      onAudio: (audio) => {
        if (controller.signal.aborted || this.closed) {
          return;
        }
        producedAudio = true;
        this.assistantSpeaking = true;
        sendJson(this.twilioSocket, {
          event: "media",
          streamSid: this.streamSid,
          media: { payload: audio }
        });
      }
    });
    this.activeTts = tts;

    const generation = (async () => {
      await tts.open();
      generatedText = await produce(tts, controller.signal);
      await tts.finish();
      if (producedAudio && !controller.signal.aborted) {
        await this.waitForPlayback();
      }
      if (generatedText) {
        return generatedText;
      }
    })();
    this.assistantPromise = generation;

    try {
      return await generation;
    } catch (error) {
      tts.cancel();
      if (controller.signal.aborted) {
        return;
      }
      throw error;
    } finally {
      if (this.assistantAbort === controller) {
        this.assistantAbort = null;
      }
      if (this.activeTts === tts) {
        this.activeTts = null;
      }
      if (this.assistantPromise === generation) {
        this.assistantPromise = null;
      }
      if (!controller.signal.aborted) {
        this.assistantSpeaking = false;
      }
      if (this.hangupAfterPlayback && !this.closed) {
        this.close();
      }
    }
  }

  async waitForPlayback() {
    if (this.closed) {
      return;
    }
    const name = crypto.randomUUID();
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.markWaiters.delete(name);
        reject(new Error("Timed out waiting for Twilio to play streamed audio."));
      }, 30000);
      this.markWaiters.set(name, () => {
        clearTimeout(timer);
        resolve();
      });
      sendJson(this.twilioSocket, {
        event: "mark",
        streamSid: this.streamSid,
        mark: { name }
      });
    });
  }

  resolveMark(name) {
    const resolve = this.markWaiters.get(name);
    if (!resolve) {
      return;
    }
    this.markWaiters.delete(name);
    resolve();
    if (this.assistantSpeaking) {
      this.assistantSpeaking = false;
    }
  }

  interruptAssistant() {
    if (!this.assistantAbort || this.assistantAbort.signal.aborted) {
      return;
    }
    this.assistantAbort.abort();
    this.activeTts?.cancel();
    this.assistantSpeaking = false;
    sendJson(this.twilioSocket, {
      event: "clear",
      streamSid: this.streamSid
    });
  }

  close() {
    if (this.closed) {
      return;
    }
    this.closed = true;
    clearTimeout(this.startTimeout);
    clearTimeout(this.transcriptTimer);
    this.interruptAssistant();
    for (const resolve of this.markWaiters.values()) {
      resolve();
    }
    this.markWaiters.clear();
    if (this.deepgramSocket) {
      if (this.deepgramSocket.readyState === WebSocket.OPEN) {
        this.deepgramSocket.close(1000);
      } else if (this.deepgramSocket.readyState === WebSocket.CONNECTING) {
        this.deepgramSocket.terminate();
      }
    }
    if (
      this.twilioSocket.readyState === WebSocket.OPEN
      || this.twilioSocket.readyState === WebSocket.CONNECTING
    ) {
      this.twilioSocket.close(1000);
    }
  }

  stop() {
    if (this.closed) {
      return;
    }
    this.closed = true;
    clearTimeout(this.startTimeout);
    clearTimeout(this.transcriptTimer);
    this.assistantAbort?.abort();
    this.activeTts?.cancel();
    for (const resolve of this.markWaiters.values()) {
      resolve();
    }
    this.markWaiters.clear();
    if (this.deepgramSocket) {
      if (this.deepgramSocket.readyState === WebSocket.OPEN) {
        this.deepgramSocket.close(1000);
      } else if (this.deepgramSocket.readyState === WebSocket.CONNECTING) {
        this.deepgramSocket.terminate();
      }
    }
  }
}
