
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
