import express from "express";
import bodyParser from "body-parser";
import fetch from "node-fetch";
import ffmpeg from "fluent-ffmpeg";
import fs from "fs";
import { Configuration, OpenAIApi } from "openai";
import { createClient } from "@supabase/supabase-js";
import twilio from "twilio";
import dotenv from "dotenv";

dotenv.config();

const app = express();
app.use(bodyParser.urlencoded({ extended: false }));
app.use(bodyParser.json());

const {
  SUPABASE_URL,
  SUPABASE_KEY,
  OPENAI_API_KEY,
  GOOGLE_TRANSLATE_KEY,
  TWILIO_ACCOUNT_SID,
  TWILIO_AUTH_TOKEN,
  TWILIO_PHONE_NUMBER,
  FREE_CREDITS_PER_USER = 30,
  PORT = 3000
} = process.env;

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);
const openai = new OpenAIApi(new Configuration({ apiKey: OPENAI_API_KEY }));
const twilioClient = twilio(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN);

async function convertAudio(inputPath, outputPath) {
  return new Promise((resolve, reject) => {
    ffmpeg(inputPath)
      .toFormat("wav")
      .on("error", reject)
      .on("end", () => resolve(outputPath))
      .save(outputPath);
  });
}

async function transcribeAudio(wavPath) {
  const response = await openai.createTranscription(
    fs.createReadStream(wavPath),
    "whisper-1"
  );
  return response.data.text;
}

async function translateText(text, targetLang = "es") {
  const url = `https://translation.googleapis.com/language/translate/v2?key=${GOOGLE_TRANSLATE_KEY}`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ q: text, target: targetLang })
  });
  const data = await res.json();
  return data.data.translations[0].translatedText;
}

async function decrementCredit(phone) {
  const { data: user, error } = await supabase.from("users").select("credits_remaining").eq("phone_number", phone).single();
  if (error && error.code !== "PGRST116") throw error;

  if (!user) {
    await supabase.from("users").insert({ phone_number: phone, credits_remaining: FREE_CREDITS_PER_USER - 1 });
    return FREE_CREDITS_PER_USER - 1;
  }
  if (user.credits_remaining <= 0) return -1;
  const newCredits = user.credits_remaining - 1;
  await supabase.from("users").update({ credits_remaining: newCredits }).eq("phone_number", phone);
  return newCredits;
}

async function replyWhatsApp(to, body) {
  await twilioClient.messages.create({ from: `whatsapp:${TWILIO_PHONE_NUMBER}`, to, body });
}

app.post("/webhook", async (req, res) => {
  try {
    const from = req.body.From;
    const mediaUrl = req.body.MediaUrl0;

    const credits = await decrementCredit(from);
    if (credits < 0) {
      await replyWhatsApp(from, "🚫 You have no credits left. Upgrade here: yoursite.com/pricing");
      return res.sendStatus(200);
    }

    const inputPath = `/tmp/input_${Date.now()}.ogg`;
    const outputPath = `/tmp/output_${Date.now()}.wav`;
    const audioRes = await fetch(mediaUrl);
    fs.writeFileSync(inputPath, await audioRes.buffer());

    await convertAudio(inputPath, outputPath);

    const transcript = await transcribeAudio(outputPath);
    const translated = await translateText(transcript, "es");

    await supabase.from("translations").insert({
      phone_number: from,
      original_text: transcript,
      translated_text: translated,
      language_from: "auto",
      language_to: "es"
    });

    await replyWhatsApp(from, `📝 Translated:\n${translated}`);

    res.sendStatus(200);
  } catch (err) {
    console.error(err);
    res.sendStatus(500);
  }
});

app.listen(PORT, () => console.log(`🚀 Server listening on ${PORT}`));
