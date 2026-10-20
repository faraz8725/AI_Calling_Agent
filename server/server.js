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
  console.error("GEMINI_API_KEY Render environment mein missing hai.");
  process.exit(1);
}

const ai = new GoogleGenAI({
  apiKey: process.env.GEMINI_API_KEY,
  httpOptions: { apiVersion: "v1alpha" },
});

const MODEL = "gemini-3.8-live";
const EXOTEL_RATE = 8000;

// Exotel documentation: minimum outbound audio chunk 3200 bytes.
// PCM16 mono at 8 kHz = 16000 bytes/second.
const EXOTEL_CHUNK_BYTES = 3200;

const SYSTEM_INSTRUCTION =
  "You are a friendly AI voice assistant answering a phone call. " +
  "Speak naturally and concisely. Understand Hindi, Hinglish and English. " +
  "Reply in the language the caller prefers. Ask one question at a time. " +
  "Never claim to be human. Be helpful, respectful and honest. " +
  "If you do not know something, say so honestly.";

const server = createServer(app);

app.get("/", (req, res) => {
  res.json({
    message: "Voice AI Agent backend is running!",
    status: "OK",
    voicebot: "/voicebot",
  });
});

// Existing browser voice assistant token endpoint
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
              parts: [{ text: SYSTEM_INSTRUCTION }],
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
      error: "Gemini token creation failed.",
    });
  }
});

// PCM16 little-endian buffer -> Float32 samples
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
  if (fromRate === toRate || input.length === 0) {
    return input;
  }

  const outputLength = Math.max(
    1,
    Math.floor((input.length * toRate) / fromRate)
  );

  const output = new Float32Array(outputLength);

  for (let i = 0; i < outputLength; i++) {
    const position = (i * fromRate) / toRate;
    const left = Math.min(
      Math.floor(position),
      input.length - 1
    );
    const right = Math.min(left + 1, input.length - 1);
    const fraction = position - left;

    output[i] =
      input[left] * (1 - fraction) +
      input[right] * fraction;
  }

  return output;
}

// Float32 samples -> PCM16 little-endian buffer
function floatToPcmBuffer(samples) {
  const buffer = Buffer.alloc(samples.length * 2);

  for (let i = 0; i < samples.length; i++) {
    const sample = Math.max(-1, Math.min(1, samples[i]));
    const value =
      sample < 0
        ? Math.round(sample * 32768)
        : Math.round(sample * 32767);

    buffer.writeInt16LE(value, i * 2);
  }

  return buffer;
}

function sendExotelEvent(ws, event) {
  if (ws.readyState !== WebSocket.OPEN) return;

  ws.send(JSON.stringify(event));
}

// Send only complete, documented-size chunks to Exotel.
function sendExotelAudio(ws, streamSid, pcmBuffer, state) {
  if (!streamSid || ws.readyState !== WebSocket.OPEN) return;

  state.audioBuffer = Buffer.concat([
    state.audioBuffer,
    pcmBuffer,
  ]);

  while (state.audioBuffer.length >= EXOTEL_CHUNK_BYTES) {
    const chunk = state.audioBuffer.subarray(
      0,
      EXOTEL_CHUNK_BYTES
    );

    state.audioBuffer = state.audioBuffer.subarray(
      EXOTEL_CHUNK_BYTES
    );

    sendExotelEvent(ws, {
      event: "media",
      stream_sid: streamSid,
      media: {
        payload: chunk.toString("base64"),
      },
    });
  }
}

// Flush the last partial chunk at the end of a Gemini response.
// Pad with digital silence so the chunk meets the minimum size.
function flushExotelAudio(ws, streamSid, state) {
  if (!state.audioBuffer.length) return;

  if (ws.readyState !== WebSocket.OPEN || !streamSid) {
    state.audioBuffer = Buffer.alloc(0);
    return;
  }

  const remaining = state.audioBuffer;
  const padded = Buffer.alloc(EXOTEL_CHUNK_BYTES);

  remaining.copy(padded);

  state.audioBuffer = Buffer.alloc(0);

  sendExotelEvent(ws, {
    event: "media",
    stream_sid: streamSid,
    media: {
      payload: padded.toString("base64"),
    },
  });
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
  let stopped = false;

  const state = {
    audioBuffer: Buffer.alloc(0),
  };

  async function closeGeminiSession() {
    const currentSession = session;
    session = null;

    if (currentSession) {
      try {
        await currentSession.close();
      } catch (error) {
        console.error(
          "Gemini session close error:",
          error.message
        );
      }
    }
  }

  async function startGemini() {
    if (started || stopped) return;

    started = true;

    try {
      const newSession = await ai.live.connect({
        model: MODEL,
        config: {
          responseModalities: ["AUDIO"],
          systemInstruction: {
            parts: [{ text: SYSTEM_INSTRUCTION }],
          },
        },
        callbacks: {
          onopen: () => {
            console.log("Gemini Live connected for phone call");
          },

          onmessage: (message) => {
            if (stopped || ws.readyState !== WebSocket.OPEN) {
              return;
            }

            const content = message.serverContent;

            if (content?.interrupted) {
              state.audioBuffer = Buffer.alloc(0);

              sendExotelEvent(ws, {
                event: "clear",
                stream_sid: streamSid,
              });

              return;
            }

            for (const part of content?.modelTurn?.parts || []) {
              const audioData = part.inlineData?.data;

              if (!audioData || !streamSid) continue;

              const mimeType = part.inlineData.mimeType || "";
              const rateMatch = mimeType.match(/rate=(\d+)/);

              // Gemini Live audio output is normally PCM16 at 24 kHz.
              const outputRate = rateMatch
                ? Number(rateMatch[1])
                : 24000;

              if (!Number.isFinite(outputRate) || outputRate <= 0) {
                console.error("Invalid Gemini audio sample rate");
                continue;
              }

              const pcmBuffer = Buffer.from(audioData, "base64");

              // Avoid passing an incomplete PCM16 sample.
              const evenLength = pcmBuffer.length - (pcmBuffer.length % 2);
              const validPcm = pcmBuffer.subarray(0, evenLength);

              const floatSamples = pcmToFloat(validPcm);
              const samples8k = resample(
                floatSamples,
                outputRate,
                EXOTEL_RATE
              );

              const outputPcm = floatToPcmBuffer(samples8k);

              sendExotelAudio(
                ws,
                streamSid,
                outputPcm,
                state
              );
            }

            // Finish sending audio when Gemini finishes its response.
            if (content?.turnComplete) {
              flushExotelAudio(ws, streamSid, state);
            }
          },

          onerror: (event) => {
            console.error(
              "Gemini Live error:",
              event?.message || event
            );
          },

          onclose: (event) => {
            console.log(
              "Gemini Live session closed",
              event?.reason || ""
            );
          },
        },
      });

      if (stopped || ws.readyState !== WebSocket.OPEN) {
        try {
          await newSession.close();
        } catch {}

        return;
      }

      session = newSession;

      console.log("Gemini session ready; sending greeting");

      session.sendClientContent({
        turns: [
          {
            role: "user",
            parts: [
              {
                text:
                  "The caller has just connected. Greet them briefly " +
                  "in natural Hindi/Hinglish and ask how you can help.",
              },
            ],
          },
        ],
        turnComplete: true,
      });
    } catch (error) {
      console.error(
        "Could not start Gemini Live:",
        error.message
      );

      if (ws.readyState === WebSocket.OPEN) {
        ws.close(1011, "AI session could not start");
      }
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

        console.log(
          "Exotel stream started:",
          streamSid || "SID missing"
        );

        if (!streamSid) {
          console.error("Exotel start event has no stream SID");
          ws.close(1002, "Missing stream SID");
          return;
        }

        await startGemini();
        break;

      case "media": {
        if (stopped || !message.media?.payload) return;

        const currentSession = session;

        if (!currentSession) {
          // The caller may start speaking while Gemini is connecting.
          return;
        }

        try {
          // Exotel default input: PCM16 mono, 8 kHz.
          const incoming = Buffer.from(
            message.media.payload,
            "base64"
          );

          const evenLength = incoming.length - (incoming.length % 2);
          const validIncoming = incoming.subarray(0, evenLength);

          const samples8k = pcmToFloat(validIncoming);
          const samples16k = resample(samples8k, 8000, 16000);
          const pcm16k = floatToPcmBuffer(samples16k);

          currentSession.sendRealtimeInput({
            audio: {
              data: pcm16k.toString("base64"),
              mimeType: "audio/pcm;rate=16000",
            },
          });
        } catch (error) {
          console.error(
            "Incoming audio processing failed:",
            error.message
          );
        }

        break;
      }

      case "dtmf":
        console.log(
          "Caller pressed a key:",
          message.dtmf?.digit || "unknown"
        );
        break;

      case "stop":
        console.log(
          "Exotel call/stream stopped:",
          message.stop?.reason || ""
        );

        stopped = true;
        state.audioBuffer = Buffer.alloc(0);

        await closeGeminiSession();
        break;

      default:
        break;
    }
  });

  ws.on("close", async () => {
    console.log("Exotel Voicebot WebSocket disconnected");

    stopped = true;
    state.audioBuffer = Buffer.alloc(0);

    await closeGeminiSession();
  });

  ws.on("error", (error) => {
    console.error("Exotel WebSocket error:", error.message);
  });
});

server.listen(PORT, () => {
  console.log(`Voice AI backend listening on port ${PORT}`);
});
