import WebSocket from "ws";

const DEEPGRAM_ENDPOINT = "wss://api.deepgram.com/v1/listen";
const ELEVENLABS_ENDPOINT = "wss://api.elevenlabs.io/v1/text-to-speech";

export function createDeepgramUrl(language) {
  const url = new URL(DEEPGRAM_ENDPOINT);
  url.searchParams.set("model", "nova-3");
  url.searchParams.set("language", language);
  url.searchParams.set("encoding", "mulaw");
  url.searchParams.set("sample_rate", "8000");
  url.searchParams.set("channels", "1");
  url.searchParams.set("interim_results", "true");
  url.searchParams.set("endpointing", "300");
  url.searchParams.set("utterance_end_ms", "1000");
  return url.toString();
}

function waitForOpen(socket, timeoutMs = 12000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      socket.terminate();
      reject(new Error("Timed out while connecting to a voice provider."));
    }, timeoutMs);

    socket.once("open", () => {
      clearTimeout(timer);
      resolve();
    });
    socket.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    socket.once("close", (code) => {
      clearTimeout(timer);
      reject(new Error(`Voice provider closed the connection before opening (${code}).`));
    });
  });
}

export async function streamDeepSeekReply({
  apiKey,
  model,
  messages,
  signal,
  onDelta,
  fetchImpl = fetch
}) {
  const requestController = new AbortController();
  const abortRequest = () => requestController.abort(signal?.reason);
  if (signal?.aborted) {
    abortRequest();
  } else {
    signal?.addEventListener("abort", abortRequest, { once: true });
  }
  const timeout = setTimeout(() => requestController.abort(), 30000);
  try {
    const response = await fetchImpl("https://api.deepseek.com/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        model,
        messages,
        max_tokens: 250,
        temperature: 0.6,
        stream: true
      }),
      signal: requestController.signal
    });
    if (!response.ok) {
      const details = (await response.text()).slice(0, 500);
      throw new Error(`DeepSeek API failed (${response.status}): ${details}`);
    }
    if (!response.body) {
      throw new Error("DeepSeek API response has no streaming body.");
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let output = "";
    let finished = false;

    const handleLine = (line) => {
      if (!line.startsWith("data:")) {
        return;
      }
      const data = line.slice(5).trim();
      if (!data) {
        return;
      }
      if (data === "[DONE]") {
        finished = true;
        return;
      }

      let event;
      try {
        event = JSON.parse(data);
      } catch (error) {
        throw new Error(`DeepSeek returned invalid streaming JSON: ${error.message}`);
      }
      const delta = event.choices?.[0]?.delta?.content;
      if (typeof delta === "string" && delta) {
        output += delta;
        onDelta(delta);
      }
    };

    try {
      while (!finished) {
        const { done, value } = await reader.read();
        if (done) {
          buffer += decoder.decode();
          break;
        }

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split(/\r?\n/);
        buffer = lines.pop() || "";
        for (const line of lines) {
          handleLine(line);
          if (finished) {
            break;
          }
        }
      }
      if (buffer) {
        handleLine(buffer);
      }
    } finally {
      if (!finished) {
        await reader.cancel().catch(() => {});
      }
    }

    if (!output.trim()) {
      throw new Error("DeepSeek API returned an empty response.");
    }
    return output.trim();
  } finally {
    clearTimeout(timeout);
    signal?.removeEventListener("abort", abortRequest);
  }
}

export class ElevenLabsTtsStream {
  constructor({ apiKey, voiceId, onAudio, WebSocketImpl = WebSocket }) {
    const url = new URL(`${ELEVENLABS_ENDPOINT}/${encodeURIComponent(voiceId)}/stream-input`);
    url.searchParams.set("model_id", "eleven_turbo_v2_5");
    url.searchParams.set("output_format", "ulaw_8000");
    url.searchParams.set("language_code", "en");
    url.searchParams.set("inactivity_timeout", "180");

    this.onAudio = onAudio;
    this.failure = null;
    this.finished = false;
    this.done = new Promise((resolve, reject) => {
      this.resolveDone = resolve;
      this.rejectDone = reject;
    });
    this.done.catch(() => {});
    this.socket = new WebSocketImpl(url, {
      headers: { "xi-api-key": apiKey }
    });
    this.socket.on("message", (raw) => this.handleMessage(raw));
    this.socket.on("error", (error) => this.fail(error));
    this.socket.on("close", (code) => {
      if (!this.finished && !this.failure) {
        this.fail(new Error(`ElevenLabs closed the speech stream (${code}).`));
      }
    });
    this.ready = waitForOpen(this.socket);
  }

  async open() {
    await this.ready;
    this.socket.send(JSON.stringify({
      text: " ",
      voice_settings: { stability: 0.5, similarity_boost: 0.75 },
      generation_config: { chunk_length_schedule: [50, 120, 160, 250] }
    }));
  }

  handleMessage(raw) {
    let message;
    try {
      message = JSON.parse(raw.toString());
    } catch (error) {
      this.fail(new Error(`ElevenLabs returned invalid streaming JSON: ${error.message}`));
      return;
    }

    if (message.error) {
      this.fail(new Error(`ElevenLabs TTS failed: ${message.error}`));
      return;
    }
    if (message.audio) {
      try {
        this.onAudio(message.audio);
      } catch (error) {
        this.fail(error);
        return;
      }
    }
    if (message.isFinal) {
      this.finished = true;
      this.resolveDone();
    }
  }

  fail(error) {
    if (this.failure || this.finished) {
      return;
    }
    this.failure = error;
    this.rejectDone(error);
  }

  sendText(text) {
    if (!text || this.failure || this.socket.readyState !== WebSocket.OPEN) {
      return;
    }
    this.socket.send(JSON.stringify({
      text,
      try_trigger_generation: true
    }));
  }

  async finish() {
    await this.ready;
    if (this.failure) {
      throw this.failure;
    }
    if (this.socket.readyState === WebSocket.OPEN) {
      this.socket.send(JSON.stringify({ text: "" }));
    }
    let timer;
    try {
      await Promise.race([
        this.done,
        new Promise((_, reject) => {
          timer = setTimeout(() => reject(new Error("Timed out while streaming speech audio.")), 45000);
        })
      ]);
    } finally {
      clearTimeout(timer);
    }
  }

  cancel() {
    this.finished = true;
    if (
      this.socket.readyState === WebSocket.OPEN
      || this.socket.readyState === WebSocket.CONNECTING
    ) {
      this.socket.terminate();
    }
    this.resolveDone();
  }
}

export function extractSpeakableChunks(buffer, final = false) {
  const chunks = [];
  let remaining = buffer;

  while (remaining) {
    const sentenceEnd = remaining.search(/[.!?](?:["')\]]*)\s/);
    if (sentenceEnd >= 0) {
      const match = remaining.match(/[.!?](?:["')\]]*)\s/);
      const end = sentenceEnd + match[0].length;
      chunks.push(remaining.slice(0, end).trim());
      remaining = remaining.slice(end);
      continue;
    }

    if (remaining.length >= 100) {
      const cut = remaining.lastIndexOf(" ", 100);
      if (cut >= 40) {
        chunks.push(remaining.slice(0, cut).trim());
        remaining = remaining.slice(cut + 1);
        continue;
      }
    }
    break;
  }

  if (final && remaining.trim()) {
    chunks.push(remaining.trim());
    remaining = "";
  }
  return { chunks, remainder: remaining };
}
