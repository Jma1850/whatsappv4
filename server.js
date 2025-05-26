// server.js – Smart WhatsApp Translator (stable onboarding)
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

// ─────────────────────── ENV ───────────────────────
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

// ───────────────────── CLIENTS ─────────────────────
const supabase     = createClient(SUPABASE_URL, SUPABASE_KEY);
const openai       = new OpenAI({ apiKey: OPENAI_API_KEY });
const twilioClient = twilio(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN);

// ───────────────────── CONSTANTS ───────────────────
const LANGUAGE_OPTIONS = {
  1: { name: "English",     code: "en" },
  2: { name: "Spanish",     code: "es" },
  3: { name: "French",      code: "fr" },
  4: { name: "Portuguese",  code: "pt" }
};

// helper: accept 1 / 1️⃣ / en / english
const matchChoice = (input = "") => {
  const clean = input.trim().toLowerCase();
  const num   = clean.match(/^[0-9]/)?.[0];
  if (num && LANGUAGE_OPTIONS[num]) return [num, LANGUAGE_OPTIONS[num]];
  return Object.entries(LANGUAGE_OPTIONS)
               .find(([ , v]) => clean === v.code || clean === v.name.toLowerCase());
};

// ───────────────────── EXPRESS ─────────────────────
const app = express();
app.use(bodyParser.urlencoded({ extended:false }));
app.use(bodyParser.json());

app.post("/webhook", async (req, res) => {
  const from      = req.body.From;
  const bodyText  = (req.body.Body || "").trim();
  const mediaUrl  = req.body.MediaUrl0;
  const mediaType = req.body.MediaContentType0;

  try {
    // fetch or create
    let { data: user } = await supabase
      .from("users")
      .select("source_lang,target_lang,language_step")
      .eq("phone_number", from)
      .single();

    if (!user) {
      await supabase.from("users").insert({ phone_number: from, language_step: "source" });
      user = { language_step: "source" };
    }

    // ───── Onboarding: source language ─────
    if (user.language_step === "source") {
      const m = matchChoice(bodyText);
      if (m) {
        const [, src] = m;
        const { error } = await supabase
          .from("users")
          .update({ source_lang: src.code, language_step: "target" })
          .eq("phone_number", from);
        if (error) console.error("Supabase update error (source):", error);

        let prompt = "✅ Got it! What language should I translate messages into?\n\n";
        for (const [k, v] of Object.entries(LANGUAGE_OPTIONS))
          prompt += `${k}️⃣ ${v.name} (${v.code})\n`;

        return res.send(`<Response><Message>${prompt}</Message></Response>`);
      }

      // re-prompt
      let prompt = "👋 Welcome! What language are the messages you're receiving in?\n\n";
      for (const [k, v] of Object.entries(LANGUAGE_OPTIONS))
        prompt += `${k}️⃣ ${v.name} (${v.code})\n`;
      return res.send(`<Response><Message>${prompt}</Message></Response>`);
    }

    // ───── Onboarding: target language ─────
    if (user.language_step === "target") {
      const m = matchChoice(bodyText);
      if (m) {
        const [, tgt] = m;
        const { error } = await supabase
          .from("users")
          .update({ target_lang: tgt.code, language_step: "done" })
          .eq("phone_number", from);
        if (error) console.error("Supabase update error (target):", error);

        return res.send(`<Response><Message>✅ You're all set! Send a voice note or text to translate.</Message></Response>`);
      }

      let prompt = "⚠️ Please choose the language I should translate into:\n\n";
      for (const [k, v] of Object.entries(LANGUAGE_OPTIONS))
        prompt += `${k}️⃣ ${v.name} (${v.code})\n`;
      return res.send(`<Response><Message>${prompt}</Message></Response>`);
    }

    // ───── Translation phase (language_step === 'done') ─────
    const { source_lang, target_lang } = user;

    // VOICE
    if (mediaUrl && mediaType?.startsWith("audio")) {
      const auth = "Basic " + Buffer.from(`${TWILIO_ACCOUNT_SID}:${TWILIO_AUTH_TOKEN}`).toString("base64");
      const raw  = `/tmp/raw_${Date.now()}`;
      const wav  = `/tmp/wav_${Date.now()}.wav`;
      fs.writeFileSync(raw, await (await fetch(mediaUrl, { headers:{ Authorization:auth }})).buffer());
      await convertAudio(raw, wav);
      const original = await transcribeAudio(wav);
      const translated = await translateText(original, target_lang);
      const publicUrl  = await uploadPublic(await tts(translated, target_lang));

      await twilioClient.messages.create({
        from:`whatsapp:${TWILIO_PHONE_NUMBER}`,
        to:from,
        body:`🎤 Heard: ${original}\n\n🌎 Translated: ${translated}`,
        mediaUrl:[publicUrl]
      });
      return res.sendStatus(200);
    }

    // TEXT
    if (bodyText) {
      const translated = await translateText(bodyText, target_lang);
      const publicUrl  = await uploadPublic(await tts(translated, target_lang));

      await twilioClient.messages.create({
        from:`whatsapp:${TWILIO_PHONE_NUMBER}`,
        to:from,
        body:`📝 Translated: ${translated}`,
        mediaUrl:[publicUrl]
      });
      return res.sendStatus(200);
    }

    // default fallback
    res.set("Content-Type","text/xml");
    return res.send(`<Response><Message>⚠️ Please send a voice note or text message.</Message></Response>`);

  } catch (err) {
    console.error("Webhook error:", err);
    res.set("Content-Type","text/xml");
    return res.send(`<Response><Message>⚠️ Error processing message. Try again later.</Message></Response>`);
  }
});

app.get("/healthz",(_,res)=>res.status(200).send("OK"));
app.listen(PORT,()=>console.log(`🚀 Server listening on ${PORT}`));
