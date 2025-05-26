// server.js – Smart WhatsApp Translator Bot (Voice + Text)
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
    file: fs.createReadStream(wavPath)
  });
  return { text: response.text, lang: response.language };
}

async function translateText(text, targetLang = "en") {
  const url = `https://translation.googleapis.com/language/translate/v2?key=${GOOGLE_TRANSLATE_KEY}`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ q: text, target: targetLang })
  });
  const data = await res.json();
  return data.data.translations[0].translatedText;
}

async function detectLanguage(text) {
  const url = `https://translation.googleapis.com/language/translate/v2/detect?key=${GOOGLE_TRANSLATE_KEY}`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ q: text })
  });
  const data = await res.json();
  return data.data.detections[0][0].language;
}

async function generateSpeech(text, langCode = "es") {
  const response = await fetch(
    `https://texttospeech.googleapis.com/v1/text:synthesize?key=${GOOGLE_TTS_KEY}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        input: { text },
        voice: { languageCode: langCode, ssmlGender: "FEMALE" },
        audioConfig: { audioEncoding: "MP3" }
      })
    }
  );

  const data = await response.json();
  if (!data.audioContent) throw new Error("TTS failed");
  const filePath = `/tmp/tts_${Date.now()}.mp3`;
  fs.writeFileSync(filePath, Buffer.from(data.audioContent, "base64"));
  return filePath;
}

async function uploadToSupabase(filePath, filename) {
  const fileData = fs.readFileSync(filePath);
  const { error } = await supabase.storage
    .from("tts-voices")
    .upload(filename, fileData, {
      contentType: "audio/mpeg",
      upsert: true
    });

  if (error) throw error;
  return `${SUPABASE_URL}/storage/v1/object/public/tts-voices/${filename}`;
}

const app = express();
app.use(bodyParser.urlencoded({ extended: false }));
app.use(bodyParser.json());

app.post("/webhook", async (req, res) => {
  const from = req.body.From;
  const bodyText = req.body.Body?.trim();
  const mediaUrl = req.body.MediaUrl0;
  const mediaType = req.body.MediaContentType0;

  try {
    const { data: userData } = await supabase
      .from("users")
      .select("preferred_lang, last_target_lang")
      .eq("phone_number", from)
      .single();

    const preferredLang = userData?.preferred_lang || "en";
    const lastTargetLang = userData?.last_target_lang || "es";

    if (mediaUrl && mediaType.startsWith("audio")) {
      const authHeader =
        "Basic " + Buffer.from(`${TWILIO_ACCOUNT_SID}:${TWILIO_AUTH_TOKEN}`).toString("base64");

      const inputPath = `/tmp/input_${Date.now()}`;
      const outputPath = `/tmp/output_${Date.now()}.wav`;
      const audioRes = await fetch(mediaUrl, { headers: { Authorization: authHeader } });
      if (!audioRes.ok) throw new Error("Failed to fetch audio");
      fs.writeFileSync(inputPath, await audioRes.buffer());

      await convertAudio(inputPath, outputPath);
      const { text: transcript, lang: sourceLang } = await transcribeAudio(outputPath);
      const translated = await translateText(transcript, preferredLang);

      await supabase.from("users").update({ last_target_lang: sourceLang }).eq("phone_number", from);

      res.set("Content-Type", "text/xml");
      return res.send(`
        <Response>
          <Message>
🎤 Heard (${sourceLang || "unknown"}): ${transcript}

🌎 Translated (${preferredLang}): ${translated}

🔁 Reply with a voice note and I’ll translate it back into ${sourceLang?.toUpperCase() || "SPANISH"}.
          </Message>
        </Response>
      `);
    }

    if (bodyText) {
      const detectedLang = await detectLanguage(bodyText);
      const targetLang = lastTargetLang;
      const translated = await translateText(bodyText, targetLang);
      const ttsPath = await generateSpeech(translated, targetLang);
      const filename = `tts_${Date.now()}.mp3`;
      const publicUrl = await uploadToSupabase(ttsPath, filename);

      await twilioClient.messages.create({
        from: `whatsapp:${TWILIO_PHONE_NUMBER}`,
        to: from,
        body: `📝 Translated (${targetLang}): ${translated}`,
        mediaUrl: [publicUrl]
      });

      return res.sendStatus(200);
    }

    res.set("Content-Type", "text/xml");
    return res.send(`
      <Response>
        <Message>⚠️ Unsupported message type. Please send a voice note or a text message.</Message>
      </Response>
    `);
  } catch (err) {
    console.error("Webhook error:", err);
    res.set("Content-Type", "text/xml");
    return res.send(`
      <Response>
        <Message>⚠️ Error processing message. Try again later.</Message>
      </Response>
    `);
  }
});

app.get("/healthz", (_, res) => res.status(200).send("OK"));
app.listen(PORT, () => console.log(`🚀 Server listening on ${PORT}`));
