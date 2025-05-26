// server.js  – WhatsApp voice-translator backend (Twilio + Supabase)
// ---------------------------------------------------------------

import express from "express";
import bodyParser from "body-parser";
import fetch from "node-fetch";
import ffmpeg from "fluent-ffmpeg";
import fs from "fs";
import OpenAI from "openai";
import { createClient } from "@supabase/supabase-js";
import twilio from "twilio";
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
  TWILIO_PHONE_NUMBER,          // e.g. whatsapp:+14155238886
  FREE_CREDITS_PER_USER = 30,
  PORT = 8080                   // Railway uses 8080
} = process.env;

// ─── Clients
const supabase     = createClient(SUPABASE_URL, SUPABASE_KEY);
const openai       = new OpenAI({ apiKey: OPENAI_API_KEY });
const twilioClient = twilio(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN);

// ─── Helper: convert .ogg → .wav (mono, 16 kHz)
function convertAudio(inputPath, outputPath) {
  return new Promise((resolve, reject) => {
    ffmpeg(inputPath)
      .outputOptions(["-ac", "1", "-ar", "16000", "-f", "wav"])
      .on("error", reject)
      .on("end", () => resolve(outputPath))
      .save(outputPath);
  });
}

// ─── Helper: Whisper transcription
async function transcribeAudio(wavPath) {
  const response = await openai.audio.transcriptions.create({
    model: "whisper-1",
    file : fs.createReadStream(wavPath)
  });
  return { text: response.text, lang: response.language };
}

// ─── Helper: Google Translate
async function translateText(text, targetLang = "es") {
  const url = `https://translation.googleapis.com/language/translate/v2?key=${GOOGLE_TRANSLATE_KEY}`;
  const res = await fetch(url, {
    method : "POST",
    headers: { "Content-Type": "application/json" },
    body   : JSON.stringify({ q: text, target: targetLang })
  });
  const data = await res.json();
  return data.data.translations[0].translatedText;
}

// ─── Helper: credit management
async function decrementCredit(phone) {
  const { data: user, error } =
    await supabase.from("users").select("credits_remaining").eq("phone_number", phone).single();

  if (error && error.code !== "PGRST116") throw error;   // real DB error

  if (!user) {                                           // first-time user
    await supabase.from("users").insert({
      phone_number     : phone,
      credits_remaining: FREE_CREDITS_PER_USER - 1
    });
    return FREE_CREDITS_PER_USER - 1;
  }

  if (user.credits_remaining <= 0) return -1;            // no credits left

  const newCredits = user.credits_remaining - 1;
  await supabase.from("users").update({ credits_remaining: newCredits })
               .eq("phone_number", phone);
  return newCredits;
}

// ─── Helper: WhatsApp reply
function replyWhatsApp(to, body) {
  return twilioClient.messages.create({
    from: `whatsapp:${TWILIO_PHONE_NUMBER}`,
    to,
    body
  });
}

// ─── Express server
const app = express();
app.use(bodyParser.urlencoded({ extended: false }));
app.use(bodyParser.json());

// ─── Webhook route
app.post("/webhook", async (req, res) => {
  // 1) Acknowledge Twilio immediately
  res.sendStatus(200);

  try {
    const from     = req.body.From;          // "whatsapp:+506..."
    const mediaUrl = req.body.MediaUrl0;
    if (!mediaUrl) return;                   // ignore non-voice messages

    // 2) Credit check
    const credits = await decrementCredit(from);
    if (credits < 0) {
      await replyWhatsApp(
        from,
        "🚫 You’ve used all free translations. Reply PRO for unlimited ($5/mo)."
      );
      return;
    }

    // 3) ---------- DOWNLOAD WITH BASIC AUTH (fixed) ----------
    const authHeader =
      "Basic " +
      Buffer.from(`${TWILIO_ACCOUNT_SID}:${TWILIO_AUTH_TOKEN}`).toString("base64");

    const inputPath  = `/tmp/input_${Date.now()}.ogg`;
    const outputPath = `/tmp/output_${Date.now()}.wav`;

    const audioRes = await fetch(mediaUrl, {
      headers: { Authorization: authHeader }
    });
    if (!audioRes.ok) throw new Error("Failed to fetch media: " + audioRes.status);
    fs.writeFileSync(inputPath, await audioRes.buffer());
    // ---------------------------------------------------------

    // 4) Convert, transcribe, translate
    await convertAudio(inputPath, outputPath);
    const { text: transcript, lang } = await transcribeAudio(outputPath);
    const targetLang  = lang === "es" ? "en" : "es";
    const translated  = await translateText(transcript, targetLang);

    // 5) Log to DB
    await supabase.from("translations").insert({
      phone_number   : from,
      original_text  : transcript,
      translated_text: translated,
      language_from  : lang,
      language_to    : targetLang
    });

    // 6) Reply
    await replyWhatsApp(
      from,
      `🎤 Heard:\n${transcript}\n\n🌎 Translated:\n${translated}`
    );
  } catch (err) {
    console.error("Webhook error:", err);
    if (req.body?.From)
      await replyWhatsApp(
        req.body.From,
        "⚠️ Error processing that note. Try again in a moment."
      );
  }
});

// health check for Railway
app.get("/healthz", (_, res) => res.status(200).send("OK"));
app.listen(PORT, () => console.log(`🚀 Server listening on ${PORT}`));
