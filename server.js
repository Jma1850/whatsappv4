// server.js – Smart WhatsApp Translator with language-reset command
import express from "express";
import bodyParser from "body-parser";
import fetch from "node-fetch";
import ffmpeg from "fluent-ffmpeg";
import fs from "fs";
import OpenAI from "openai";
import { createClient } from "@supabase/supabase-js";
import dotenv from "dotenv";
dotenv.config();

/* ─── ENV ─── */
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

/* ─── Clients ─── */
const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);
const openai   = new OpenAI({ apiKey: OPENAI_API_KEY });

/* ─── Helpers ─── */
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

async function transcribeAudio(wav) {
  const res = await openai.audio.transcriptions.create({
    model: "whisper-1",
    file : fs.createReadStream(wav),
    response_format: "json"
  });
  return { text: res.text, lang: res.language || null };
}

async function translateText(text, to = "en") {
  const gRes = await fetch(
    `https://translation.googleapis.com/language/translate/v2?key=${GOOGLE_TRANSLATE_KEY}`,
    { method:"POST", headers:{ "Content-Type":"application/json" },
      body: JSON.stringify({ q:text, target:to }) }
  );
  const data = await gRes.json();
  return data.data.translations[0].translatedText;
}

async function tts(text, lang = "es") {
  const tRes = await fetch(
    `https://texttospeech.googleapis.com/v1/text:synthesize?key=${GOOGLE_TTS_KEY}`,
    { method:"POST", headers:{ "Content-Type":"application/json" },
      body: JSON.stringify({
        input:{ text }, voice:{ languageCode:lang, ssmlGender:"FEMALE" },
        audioConfig:{ audioEncoding:"MP3" }
      }) }
  );
  const { audioContent } = await tRes.json();
  const path = `/tmp/tts_${Date.now()}.mp3`;
  fs.writeFileSync(path, Buffer.from(audioContent,"base64"));
  return path;
}

async function uploadPublic(path, filename) {
  const data = fs.readFileSync(path);
  const { error } = await supabase.storage
    .from("tts-voices").upload(filename, data,
      { contentType:"audio/mpeg", upsert:true });
  if (error) throw error;
  return `${SUPABASE_URL}/storage/v1/object/public/tts-voices/${filename}`;
}

/* ─── Menu config ─── */
const LANGS = {
  1:{ name:"English",    code:"en" },
  2:{ name:"Spanish",    code:"es" },
  3:{ name:"French",     code:"fr" },
  4:{ name:"Portuguese", code:"pt" }
};
const digits = Object.keys(LANGS);

/* accept 1 / 1️⃣ / en / english */
const matchChoice = (input="")=>{
  const c = input.trim().toLowerCase();
  const d = c.match(/^\d/)?.[0];
  if (d && LANGS[d]) return LANGS[d];
  return Object.values(LANGS)
    .find(v=>c===v.code||c===v.name.toLowerCase());
};

/* ─── Express ─── */
const app = express();
app.use(bodyParser.urlencoded({extended:false}));
app.use(bodyParser.json());

app.post("/webhook", async (req,res)=>{
  const from     = req.body.From;
  const bodyText = (req.body.Body||"").trim();
  const mediaUrl = req.body.MediaUrl0;
  const mediaTyp = req.body.MediaContentType0;

  try {
    /* fetch or create user row */
    let { data:u } = await supabase
       .from("users").select("source_lang,target_lang,language_step")
       .eq("phone_number",from).single();

    if(!u){
      await supabase.from("users").insert({
        phone_number:from, language_step:"source"
      });
      u = { language_step:"source" };
    }

    /* command: reset language setup */
    if (/^(change )?language$/i.test(bodyText)){
      await supabase.from("users")
        .update({ language_step:"source",
                  source_lang:null,target_lang:null })
        .eq("phone_number",from);

      let p="🔄 Language setup reset!\nWhat language are the messages you're receiving in?\n\n";
      for (const k of digits) p+=`${k}️⃣ ${LANGS[k].name} (${LANGS[k].code})\n`;
      return res.send(`<Response><Message>${p}</Message></Response>`);
    }

    /* ── Step 1: choose source_lang ── */
    if (u.language_step==="source"){
      const choice = matchChoice(bodyText);
      if(choice){
        await supabase.from("users")
          .update({ source_lang:choice.code, language_step:"target" })
          .eq("phone_number",from);

        let p="✅ Got it! What language should I translate messages into?\n\n";
        for (const k of digits) p+=`${k}️⃣ ${LANGS[k].name} (${LANGS[k].code})\n`;
        return res.send(`<Response><Message>${p}</Message></Response>`);
      }
      /* re-prompt */
      let p="👋 Welcome! What language are the messages you're receiving in?\n\n";
      for (const k of digits) p+=`${k}️⃣ ${LANGS[k].name} (${LANGS[k].code})\n`;
      return res.send(`<Response><Message>${p}</Message></Response>`);
    }

    /* ── Step 2: choose target_lang ── */
    if (u.language_step==="target"){
      const choice = matchChoice(bodyText);
      if(choice){
        await supabase.from("users")
          .update({ target_lang:choice.code, language_step:"done" })
          .eq("phone_number",from);
        return res.send(`<Response><Message>✅ You're all set! Send a voice note or text to translate.</Message></Response>`);
      }
      let p="⚠️ Please choose the language I should translate into:\n\n";
      for (const k of digits) p+=`${k}️⃣ ${LANGS[k].name} (${LANGS[k].code})\n`;
      return res.send(`<Response><Message>${p}</Message></Response>`);
    }

    /* ── Translation phase ── */
    const { source_lang, target_lang } = u;

    /* VOICE */
    if (mediaUrl && mediaTyp?.startsWith("audio")){
      const auth = "Basic "+Buffer.from(`${TWILIO_ACCOUNT_SID}:${TWILIO_AUTH_TOKEN}`).toString("base64");
      const raw  = `/tmp/raw_${Date.now()}`; const wav=`/tmp/wav_${Date.now()}.wav`;
      fs.writeFileSync(raw, await (await fetch(mediaUrl,{headers:{Authorization:auth}})).buffer());
      await convertAudio(raw,wav);
      const {text:original} = await transcribeAudio(wav);

      const tl = (original && target_lang) ? await translateText(original,target_lang) : original;
      const url = await uploadPublic(await tts(tl,target_lang),`tts_${Date.now()}.mp3`);

      return res.send(`
        <Response>
          <Message>
🎤 Heard: ${original}

🌎 Translated: ${tl}
            <Media>${url}</Media>
          </Message>
        </Response>`);
    }

    /* TEXT */
    if (bodyText){
      const tl = await translateText(bodyText,target_lang);
      const url = await uploadPublic(await tts(tl,target_lang),`tts_${Date.now()}.mp3`);

      return res.send(`
        <Response>
          <Message>
📝 Translated: ${tl}
            <Media>${url}</Media>
          </Message>
        </Response>`);
    }

    /* fallback */
    res.set("Content-Type","text/xml");
    return res.send(`<Response><Message>⚠️ Please send a voice note or text message.</Message></Response>`);

  } catch(err){
    console.error("Webhook error:",err);
    res.set("Content-Type","text/xml");
    return res.send(`<Response><Message>⚠️ Error processing message. Try again later.</Message></Response>`);
  }
});

app.get("/healthz",(_,r)=>r.status(200).send("OK"));
app.listen(PORT,()=>console.log(`🚀 Server listening on ${PORT}`));
