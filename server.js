// server.js – Smart WhatsApp Translator Bot (stable onboarding + sandbox-safe replies)
import express from "express";
import bodyParser from "body-parser";
import fetch from "node-fetch";
import ffmpeg from "fluent-ffmpeg";
import fs from "fs";
import OpenAI from "openai";
import { createClient } from "@supabase/supabase-js";
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
const openai   = new OpenAI({ apiKey: OPENAI_API_KEY });

// ------------------------------------------------------------------
// CONSTANTS
// ------------------------------------------------------------------
const LANGUAGE_OPTIONS = {
  1: { name: "English",    code: "en" },
  2: { name: "Spanish",    code: "es" },
  3: { name: "French",     code: "fr" },
  4: { name: "Portuguese", code: "pt" }
};

// ------------------------------------------------------------------
// HELPERS
// ------------------------------------------------------------------
const matchChoice = (input = "") => {
  const clean = input.trim().toLowerCase();
  const num   = clean.match(/^[0-9]/)?.[0];
  if (num && LANGUAGE_OPTIONS[num]) return LANGUAGE_OPTIONS[num];
  return Object.values(LANGUAGE_OPTIONS)
               .find(v => clean === v.code || clean === v.name.toLowerCase());
};

function convertAudio(src, dest) {
  return new Promise((resolve, reject) => {
    ffmpeg(src)
      .audioCodec("pcm_s16le")
      .outputOptions(["-ac", "1", "-ar", "16000", "-f", "wav"])
      .on("error", reject)
      .on("end", () => resolve(dest))
      .save(dest);
  });
}

async function transcribeAudio(path) {
  const r = await openai.audio.transcriptions.create({
    model: "whisper-1",
    file: fs.createReadStream(path),
    response_format: "json",
    language: "auto"
  });
  return r.text;
}

async function translateText(text, target) {
  const res = await fetch(`https://translation.googleapis.com/language/translate/v2?key=${GOOGLE_TRANSLATE_KEY}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ q: text, target })
  });
  return (await res.json()).data.translations[0].translatedText;
}

async function tts(text, lang) {
  const r = await fetch(`https://texttospeech.googleapis.com/v1/text:synthesize?key=${GOOGLE_TTS_KEY}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      input:  { text },
      voice:  { languageCode: lang, ssmlGender: "FEMALE" },
      audioConfig: { audioEncoding: "MP3" }
    })
  });
  const j = await r.json();
  const f = `/tmp/tts_${Date.now()}.mp3`;
  fs.writeFileSync(f, Buffer.from(j.audioContent, "base64"));
  return f;
}

async function uploadPublic(path) {
  const name = `tts_${Date.now()}.mp3`;
  await supabase.storage.from("tts-voices").upload(name, fs.readFileSync(path), { contentType: "audio/mpeg", upsert: true });
  return `${SUPABASE_URL}/storage/v1/object/public/tts-voices/${name}`;
}

// ------------------------------------------------------------------
// EXPRESS
// ------------------------------------------------------------------
const app = express();
app.use(bodyParser.urlencoded({ extended: false }));
app.use(bodyParser.json());

app.post("/webhook", async (req, res) => {
  const from      = req.body.From;
  const bodyText  = (req.body.Body || "").trim();
  const mediaUrl  = req.body.MediaUrl0;
  const mediaType = req.body.MediaContentType0;

  try {
    // load or create user row
    let { data: user } = await supabase
      .from("users")
      .select("source_lang,target_lang,language_step")
      .eq("phone_number", from)
      .single();

    if (!user) {
      await supabase.from("users").insert({ phone_number: from, language_step: "source" });
      user = { language_step: "source" };
    }

    // RESET COMMAND
    if (bodyText.toLowerCase().startsWith("change language")) {
      await supabase.from("users").update({ language_step: "source", source_lang: null, target_lang: null })
                   .eq("phone_number", from);
      user.language_step = "source";
    }

    // ---------- ONBOARDING SOURCE ----------
    if (user.language_step === "source") {
      const choice = matchChoice(bodyText);
      if (choice) {
        await supabase.from("users")
          .update({ source_lang: choice.code, language_step: "target" })
          .eq("phone_number", from);
        let prompt = "✅ Got it! What language should I translate messages into?\n\n";
        for (const [k, v] of Object.entries(LANGUAGE_OPTIONS)) prompt += `${k}️⃣ ${v.name} (${v.code})\n`;
        return res.send(`<Response><Message>${prompt}</Message></Response>`);
      }
      let prompt = "👋 Welcome! What language are the messages you're receiving in?\n\n";
      for (const [k, v] of Object.entries(LANGUAGE_OPTIONS)) prompt += `${k}️⃣ ${v.name} (${v.code})\n`;
      return res.send(`<Response><Message>${prompt}</Message></Response>`);
    }

    // ---------- ONBOARDING TARGET ----------
    if (user.language_step === "target") {
      const choice = matchChoice(bodyText);
      if (choice) {
        await supabase.from("users")
          .update({ target_lang: choice.code, language_step: "done" })
          .eq("phone_number", from);
        return res.send(`<Response><Message>✅ You're all set! Send a voice note or text to translate.</Message></Response>`);
      }
      let prompt = "⚠️ Please choose the language I should translate into:\n\n";
      for (const [k, v] of Object.entries(LANGUAGE_OPTIONS)) prompt += `${k}️⃣ ${v.name} (${v.code})\n`;
      return res.send(`<Response><Message>${prompt}</Message></Response>`);
    }

    // ---------- TRANSLATION ------------
    const { source_lang, target_lang } = user;

    // VOICE NOTE
    if (mediaUrl && mediaType?.startsWith("audio")) {
      const auth = "Basic " + Buffer.from(`${TWILIO_ACCOUNT_SID}:${TWILIO_AUTH_TOKEN}`).toString("base64");
      const raw  = `/tmp/raw_${Date.now()}`;
      const wav  = `/tmp/wav_${Date.now()}.wav`;
      fs.writeFileSync(raw, await (await fetch(mediaUrl, { headers:{ Authorization: auth } })).buffer());
      await convertAudio(raw, wav);
      const original   = await transcribeAudio(wav);
      const translated = await translateText(original, target_lang);
      const publicUrl  = await uploadPublic(await tts(translated, target_lang));

      res.set("Content-Type", "text/xml");
      return res.send(`<Response><Message>🎤 Heard: ${original}\n\n🌎 Translated: ${translated}<Media>${publicUrl}</Media></Message></Response>`);
    }

    // TEXT MESSAGE
    if (bodyText) {
      const translated = await translateText(bodyText, target_lang);
      const publicUrl  = await uploadPublic(await tts(translated, target_lang));
      res.set("Content-Type", "text/xml");
      return res.send(`<Response><Message>📝 Translated: ${translated}<Media>${publicUrl}</Media></Message></Response>`);
    }

    // fallback
    res.set("Content-Type","text/xml");
    return res.send(`<Response><Message>⚠️ Please send a voice note or text message.</Message></Response>`);

  } catch (err) {
    console.error("Webhook error", err);
    res.set("Content-Type","text/xml");
    return res.send(`<Response><Message>⚠️ Error processing message. Try again later.</Message></Response>`);
  }
});

// health check
app.get("/healthz", (_, res) => res.status(200).send("OK"));
app.listen(PORT, () => console.log(`🚀 Server listening on ${PORT}`));
