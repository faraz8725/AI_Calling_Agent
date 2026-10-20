
import { useRef, useState } from "react";
import { GoogleGenAI } from "@google/genai";
import "./App.css";

const MODEL = "gemini-3.8-live";

function pcmToBase64(float32) {
  const buffer = new ArrayBuffer(float32.length * 2);
  const view = new DataView(buffer);

  for (let i = 0; i < float32.length; i++) {
    const sample = Math.max(-1, Math.min(1, float32[i]));
    view.setInt16(i * 2, sample < 0 ? sample * 32768 : sample * 32767, true);
  }

  const bytes = new Uint8Array(buffer);
  let binary = "";

  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }

  return btoa(binary);
}

function resample(input, fromRate, toRate) {
  if (fromRate === toRate) return input;

  const ratio = fromRate / toRate;
  const output = new Float32Array(Math.floor(input.length / ratio));

  for (let i = 0; i < output.length; i++) {
    const start = Math.floor(i * ratio);
    const end = Math.min(Math.floor((i + 1) * ratio), input.length);
    let sum = 0;
    let count = 0;

    for (let j = start; j < end; j++) {
      sum += input[j];
      count++;
    }

    output[i] = count ? sum / count : 0;
  }

  return output;
}

function decodeBase64(base64) {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);

  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }

  return bytes;
}

function App() {
  const [status, setStatus] = useState("Ready to talk");
  const [connected, setConnected] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const sessionRef = useRef(null);
  const streamRef = useRef(null);
  const contextRef = useRef(null);
  const sourceRef = useRef(null);
  const processorRef = useRef(null);
  const nextPlayTimeRef = useRef(0);
  const sourcesRef = useRef(new Set());

  function stopPlayback() {
    sourcesRef.current.forEach((source) => {
      try {
        source.stop();
      } catch {
        // Already stopped.
      }
    });

    sourcesRef.current.clear();

    if (contextRef.current) {
      nextPlayTimeRef.current = contextRef.current.currentTime;
    }
  }

  async function endCall() {
    setBusy(false);
    setConnected(false);
    setStatus("Call ended");

    try {
      sessionRef.current?.close();
    } catch {
      // Session may already be closed.
    }

    sessionRef.current = null;

    if (processorRef.current) {
      processorRef.current.onaudioprocess = null;
      processorRef.current.disconnect();
      processorRef.current = null;
    }

    sourceRef.current?.disconnect();
    sourceRef.current = null;

    streamRef.current?.getTracks().forEach((track) => track.stop());
    streamRef.current = null;

    stopPlayback();

    if (contextRef.current) {
      await contextRef.current.close().catch(() => {});
      contextRef.current = null;
    }
  }

  async function startCall() {
    if (busy) return;

    setBusy(true);
    setError("");
    setStatus("Connecting to Gemini...");

    try {
      const tokenResponse = await fetch("http://localhost:3000/api/token", {
        method: "POST",
      });

      if (!tokenResponse.ok) {
        throw new Error("Token nahi bana. Backend aur Gemini API key check karo.");
      }

      const { token } = await tokenResponse.json();

      const audioContext = new AudioContext();
      contextRef.current = audioContext;
      await audioContext.resume();

      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          channelCount: 1,
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
      });

      streamRef.current = stream;

      const ai = new GoogleGenAI({
        apiKey: token,
        httpOptions: { apiVersion: "v1alpha" },
      });

      const session = await ai.live.connect({
        model: MODEL,
        config: {
          responseModalities: ["AUDIO"],
          systemInstruction: {
            parts: [{
              text:
                "You are a friendly general-purpose AI voice assistant. " +
                "Speak naturally and concisely. Understand Hindi, Hinglish " +
                "and English. Reply in the language the user prefers. " +
                "Be helpful, respectful and honest.",
            }],
          },
        },
        callbacks: {
          onopen: () => {
            setConnected(true);
            setBusy(false);
            setStatus("Listening — speak naturally");
          },
          onmessage: (message) => {
            const content = message.serverContent;

            if (content?.interrupted) {
              stopPlayback();
              setStatus("Listening...");
              return;
            }

            const parts = content?.modelTurn?.parts || [];

            for (const part of parts) {
              if (!part.inlineData?.data) continue;

              const bytes = decodeBase64(part.inlineData.data);
              const samples = new Int16Array(
                bytes.buffer,
                bytes.byteOffset,
                Math.floor(bytes.byteLength / 2)
              );

              const floatSamples = new Float32Array(samples.length);

              for (let i = 0; i < samples.length; i++) {
                floatSamples[i] = samples[i] / 32768;
              }

              const ctx = contextRef.current;
              if (!ctx || ctx.state === "closed") continue;

              const audioBuffer = ctx.createBuffer(
                1,
                floatSamples.length,
                24000
              );

              audioBuffer.copyToChannel(floatSamples, 0);

              const audioSource = ctx.createBufferSource();
              audioSource.buffer = audioBuffer;
              audioSource.connect(ctx.destination);

              const startAt = Math.max(
                ctx.currentTime + 0.03,
                nextPlayTimeRef.current
              );

              audioSource.start(startAt);
              nextPlayTimeRef.current = startAt + audioBuffer.duration;

              sourcesRef.current.add(audioSource);
              audioSource.onended = () => sourcesRef.current.delete(audioSource);

              setStatus("AI is speaking...");
            }

            if (content?.turnComplete) {
              setStatus("Listening — speak naturally");
            }
          },
          onerror: (event) => {
            setError(event?.message || "Gemini connection mein error aaya.");
            setStatus("Connection error");
            setBusy(false);
          },
          onclose: () => {
            setConnected(false);
            setBusy(false);
            setStatus("Connection closed");
          },
        },
      });

      sessionRef.current = session;

      const source = audioContext.createMediaStreamSource(stream);
      sourceRef.current = source;

      const processor = audioContext.createScriptProcessor(4096, 1, 1);
      processorRef.current = processor;

      processor.onaudioprocess = (event) => {
        const output = event.outputBuffer.getChannelData(0);
        output.fill(0);

        if (!sessionRef.current) return;

        const input = event.inputBuffer.getChannelData(0);
        const pcm = resample(input, audioContext.sampleRate, 16000);

        sessionRef.current.sendRealtimeInput({
          audio: {
            data: pcmToBase64(pcm),
            mimeType: "audio/pcm;rate=16000",
          },
        });
      };

      source.connect(processor);
      processor.connect(audioContext.destination);
    } catch (err) {
      console.error(err);
      setError(err.message || "Microphone ya connection mein problem aayi.");
      setStatus("Unable to connect");
      await endCall();
    }
  }

  return (
    <main className="app">
      <header className="topbar">
        <div className="brand">
          <span className="brand-icon">✳</span>
          <span>Voice<span className="brand-accent">Mate</span></span>
        </div>
        <span className="top-label">AI VOICE ASSISTANT</span>
      </header>

      <section className="hero">
        <span className="eyebrow">
          <span className="live-dot" /> YOUR PERSONAL AI
        </span>

        <h1>Just talk.<br /><span>We'll figure it out.</span></h1>

        <p className="subtitle">
          Ask anything, share an idea, or just have a conversation.
          I'm here to listen.
        </p>

        <div className={`voice-orb ${connected ? "active" : ""}`}>
          <div className="orb-ring ring-one" />
          <div className="orb-ring ring-two" />
          <div className="orb-core">✳</div>
        </div>

        <div className="status">{status}</div>
        <div className="hint">
          {connected
            ? "Your microphone is on. Start speaking."
            : "Start a conversation whenever you're ready."}
        </div>

        <div className="controls">
          {!connected ? (
            <button
              className="start-button"
              onClick={startCall}
              disabled={busy}
            >
              <span>🎙</span> {busy ? "Connecting..." : "Start talking"}
            </button>
          ) : (
            <button className="end-button" onClick={endCall}>
              <span>■</span> End conversation
            </button>
          )}
        </div>

        {error && <p className="error">{error}</p>}
        <p className="privacy">Microphone access is requested only when you start.</p>
      </section>

      <footer>
        <span>Powered by Gemini</span>
        <span>Built for natural conversations</span>
      </footer>
    </main>
  );
}

export default App;
