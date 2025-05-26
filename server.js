// server.js – Smart WhatsApp Translator Bot (cleaned braces & onboarding flow)
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

const {
  SUPABASE_URL,
  SUPABASE_KEY,
  OPENAI_API_KEY,
  GOOGLE_TRANSLATE_KEY,
  GOOGLE_TTS_KEY,
  TWILIO_ACCOUNT_SID,
  TWILIO_AUTH_TOKEN,
  TWILIO_PHONE_NUMBER,
  FREE_CREDITS_PER_USER = 30,
  PORT = 8080
} = process.env;

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);
const openai = new OpenAI({ apiKey: OPENAI_API_KEY });
const twilioClient = twilio(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN);

// ---------- helpers --------------------------------------------------
function convertAudio(inputPath, outputPath) {
  return new Promise((resolve, reject) => {
    ffmpeg(inputPath)
      .audioCodec("pcm_s16le")
      .outputOptions(["-ac", "1", "-ar", "16000", "-f", "wav"])
      .on("error", reject)
      .on("end", () => resolve(outputPath))
      .save(outputPath);
  });
}

async function transcribeAudio(wavPath) {
  const response = await openai.audio.transcriptions.create({
    model: "whisper-1",
    file: fs.createReadStream(wavPath),
    response_format: "json",
    language: "auto"
  });
  return { text: response.text, lang: response.language || null };
}

async function translateText(text, targetLang) {
  const url = `https://translation.googleapis.com/language/translate/v2?key=${GOOGLE_TRANSLATE_KEY}`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ q: text, target: targetLang })
  });
  return (await res.json()).data.translations[0].translatedText;
}

async function generateSpeech(text, langCode) {
  const res = await fetch(`https://texttospeech.googleapis.com/v1/text:synthesize?key=${GOOGLE_TTS_KEY}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      input: { text },
      voice: { languageCode: langCode, ssmlGender: "FEMALE" },
      audioConfig: { audioEncoding: "MP3" }
    })
  });
  const data = await res.json();
  const p = `/tmp/tts_${Date.now()}.mp3`;
  fs.writeFileSync(p, Buffer.from(data.audioContent, "base64"));
  return p;
}

async function uploadToSupabase(filePath, filename) {
  const fileData = fs.readFileSync(filePath);
  await supabase.storage.from("tts-voices").upload(filename, fileData, { contentType: "audio/mpeg", upsert: true });
  return `${SUPABASE_URL}/storage/v1/object/public/tts-voices/${filename}`;
}

// menu
const LANGUAGE_OPTIONS = {
  1: { name: "English", code: "en" },
  2: { name: "Spanish", code: "es" },
  3: { name: "French", code: "fr" },
  4: { name: "Portuguese", code: "pt" }
};

const matchChoice = (input) => {
  const clean = input?.toLowerCase().trim();
  return Object.entries(LANGUAGE_OPTIONS).find(([k, v]) => clean === k || clean === v.code || clean === v.name.toLowerCase());
};

// ---------- express --------------------------------------------------
const app = express();
app.use(bodyParser.urlencoded({ extended: false }));
app.use(bodyParser.json());

app.post("/webhook", async (req, res) => {
  const from = req.body.From;
  const bodyText = req.body.Body?.trim();
  const mediaUrl = req.body.MediaUrl0;
  const mediaType = req.body.MediaContentType0;

  try {
    // fetch or create user
    let { data: user } = await supabase.from("users").select("source_lang,target_lang,language_step").eq("phone_number", from).single();
    if (!user) {
      await supabase.from("users").insert({ phone_number: from, language_step: "source" });
      user = { language_step: "source" };
    }

    const step = user.language_step;

    // ---- handle onboarding choices ----
    if (step === "source" && bodyText) {
      const m = matchChoice(bodyText);
      if (m) {
        const [, src] = m;
        await supabase.from("users").update({ source_lang: src.code, language_step: "target" }).eq("phone_number", from);
        let prompt = `✅ Got it! What language should I translate messages into?\n\n`;
        for (const [k, v] of Object.entries(LANGUAGE_OPTIONS)) prompt += `${k}️⃣ ${v.name} (${v.code})\n`;
        return res.send(`<Response><Message>${prompt}</Message></Response>`);
      }
    }

    if (step === "target" && bodyText) {
      const m = matchChoice(bodyText);
      if (m) {
        const [, tgt] = m;
        await supabase.from("users").update({ target_lang: tgt.code, language_step: "done" }).eq("phone_number", from);
        return res.send(`<Response><Message>✅ You're all set! Send voice or text to translate.</Message></Response>`);
      }
    }

    if (step !== "done") {
      let prompt = `👋 Welcome! What language are the messages you're receiving in?\n\n`;
      for (const [k, v] of Object.entries(LANGUAGE_OPTIONS)) prompt += `${k}️⃣ ${v.name} (${v.code})\n`;
      return res.send(`<Response><Message>${prompt}</Message></Response>`);
    }

    // ---------- translation flow ----------
    const { source_lang, target_lang } = user;

    if (mediaUrl && mediaType?.startsWith("audio")) {
      const auth = "Basic " + Buffer.from(`${TWILIO_ACCOUNT_SID}:${TWILIO_AUTH_TOKEN}`).toString("base64");
      const inP = `/tmp/in_${Date.now()}`;
      const outP = `/tmp/out_${Date.now()}.wav`;
      const aRes = await fetch(mediaUrl, { headers: { Authorization: auth } });
      fs.writeFileSync(inP, await aRes.buffer());
      await convertAudio(inP, outP);
      const { text } = await transcribeAudio(outP);
      const translated = await translateText(text, target_lang);
      const ttsP = await generateSpeech(translated, target_lang);
      const pub = await uploadToSupabase(ttsP, `tts_${Date.now()}.mp3`);
      await twilioClient.messages.create({ from: `whatsapp:${TWILIO_PHONE_NUMBER}`, to: from, body: `🎤 Heard: ${text}\n\n🌎 Translated: ${translated}`, mediaUrl: [pub] });
      return res.sendStatus(200);
    }

    if (bodyText) {
      const translated = await translateText(bodyText, target_lang);
      const ttsP = await generateSpeech(translated, target_lang);
      const pub = await uploadToSupabase(ttsP, `tts_${Date.now()}.mp3`);
      await twilioClient.messages.create({ from: `whatsapp:${TWILIO_PHONE_NUMBER}`, to: from, body: `📝 Translated: ${translated}`, mediaUrl: [pub] });
      return res.sendStatus(200);
    }

    res.set("Content-Type", "text/xml");
    return res.send(`<Response><Message>⚠️ Please send a voice note or text message.</Message></Response>`);
  } catch (err) {
    console.error("Webhook error:", err);
    res.set("Content-Type", "text/xml");
    return res.send(`<Response><Message>⚠️ Error processing message. Try again later.</Message></Response>`);
  }
});

app.get("/healthz", (_, res) => res.status(200).send("OK"));
app.listen(PORT, () => console.log(`🚀 Server listening on ${PORT}`));
