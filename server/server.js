/*
import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import { GoogleGenAI } from "@google/genai";

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3000;

app.use(
  cors({
    origin: "http://localhost:5173",
  })
);

app.use(express.json());

if (!process.env.GEMINI_API_KEY) {
  console.error("GEMINI_API_KEY .env file mein missing hai.");
  process.exit(1);
}

const ai = new GoogleGenAI({
  apiKey: process.env.GEMINI_API_KEY,
  httpOptions: { apiVersion: "v1alpha" },
});

app.get("/", (req, res) => {
  res.json({
    message: "Voice AI Agent backend is running!",
    status: "OK",
  });
});

app.post("/api/token", async (req, res) => {
  try {
    const expireTime = new Date(
      Date.now() + 30 * 60 * 1000
    ).toISOString();

    const newSessionExpireTime = new Date(
      Date.now() + 60 * 1000
    );

    const token = await ai.authTokens.create({
      config: {
        uses: 1,
        expireTime,
        newSessionExpireTime,
        liveConnectConstraints: {
          model: "gemini-3.8-live",
          config: {
            responseModalities: ["AUDIO"],
            systemInstruction: {
              parts: [
                {
                  text:
                    "You are a friendly general-purpose AI voice assistant. " +
                    "Speak naturally and concisely. Understand Hindi, Hinglish " +
                    "and English. Reply in the language the user prefers. " +
                    "Be helpful, respectful and honest.",
                },
              ],
            },
          },
        },
      },
    });

    if (!token.name) {
      throw new Error("Gemini did not return an ephemeral token.");
    }

    res.json({
      token: token.name,
      expiresAt: expireTime,
    });
  } catch (error) {
    console.error("Token creation failed:", error.message);

    res.status(500).json({
      error:
        "Gemini token nahi ban saka. API key, model access aur API settings check karo.",
    });
  }
});

app.listen(PORT, () => {
  console.log(`Voice AI backend: http://localhost:${PORT}`);
});
*/


import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import { createServer } from "node:http";
import { WebSocketServer, WebSocket } from "ws";
import { GoogleGenAI } from "@google/genai";

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors({ origin: true }));
app.use(express.json());

if (!process.env.GEMINI_API_KEY) {
  console.error("GEMINI_API_KEY .env file mein missing hai.");
  process.exit(1);
}

const ai = new GoogleGenAI({
  apiKey: process.env.GEMINI_API_KEY,
  httpOptions: { apiVersion: "v1alpha" },
});

const MODEL = "gemini-3.8-live";
const server = createServer(app);

app.get("/", (req, res) => {
  res.json({
    message: "Voice AI Agent backend is running!",
    status: "OK",
    voicebot: "/voicebot",
  });
});

// Existing browser app ka token endpoint
app.post("/api/token", async (req, res) => {
  try {
    const expireTime = new Date(
      Date.now() + 30 * 60 * 1000
    ).toISOString();

    const newSessionExpireTime = new Date(Date.now() + 60 * 1000);

    const token = await ai.authTokens.create({
      config: {
        uses: 1,
        expireTime,
        newSessionExpireTime,
        liveConnectConstraints: {
          model: MODEL,
          config: {
            responseModalities: ["AUDIO"],
            systemInstruction: {
              parts: [{
                text:
                  "You are a friendly AI voice assistant. Speak naturally " +
                  "and concisely. Understand Hindi, Hinglish and English. " +
                  "Reply in the language the caller prefers. Be helpful, " +
                  "respectful and honest.",
              }],
            },
          },
        },
      },
    });

    if (!token.name) {
      throw new Error("Gemini did not return an ephemeral token.");
    }

    res.json({ token: token.name, expiresAt: expireTime });
  } catch (error) {
    console.error("Token creation failed:", error.message);
    res.status(500).json({ error: "Gemini token creation failed." });
  }
});

// Convert PCM16 little-endian bytes to float samples
function pcmToFloat(buffer) {
  const length = Math.floor(buffer.length / 2);
  const samples = new Float32Array(length);

  for (let i = 0; i < length; i++) {
    samples[i] = buffer.readInt16LE(i * 2) / 32768;
  }

  return samples;
}

// Linear sample-rate conversion
function resample(input, fromRate, toRate) {
  if (fromRate === toRate || input.length === 0) return input;

  const outputLength = Math.max(
    1,
    Math.floor(input.length * toRate / fromRate)
  );
  const output = new Float32Array(outputLength);

  for (let i = 0; i < outputLength; i++) {
    const position = i * fromRate / toRate;
    const left = Math.min(Math.floor(position), input.length - 1);
    const right = Math.min(left + 1, input.length - 1);
    const fraction = position - left;

    output[i] =
      input[left] * (1 - fraction) +
      input[right] * fraction;
  }

  return output;
}

function floatToPcmBuffer(samples) {
  const buffer = Buffer.alloc(samples.length * 2);

  for (let i = 0; i < samples.length; i++) {
    const sample = Math.max(-1, Math.min(1, samples[i]));
    const value = sample < 0
      ? Math.round(sample * 32768)
      : Math.round(sample * 32767);

    buffer.writeInt16LE(value, i * 2);
  }

  return buffer;
}

function sendExotelAudio(ws, streamSid, pcmBuffer, state) {
  // Send small 100 ms chunks: 8000 samples/sec * 0.1 sec * 2 bytes
  const chunkBytes = 1600;

  for (let offset = 0; offset < pcmBuffer.length; offset += chunkBytes) {
    if (ws.readyState !== WebSocket.OPEN) return;

    const chunk = pcmBuffer.subarray(
      offset,
      Math.min(offset + chunkBytes, pcmBuffer.length)
    );

    ws.send(JSON.stringify({
      event: "media",
      sequence_number: ++state.sequence,
      stream_sid: streamSid,
      media: {
        chunk: state.chunk++,
        timestamp: String(Date.now() - state.startedAt),
        payload: chunk.toString("base64"),
      },
    }));
  }
}

const voicebotWss = new WebSocketServer({
  server,
  path: "/voicebot",
});

voicebotWss.on("connection", (ws) => {
  console.log("Exotel Voicebot WebSocket connected");

  let session = null;
  let streamSid = null;
  let started = false;

  const state = {
    sequence: 0,
    chunk: 0,
    startedAt: Date.now(),
  };

  async function startGemini() {
    if (started) return;
    started = true;

    try {
      session = await ai.live.connect({
        model: MODEL,
        config: {
          responseModalities: ["AUDIO"],
          systemInstruction: {
            parts: [{
              text:
                "You are answering an incoming phone call. " +
                "Be a friendly, concise AI assistant. Understand Hindi, " +
                "Hinglish and English, and reply in the caller's language. " +
                "Ask one question at a time. Never claim to be a human. " +
                "If you do not know an answer, say so honestly.",
            }],
          },
        },
        callbacks: {
          onopen: () => {
            console.log("Gemini Live connected for phone call");
          },

          onmessage: (message) => {
            const content = message.serverContent;

            if (content?.interrupted) {
              if (ws.readyState === WebSocket.OPEN) {
                ws.send(JSON.stringify({
                  event: "clear",
                  stream_sid: streamSid,
                }));
              }
              return;
            }

            for (const part of content?.modelTurn?.parts || []) {
              const audioData = part.inlineData?.data;
              if (!audioData || !streamSid) continue;

              // Gemini Live audio output is normally PCM16 at 24 kHz.
              const mimeType = part.inlineData.mimeType || "";
              const rateMatch = mimeType.match(/rate=(\d+)/);
              const outputRate = rateMatch
                ? Number(rateMatch[1])
                : 24000;

              const pcmBuffer = Buffer.from(audioData, "base64");
              const floatSamples = pcmToFloat(pcmBuffer);

              // Exotel's default Voicebot media rate is 8 kHz.
              const samples8k = resample(floatSamples, outputRate, 8000);
              const outputPcm = floatToPcmBuffer(samples8k);

              sendExotelAudio(ws, streamSid, outputPcm, state);
            }
          },

          onerror: (event) => {
            console.error(
              "Gemini Live error:",
              event?.message || event
            );
          },

          onclose: (event) => {
            console.log("Gemini Live session closed", event?.reason || "");
          },
        },
      });

      // Ask Gemini to speak first when the call connects.
      session.sendClientContent({
        turns: [{
          role: "user",
          parts: [{
            text:
              "The caller has just connected. Greet them briefly in " +
              "Hindi/Hinglish and ask how you can help.",
          }],
        }],
        turnComplete: true,
      });
    } catch (error) {
      console.error("Could not start Gemini Live:", error.message);
      ws.close(1011, "AI session could not start");
    }
  }

  ws.on("message", async (raw) => {
    let message;

    try {
      message = JSON.parse(raw.toString());
    } catch {
      console.error("Invalid JSON received from Exotel");
      return;
    }

    switch (message.event) {
      case "connected":
        console.log("Exotel sent connected event");
        break;

      case "start":
        streamSid =
          message.stream_sid ||
          message.start?.stream_sid ||
          message.start?.streamSid ||
          null;

        console.log("Exotel stream started:", streamSid || "SID missing");
        await startGemini();
        break;

      case "media": {
        if (!session || !message.media?.payload) return;

        try {
          // Exotel default input: base64 PCM16, mono, 8 kHz.
          const incoming = Buffer.from(message.media.payload, "base64");
          const samples8k = pcmToFloat(incoming);
          const samples16k = resample(samples8k, 8000, 16000);
          const pcm16k = floatToPcmBuffer(samples16k);

          session.sendRealtimeInput({
            audio: {
              data: pcm16k.toString("base64"),
              mimeType: "audio/pcm;rate=16000",
            },
          });
        } catch (error) {
          console.error("Incoming audio processing failed:", error.message);
        }
        break;
      }

      case "dtmf":
        console.log("Caller pressed a key");
        break;

      case "stop":
        console.log("Exotel call/stream stopped");
        try {
          session?.close();
        } catch {}
        session = null;
        break;

      default:
        break;
    }
  });

  ws.on("close", () => {
    console.log("Exotel Voicebot WebSocket disconnected");

    try {
      session?.close();
    } catch {}

    session = null;
  });

  ws.on("error", (error) => {
    console.error("Exotel WebSocket error:", error.message);
  });
});

server.listen(PORT, () => {
  console.log(`Voice AI backend listening on port ${PORT}`);
});
