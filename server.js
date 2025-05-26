// server.js – Smart WhatsApp Translator Bot (Voice + Text + Guided Language Setup)
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

const LANGUAGE_OPTIONS = {
  1: { name: "English", code: "en" },
  2: { name: "French", code: "fr" },
  3: { name: "Portuguese", code: "pt" },
  4: { name: "German", code: "de" },
  5: { name: "Spanish", code: "es" }
};

const app = express();
app.use(bodyParser.urlencoded({ extended: false }));
app.use(bodyParser.json());

app.post("/webhook", async (req, res) => {
  const from = req.body.From;
  const bodyText = req.body.Body?.trim();
  const mediaUrl = req.body.MediaUrl0;
  const mediaType = req.body.MediaContentType0;

  try {
    let { data: userData } = await supabase
      .from("users")
      .select("preferred_lang, last_target_lang, source_lang, target_lang, is_setup_complete")
      .eq("phone_number", from)
      .single();

    if (bodyText && !isNaN(bodyText) && userData && !userData.is_setup_complete) {
      const selected = LANGUAGE_OPTIONS[bodyText];
      if (selected) {
        await supabase.from("users").update({
          target_lang: selected.code,
          preferred_lang: selected.code,
          source_lang: userData?.source_lang || null,
          is_setup_complete: true
        }).eq("phone_number", from);

        return res.send(`<Response><Message>✅ Great! Your messages will now be translated to ${selected.name} (${selected.code.toUpperCase()}). You can send a voice note now.</Message></Response>`);
      }
    }

    const preferredLang = userData?.preferred_lang || "en";
    const lastTargetLang = userData?.last_target_lang || "es";
    const sourceLangFixed = userData?.source_lang;
    const targetLangFixed = userData?.target_lang;
    const isSetup = userData?.is_setup_complete;

    if (mediaUrl && mediaType.startsWith("audio")) {
      const authHeader =
        "Basic " + Buffer.from(`${TWILIO_ACCOUNT_SID}:${TWILIO_AUTH_TOKEN}`).toString("base64");

      const inputPath = `/tmp/input_${Date.now()}`;
      const outputPath = `/tmp/output_${Date.now()}.wav`;
      const audioRes = await fetch(mediaUrl, { headers: { Authorization: authHeader } });
      if (!audioRes.ok) throw new Error("Failed to fetch audio");
      fs.writeFileSync(inputPath, await audioRes.buffer());

      await convertAudio(inputPath, outputPath);
      const { text: transcript, lang: detectedLang } = await transcribeAudio(outputPath);

      if (!isSetup) {
        await supabase.from("users").upsert({
          phone_number: from,
          source_lang: detectedLang || null,
          preferred_lang: null,
          target_lang: null,
          is_setup_complete: false
        }, { onConflict: "phone_number" });

        let prompt;
        if (detectedLang) {
          prompt = `🎤 I detected ${detectedLang.toUpperCase()}.
What language would you like replies in?\n\n`;
        } else {
          prompt = `🤖 I couldn't detect the language.
What language is this voice note in?\n\n`;
        }
        for (const [key, val] of Object.entries(LANGUAGE_OPTIONS)) {
          prompt += `${key}️⃣ ${val.name} (${val.code})\n`;
        }

        res.set("Content-Type", "text/xml");
        return res.send(`<Response><Message>${prompt}</Message></Response>`);
      }

      const translated = await translateText(transcript, targetLangFixed || preferredLang);
      const ttsPath = await generateSpeech(translated, targetLangFixed || preferredLang);
      const filename = `tts_${Date.now()}.mp3`;
      const publicUrl = await uploadToSupabase(ttsPath, filename);

      await twilioClient.messages.create({
        from: `whatsapp:${TWILIO_PHONE_NUMBER}`,
        to: from,
        body: `🎤 Heard (${detectedLang || "unknown"}): ${transcript}\n\n🌎 Translated: ${translated}`,
        mediaUrl: [publicUrl]
      });

      return res.sendStatus(200);
    }

    if (bodyText && bodyText.toUpperCase() === "LANGUAGE") {
      let prompt = `What language would you like replies in?\n\n`;
      for (const [key, val] of Object.entries(LANGUAGE_OPTIONS)) {
        prompt += `${key}️⃣ ${val.name} (${val.code})\n`;
      }
      return res.send(`<Response><Message>${prompt}</Message></Response>`);
    }

    if (bodyText && userData?.is_setup_complete) {
      const translated = await translateText(bodyText, targetLangFixed || preferredLang);
      const ttsPath = await generateSpeech(translated, targetLangFixed || preferredLang);
      const filename = `tts_${Date.now()}.mp3`;
      const publicUrl = await uploadToSupabase(ttsPath, filename);

      await twilioClient.messages.create({
        from: `whatsapp:${TWILIO_PHONE_NUMBER}`,
        to: from,
        body: `📝 Translated: ${translated}`,
        mediaUrl: [publicUrl]
      });

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
