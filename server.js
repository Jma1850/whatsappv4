/* ── server.js : WhatsApp voice-&-text translator bot ─────────────────── */
import express from "express";
import bodyParser from "body-parser";
import fetch from "node-fetch";
import ffmpeg from "fluent-ffmpeg";
import fs from "fs";
import { randomUUID as uuid } from "crypto";
import OpenAI from "openai";
import { createClient } from "@supabase/supabase-js";
import * as dotenv from "dotenv";
dotenv.config();

/* ── env vars ── */
const {
  SUPABASE_URL,
  SUPABASE_KEY,
  OPENAI_API_KEY,
  GOOGLE_TTS_KEY,
  PORT = 8080
} = process.env;

/* ── clients ── */
const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);
const openai   = new OpenAI({ apiKey: OPENAI_API_KEY });

/* ── express ── */
const app = express();
app.use(bodyParser.urlencoded({ extended: false }));
app.use(bodyParser.json());

/* ── language menu ── */
const MENU = {
  1: { name: "English",    code: "en", voice: "en-US-Neural2-D" },
  2: { name: "Spanish",    code: "es", voice: "es-ES-Neural2-A" },
  3: { name: "French",     code: "fr", voice: "fr-FR-Neural2-B" },
  4: { name: "Portuguese", code: "pt", voice: "pt-BR-Neural2-A" }
};
const DIGITS      = Object.keys(MENU);
const menuLines   = t => `${t}\n\n` + DIGITS.map(d => `${d}️⃣ ${MENU[d].name} (${MENU[d].code})`).join("\n");
const matchChoice = t => {
  const n = t.trim().match(/^\d/); if (n && MENU[n[0]]) return MENU[n[0]];
  const lc = t.trim().toLowerCase();
  return Object.values(MENU).find(o => o.code === lc || o.name.toLowerCase() === lc);
};

/* ── TwiML helper ── */
const twiml = (...msgs) => `<Response>${msgs.map(m => `\n<Message>${m}</Message>`).join("")}\n</Response>`;

/* ── audio helpers ── */
const toWav = (inF, outF) => new Promise((res, rej) =>
  ffmpeg(inF).audioCodec("pcm_s16le").outputOptions(["-ac","1","-ar","16000","-f","wav"])
    .on("error", rej).on("end", () => res(outF)).save(outF));

async function whisper(buf) {
  const ogg = `/tmp/${uuid()}.ogg`, wav = ogg.replace(".ogg",".wav");
  fs.writeFileSync(ogg, buf);
  await toWav(ogg, wav);
  try {
    const r = await openai.audio.transcriptions.create({ model:"whisper-large-v3", file:fs.createReadStream(wav), response_format:"json" });
    return { txt:r.text, lang:(r.language||"").slice(0,2) };
  } catch {
    const r = await openai.audio.transcriptions.create({ model:"whisper-1", file:fs.createReadStream(wav), response_format:"json" });
    return { txt:r.text, lang:(r.language||"").slice(0,2) };
  } finally { fs.unlinkSync(ogg); fs.unlinkSync(wav); }
}

const detect = async q =>
  (await fetch(`https://translation.googleapis.com/language/translate/v2/detect?key=${GOOGLE_TTS_KEY}`,{
     method:"POST",headers:{ "Content-Type":"application/json"},body:JSON.stringify({ q })}).then(r=>r.json()))
  .data.detections[0][0].language;

const translate = async (q,target)=>
  (await fetch(`https://translation.googleapis.com/language/translate/v2?key=${GOOGLE_TTS_KEY}`,{
     method:"POST",headers:{ "Content-Type":"application/json"},body:JSON.stringify({ q, target })}).then(r=>r.json()))
  .data.translations[0].translatedText;

async function tts(text, voice){
  const lang = voice.split("-",2)[0];
  const r = await fetch(`https://texttospeech.googleapis.com/v1/text:synthesize?key=${GOOGLE_TTS_KEY}`,{
    method:"POST",headers:{ "Content-Type":"application/json"},
    body:JSON.stringify({ input:{ text }, voice:{ languageCode:lang, name:voice }, audioConfig:{ audioEncoding:"MP3" } })});
  const j=await r.json(); if(!j.audioContent) throw Error("TTS failed");
  return Buffer.from(j.audioContent, "base64");
}

async function logRow({ phone, orig, trans, from, to }){
  await supabase.from("translations").insert({
    id: uuid(), phone_number: phone,
    original_text: orig, translated_text: trans,
    language_from: from, language_to: to
  });
}

/* ── webhook ── */
app.post("/webhook", async (req, res) => {
  const from = req.body.From;
  const body = (req.body.Body || "").trim();
  const mediaUrl  = req.body.MediaUrl0;
  const mediaType = req.body.MediaContentType0;

  // pull user row
  let { data:user } = await supabase.from("users")
    .select("source_lang,target_lang,language_step")
    .eq("phone_number", from).single();

  /* ----- first contact ----- */
  if (!user) {
    await supabase.from("users").insert({ phone_number: from, language_step: "source" });
    return res.send(twiml(menuLines("👋 Welcome! What language are the messages you're receiving in?")));
  }

  /* ----- source language ----- */
  if (user.language_step === "source") {
    const c = matchChoice(body);
    if (c) {
      await supabase.from("users").update({ source_lang:c.code, language_step:"target" }).eq("phone_number", from);
      return res.send(twiml(menuLines("✅ Got it! What language should I translate messages into?")));
    }
    return res.send(twiml("❌ Reply 1-4.", menuLines("Languages:")));
  }

  /* ----- target language ----- */
  if (user.language_step === "target") {
    const c = matchChoice(body);
    if (c) {
      await supabase.from("users").update({ target_lang:c.code, language_step:"ready" }).eq("phone_number", from);
      return res.send(twiml("✅ Setup complete! Send a voice note or text."));
    }
    return res.send(twiml("❌ Reply 1-4.", menuLines("Languages:")));
  }

  /* ----- translation phase ----- */
  const src=user.source_lang, tgt=user.target_lang;
  let orig="", detected="";

  if (mediaUrl && mediaType?.startsWith("audio")) {
    const buf = await fetch(mediaUrl).then(r=>r.buffer());
    const { txt, lang } = await whisper(buf);
    orig = txt;
    detected = lang || await detect(txt);
  } else if (body) {
    orig = body;
    detected = (await detect(orig)).slice(0,2);
  }

  if (!orig) return res.send(twiml("⚠️ Please send text or a voice note."));

  const dest = detected === tgt ? src : tgt;        // auto-flip
  const translated = await translate(orig, dest);
  await logRow({ phone:from, orig, trans:translated, from:detected, to:dest });

  const heardLine = `🗣 Heard (${detected||"unknown"}): ${orig}`;
  const transLine = `🌎 Translated (${dest}): ${translated}`;

  // TEXT reply
  if (!mediaUrl) return res.send(twiml(transLine));

  // AUDIO reply
  try {
    const voice = MENU[DIGITS.find(k=>MENU[k].code===dest)].voice;
    const mp3 = await tts(translated, voice);
    const b64 = mp3.toString("base64");
    return res.send(twiml(
      heardLine,
      transLine,
      `<Media>data:audio/mpeg;base64,${b64}</Media>`
    ));
  } catch (e) {
    console.error("TTS err:", e.message);
    return res.send(twiml(heardLine, transLine));
  }
});

/* health check */
app.get("/healthz", (_, r) => r.status(200).send("OK"));

app.listen(PORT, () => console.log("🚀 server listening on", PORT));
