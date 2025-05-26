// server.js – Smart WhatsApp Translator Bot (stable braces & onboarding)
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

// ------------------------------------------------------------------
// ENV
// ------------------------------------------------------------------
const {
  SUPABASE_URL,
  SUPABASE_KEY,
  OPENAI_API_KEY,
  GOOGLE_TRANSLATE_KEY,
  GOOGLE_TTS_KEY,
  TWILIO_ACCOUNT_SID,
  TWILIO_AUTH_TOKEN,
  TWILIO_PHONE_NUMBER,
  PORT = 8080
} = process.env;

// ------------------------------------------------------------------
// CLIENTS
// ------------------------------------------------------------------
const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);
const openai = new OpenAI({ apiKey: OPENAI_API_KEY });
const twilioClient = twilio(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN);

// ------------------------------------------------------------------
// CONSTANTS
// ------------------------------------------------------------------
const LANGUAGE_OPTIONS = {
  1: { name: "English", code: "en" },
  2: { name: "Spanish", code: "es" },
  3: { name: "French", code: "fr" },
  4: { name: "Portuguese", code: "pt" }
};

// ------------------------------------------------------------------
// HELPERS
// ------------------------------------------------------------------
const matchChoice = (input = "") => {
  const clean = input.trim().toLowerCase();
  // numeric choice (handles "1", "1️⃣", etc.)
  const num = clean.match(/^[0-9]/)?.[0];
  if (num && LANGUAGE_OPTIONS[num]) return [num, LANGUAGE_OPTIONS[num]];
  // text or language code
  return Object.entries(LANGUAGE_OPTIONS).find(([k, v]) =>
    clean === v.code || clean === v.name.toLowerCase()
  );
};

function convertAudio(input, output) {
  return new Promise((resolve, reject) => {
    ffmpeg(input)
      .audioCodec("pcm_s16le")
      .outputOptions(["-ac", "1", "-ar", "16000", "-f", "wav"])
      .on("error", reject)
      .on("end", () => resolve(output))
      .save(output);
  });
}

async function transcribeAudio(path) {
  const res = await openai.audio.transcriptions.create({
    model: "whisper-1",
    file: fs.createReadStream(path),
    response_format: "json",
    language: "auto"
  });
  return res.text;
}

async function translateText(text, target) {
  const url = `https://translation.googleapis.com/language/translate/v2?key=${GOOGLE_TRANSLATE_KEY}`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ q: text, target })
  });
  return (await res.json()).data.translations[0].translatedText;
}

async function tts(text, lang) {
  const res = await fetch(`https://texttospeech.googleapis.com/v1/text:synthesize?key=${GOOGLE_TTS_KEY}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      input: { text },
      voice: { languageCode: lang, ssmlGender: "FEMALE" },
      audioConfig: { audioEncoding: "MP3" }
    })
  });
  const data = await res.json();
  const file = `/tmp/tts_${Date.now()}.mp3`;
  fs.writeFileSync(file, Buffer.from(data.audioContent, "base64"));
  return file;
}

async function uploadPublic(filePath) {
  const filename = `tts_${Date.now()}.mp3`;
  const data = fs.readFileSync(filePath);
  await supabase.storage.from("tts-voices").upload(filename, data, { contentType: "audio/mpeg", upsert: true });
  return `${SUPABASE_URL}/storage/v1/object/public/tts-voices/${filename}`;
}

// ------------------------------------------------------------------
// EXPRESS SETUP
// ------------------------------------------------------------------
const app = express();
app.use(bodyParser.urlencoded({ extended: false }));
app.use(bodyParser.json());

app.post("/webhook", async (req, res) => {
  const from = req.body.From;
  const bodyText = req.body.Body?.trim();
  const mediaUrl = req.body.MediaUrl0;
  const mediaType = req.body.MediaContentType0;

  try {
    // fetch user or create placeholder
    let { data: user } = await supabase
      .from("users")
      .select("source_lang,target_lang,language_step")
      .eq("phone_number", from)
      .single();

    if (!user) {
      await supabase.from("users").insert({ phone_number: from, language_step: "source" });
      user = { language_step: "source" };
    }

    // ---------------- ONBOARDING ----------------
    if (user.language_step === "source") {
      const m = matchChoice(bodyText);
      if (m) {
        const [, src] = m;
        await supabase.from("users").update({ source_lang: src.code, language_step: "target" }).eq("phone_number", from);
        let prompt = "✅ Got it! What language should I translate messages into?\n\n";
        for (const [k, v] of Object.entries(LANGUAGE_OPTIONS)) prompt += `${k}️⃣ ${v.name} (${v.code})\n`;
        return res.send(`<Response><Message>${prompt}</Message></Response>`);
      }
      // re-prompt
      let prompt = "👋 Welcome! What language are the messages you're receiving in?\n\n";
      for (const [k, v] of Object.entries(LANGUAGE_OPTIONS)) prompt += `${k}️⃣ ${v.name} (${v.code})\n`;
      return res.send(`<Response><Message>${prompt}</Message></Response>`);
    }

    if (user.language_step === "target") {
      const m = matchChoice(bodyText);
      if (m) {
        const [, tgt] = m;
        await supabase.from("users").update({ target_lang: tgt.code, language_step: "done" }).eq("phone_number", from);
        return res.send(`<Response><Message>✅ You're all set! Send a voice note or text to translate.</Message></Response>`);
      }
      let prompt = "⚠️ Please choose the language I should translate into:\n\n";
      for (const [k, v] of Object.entries(LANGUAGE_OPTIONS)) prompt += `${k}️⃣ ${v.name} (${v.code})\n`;
      return res.send(`<Response><Message>${prompt}</Message></Response>`);
    }

    // ---------------- TRANSLATION ----------------
    const { source_lang, target_lang } = user;

    // voice note
    if (mediaUrl && mediaType?.startsWith("audio")) {
      const auth = "Basic " + Buffer.from(`${TWILIO_ACCOUNT_SID}:${TWILIO_AUTH_TOKEN}`).toString("base64");
      const raw = `/tmp/raw_${Date.now()}`;
      const wav = `/tmp/wav_${Date.now()}.wav`;
      const aRes = await fetch(mediaUrl, { headers: { Authorization: auth } });
      fs.writeFileSync(raw, await aRes.buffer());
      await convertAudio(raw, wav);
      const originalText = await transcribeAudio(wav);
      const translated = await translateText(originalText, target_lang);
      const speechFile = await tts(translated, target_lang);
      const publicUrl = await uploadPublic(speechFile);
      await twilioClient.messages.create({ from: `whatsapp:${TWILIO_PHONE_NUMBER}`, to: from, body: `🎤 Heard: ${originalText}\n\n🌎 Translated: ${translated}`, mediaUrl: [publicUrl] });
      return res.sendStatus(200);
    }

    // text message
    if (bodyText) {
      const translated = await translateText(bodyText, target_lang);
      const speechFile = await tts(translated, target_lang);
      const publicUrl = await uploadPublic(speechFile);
      await twilioClient.messages.create({ from: `whatsapp:${TWILIO_PHONE_NUMBER}`, to: from, body: `📝 Translated: ${translated}`, mediaUrl: [publicUrl] });
      return res.sendStatus(200);
    }

    res.set("Content-Type", "text/xml");
    return res.send(`<Response><Message>⚠️ Please send a voice note or text message.</Message></Response>`);
  } catch (err) {
    console.error("Webhook error", err);
    res.set("Content-Type", "text/xml");
    return res.send(`<Response><Message>⚠️ Error processing message. Try again later.</Message></Response>`);
  }
});

// health check
app.get("/healthz", (_, res) => res.status(200).send("OK"));
app.listen(PORT, () => console.log(`🚀 Server listening on ${PORT}`));
