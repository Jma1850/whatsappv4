// server.js – WhatsApp Translator (Whisper-large + GPT polish + Neural TTS)
import express from "express";
import bodyParser from "body-parser";
import fetch from "node-fetch";
import ffmpeg from "fluent-ffmpeg";
import fs from "fs";
import OpenAI from "openai";
import { createClient } from "@supabase/supabase-js";
import dotenv from "dotenv";
dotenv.config();

/* ────── ENV ────── */
const {
  SUPABASE_URL, SUPABASE_KEY,
  OPENAI_API_KEY,
  GOOGLE_TRANSLATE_KEY, GOOGLE_TTS_KEY,
  TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_PHONE_NUMBER,
  PORT = 8080
} = process.env;

/* ────── Clients ────── */
const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);
const openai   = new OpenAI({ apiKey: OPENAI_API_KEY });

/* ────── Language menu ────── */
const LANGS = {
  1: { name: "English",    code: "en", tts: "en-US-Wavenet-D" },
  2: { name: "Spanish",    code: "es", tts: "es-ES-Wavenet-A" },
  3: { name: "French",     code: "fr", tts: "fr-FR-Wavenet-B" },
  4: { name: "Portuguese", code: "pt", tts: "pt-BR-Wavenet-A" }
};
const DIGITS = Object.keys(LANGS);

/* ────── Helpers ────── */
const matchChoice = txt => {
  const c = txt.trim().toLowerCase();
  const d = c.match(/^\d/)?.[0];
  if (d && LANGS[d]) return LANGS[d];
  return Object.values(LANGS).find(v => c === v.code || c === v.name.toLowerCase());
};

function convertAudio(input, output) {
  return new Promise((res, rej) => {
    ffmpeg(input)
      .audioCodec("pcm_s16le")
      .outputOptions(["-ac", "1", "-ar", "16000", "-f", "wav"])
      .on("error", rej).on("end", () => res(output)).save(output);
  });
}

async function transcribe(wav) {
  const r = await openai.audio.transcriptions.create({
    model: "whisper-large-v3",
    file : fs.createReadStream(wav),
    response_format: "json"
  });
  return { text: r.text, lang: r.language || null };
}

async function translate(text, target) {
  const r = await fetch(
    `https://translation.googleapis.com/language/translate/v2?key=${GOOGLE_TRANSLATE_KEY}`,
    { method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ q: text, target }) });
  return (await r.json()).data.translations[0].translatedText;
}

async function polish(text, langName) {
  if (text.trim().split(/\s+/).length < 3) return text; // skip tiny replies
  const sys = `You are an expert native ${langName} copy-editor. Improve wording without changing meaning.`;
  const r = await openai.chat.completions.create({
    model: "gpt-4o-mini",
    messages: [{ role: "system", content: sys },
               { role: "user",   content: text }],
    max_tokens: 400
  });
  return r.choices[0].message.content.trim();
}

async function tts(text, langCode, voiceName) {
  const ssml = `<speak><prosody rate="90%">${text}</prosody></speak>`;
  const r = await fetch(
    `https://texttospeech.googleapis.com/v1/text:synthesize?key=${GOOGLE_TTS_KEY}`,
    { method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        input:{ ssml },
        voice:{ languageCode: langCode, name: voiceName },
        audioConfig:{ audioEncoding:"MP3" }
      }) });
  const { audioContent } = await r.json();
  const path = `/tmp/tts_${Date.now()}.mp3`;
  fs.writeFileSync(path, Buffer.from(audioContent,"base64"));
  return path;
}

async function upload(path, filename) {
  const data = fs.readFileSync(path);
  const { error } = await supabase.storage.from("tts-voices")
    .upload(filename, data, { contentType:"audio/mpeg", upsert:true });
  if (error) throw error;
  return `${SUPABASE_URL}/storage/v1/object/public/tts-voices/${filename}`;
}

/* ────── Express ────── */
const app = express();
app.use(bodyParser.urlencoded({ extended:false }));
app.use(bodyParser.json());

app.post("/webhook", async (req,res) => {
  const from  = req.body.From;
  const text  = (req.body.Body || "").trim();
  const mUrl  = req.body.MediaUrl0;
  const mType = req.body.MediaContentType0;

  try {
    /* fetch/create user row */
    let { data:user } = await supabase
      .from("users").select("source_lang,target_lang,language_step")
      .eq("phone_number",from).single();

    if (!user) {
      await supabase.from("users").insert({ phone_number:from, language_step:"source" });
      user = { language_step:"source" };
    }

    /* reset command */
    if (/^(change )?language$/i.test(text)) {
      await supabase.from("users")
        .update({ language_step:"source", source_lang:null, target_lang:null })
        .eq("phone_number",from);
      let p="🔄 Language setup reset!\nWhat language are the messages you're receiving in?\n\n";
      for (const k of DIGITS) p+=`${k}️⃣ ${LANGS[k].name} (${LANGS[k].code})\n`;
      return res.send(`<Response><Message>${p}</Message></Response>`);
    }

    /* step 1: choose source */
    if (user.language_step === "source") {
      const choice = matchChoice(text);
      if (choice) {
        await supabase.from("users")
          .update({ source_lang:choice.code, language_step:"target" })
          .eq("phone_number",from);
        let p="✅ Got it! What language should I translate messages into?\n\n";
        for (const k of DIGITS) p+=`${k}️⃣ ${LANGS[k].name} (${LANGS[k].code})\n`;
        return res.send(`<Response><Message>${p}</Message></Response>`);
      }
      let p="👋 Welcome! What language are the messages you're receiving in?\n\n";
      for (const k of DIGITS) p+=`${k}️⃣ ${LANGS[k].name} (${LANGS[k].code})\n`;
      return res.send(`<Response><Message>${p}</Message></Response>`);
    }

    /* step 2: choose target */
    if (user.language_step === "target") {
      const choice = matchChoice(text);
      if (choice) {
        await supabase.from("users")
          .update({ target_lang:choice.code, language_step:"done" })
          .eq("phone_number",from);
        return res.send(`<Response><Message>✅ You're all set! Send a voice note or text to translate.</Message></Response>`);
      }
      let p="⚠️ Please choose the language I should translate into:\n\n";
      for (const k of DIGITS) p+=`${k}️⃣ ${LANGS[k].name} (${LANGS[k].code})\n`;
      return res.send(`<Response><Message>${p}</Message></Response>`);
    }

    /* translation phase */
    const src = user.source_lang, tgt = user.target_lang;
    const tgtVoice = Object.values(LANGS).find(l => l.code === tgt)?.tts || "en-US-Wavenet-D";

    /* VOICE */
    if (mUrl && mType?.startsWith("audio")) {
      const auth = "Basic "+Buffer.from(`${TWILIO_ACCOUNT_SID}:${TWILIO_AUTH_TOKEN}`).toString("base64");
      const raw  = `/tmp/raw_${Date.now()}`; const wav=`/tmp/wav_${Date.now()}.wav`;
      fs.writeFileSync(raw, await (await fetch(mUrl,{ headers:{ Authorization:auth }})).buffer());
      await convertAudio(raw,wav);
      const { text:orig } = await transcribe(wav);
      const tl0 = await translate(orig, tgt);
      const tl  = await polish(tl0, LANGS[DIGITS.find(k=>LANGS[k].code===tgt)].name);
      const url = await upload(await tts(tl, tgt, tgtVoice), `tts_${Date.now()}.mp3`);

      return res.send(`
        <Response>
          <Message>
🎤 Heard: ${orig}

🌎 Translated: ${tl}
            <Media>${url}</Media>
          </Message>
        </Response>`);
    }

    /* TEXT */
    if (text) {
      const tl0 = await translate(text, tgt);
      const tl  = await polish(tl0, LANGS[DIGITS.find(k=>LANGS[k].code===tgt)].name);
      const url = await upload(await tts(tl, tgt, tgtVoice), `tts_${Date.now()}.mp3`);

      return res.send(`
        <Response>
          <Message>
📝 Translated: ${tl}
            <Media>${url}</Media>
          </Message>
        </Response>`);
    }

    res.send(`<Response><Message>⚠️ Please send a voice note or text message.</Message></Response>`);

  } catch (err) {
    console.error("Webhook error:", err);
    return res.send(`<Response><Message>⚠️ Error processing message. Try again later.</Message></Response>`);
  }
});

app.get("/healthz",(_,r)=>r.status(200).send("OK"));
app.listen(PORT,()=>console.log(`🚀 Server listening on ${PORT}`));
