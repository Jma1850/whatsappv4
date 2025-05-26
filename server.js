// server.js – Sandbox-ready WhatsApp voice translator
import express from "express";
import bodyParser from "body-parser";
import fetch from "node-fetch";
import ffmpeg from "fluent-ffmpeg";
import fs from "fs";
import OpenAI from "openai";
import { createClient } from "@supabase/supabase-js";
import dotenv from "dotenv";
dotenv.config();

// ─── ENV
const {
  SUPABASE_URL,
  SUPABASE_KEY,
  OPENAI_API_KEY,
  GOOGLE_TRANSLATE_KEY,
  TWILIO_ACCOUNT_SID,
  TWILIO_AUTH_TOKEN,
  FREE_CREDITS_PER_USER = 30,
  PORT = 8080
} = process.env;

// ─── Clients
const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);
const openai = new OpenAI({ apiKey: OPENAI_API_KEY });

// ─── Convert .ogg → .wav
function convertAudio(inputPath, outputPath) {
  return new Promise((resolve, reject) => {
    ffmpeg(inputPath)
      .outputOptions(["-ac", "1", "-ar", "16000", "-f", "wav"])
      .on("error", reject)
      .on("end", () => resolve(outputPath))
      .save(outputPath);
  });
}

// ─── Transcription
async function transcribeAudio(wavPath) {
  const response = await openai.audio.transcriptions.create({
    model: "whisper-1",
    file: fs.createReadStream(wavPath),
  });
  return { text: response.text, lang: response.language };
}

// ─── Translation
async function translateText(text, targetLang = "es") {
  const url = `https://translation.googleapis.com/language/translate/v2?key=${GOOGLE_TRANSLATE_KEY}`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ q: text, target: targetLang }),
  });
  const data = await res.json();
  return data.data.translations[0].translatedText;
}

// ─── Credit Management
async function decrementCredit(phone) {
  const { data: user, error } = await supabase
    .from("users")
    .select("credits_remaining")
    .eq("phone_number", phone)
    .single();

  if (error && error.code !== "PGRST116") throw error;

  if (!user) {
    await supabase.from("users").insert({
      phone_number: phone,
      credits_remaining: FREE_CREDITS_PER_USER - 1,
    });
    return FREE_CREDITS_PER_USER - 1;
  }

  if (user.credits_remaining <= 0) return -1;

  const newCredits = user.credits_remaining - 1;
  await supabase
    .from("users")
    .update({ credits_remaining: newCredits })
    .eq("phone_number", phone);
  return newCredits;
}

// ─── Express App
const app = express();
app.use(bodyParser.urlencoded({ extended: false }));
app.use(bodyParser.json());

// ─── Webhook Route
app.post("/webhook", async (req, res) => {
  const from = req.body.From;
  const mediaUrl = req.body.MediaUrl0;

  if (!mediaUrl || !from) return res.sendStatus(400);

  try {
    const credits = await decrementCredit(from);
    if (credits < 0) {
      res.set("Content-Type", "text/xml");
      return res.send(`
        <Response>
          <Message>🚫 You've used all free translations. Reply PRO to upgrade.</Message>
        </Response>
      `);
    }

    // Authenticated media download
    const authHeader =
      "Basic " +
      Buffer.from(`${TWILIO_ACCOUNT_SID}:${TWILIO_AUTH_TOKEN}`).toString("base64");

    const inputPath = `/tmp/input_${Date.now()}.ogg`;
    const outputPath = `/tmp/output_${Date.now()}.wav`;

    const audioRes = await fetch(mediaUrl, {
      headers: { Authorization: authHeader },
    });

    if (!audioRes.ok) throw new Error("Failed to fetch media: " + audioRes.status);
    fs.writeFileSync(inputPath, await audioRes.buffer());

    // Process
    await convertAudio(inputPath, outputPath);
    const { text: transcript, lang } = await transcribeAudio(outputPath);
    const targetLang = lang === "es" ? "en" : "es";
    const translated = await translateText(transcript, targetLang);

    // Log
    await supabase.from("translations").insert({
      phone_number: from,
      original_text: transcript,
      translated_text: translated,
      language_from: lang,
      language_to: targetLang,
    });

    // Twilio sandbox-compatible reply
    res.set("Content-Type", "text/xml");
    return res.send(`
      <Response>
        <Message>
🎤 Heard: ${transcript}

🌎 Translated: ${translated}
        </Message>
      </Response>
    `);
  } catch (err) {
    console.error("Webhook error:", err);
    res.set("Content-Type", "text/xml");
    return res.send(`
      <Response>
        <Message>⚠️ Error processing voice note. Try again later.</Message>
      </Response>
    `);
  }
});

// ─── Health Check
app.get("/healthz", (_, res) => res.status(200).send("OK"));
app.listen(PORT, () => console.log(`🚀 Server listening on ${PORT}`));
