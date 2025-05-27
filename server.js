// server.js – Bi-Directional Translator with Text-only Replies for Text Messages
import express from "express";
import bodyParser from "body-parser";
import fetch from "node-fetch";
import ffmpeg from "fluent-ffmpeg";
import fs from "fs";
import OpenAI from "openai";
import { createClient } from "@supabase/supabase-js";
import dotenv from "dotenv";
dotenv.config();

// ─── ENV ───
const {
  SUPABASE_URL, SUPABASE_KEY,
  OPENAI_API_KEY,
  GOOGLE_TRANSLATE_KEY, GOOGLE_TTS_KEY,
  TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN,
  PORT = 8080
} = process.env;

// ─── Clients ───
const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);
const openai   = new OpenAI({ apiKey: OPENAI_API_KEY });

// ─── Language Menu ───
const LANGS = {
  1: { name: "English",    code: "en", voice: "en-US-Wavenet-D"   },
  2: { name: "Spanish",    code: "es", voice: "es-ES-Neural2-A"   },
  3: { name: "French",     code: "fr", voice: "fr-FR-Wavenet-B"   },
  4: { name: "Portuguese", code: "pt", voice: "pt-BR-Wavenet-A"   }
};
const DIGITS = Object.keys(LANGS);
const matchChoice = txt => {
  const c = txt.trim().toLowerCase();
  const d = c.match(/^\d/)?.[0];
  if (d && LANGS[d]) return LANGS[d];
  return Object.values(LANGS)
    .find(v => c === v.code || c === v.name.toLowerCase());
};

// ─── Helpers ───
const convertAudio = (i,o) =>
  new Promise((r,j)=> ffmpeg(i)
    .audioCodec("pcm_s16le")
    .outputOptions(["-ac","1","-ar","16000","-f","wav"])
    .on("error", j)
    .on("end", ()=>r(o))
    .save(o)
  );

async function transcribe(wav) {
  try {
    const r = await openai.audio.transcriptions.create({
      model: "whisper-large-v3",
      file: fs.createReadStream(wav),
      response_format: "json"
    });
    console.log("Whisper: large-v3");
    return { text: r.text, lang: r.language || null };
  } catch {
    const r = await openai.audio.transcriptions.create({
      model: "whisper-1",
      file: fs.createReadStream(wav),
      response_format: "json"
    });
    console.log("Whisper: whisper-1 fallback");
    return { text: r.text, lang: r.language || null };
  }
}

async function detectLang(text) {
  const res = await fetch(
    `https://translation.googleapis.com/language/translate/v2/detect?key=${GOOGLE_TRANSLATE_KEY}`,
    { method:"POST", headers:{ "Content-Type":"application/json" },
      body: JSON.stringify({ q: text }) }
  );
  const j = await res.json();
  return j.data.detections[0][0].language;
}

async function translate(text, target) {
  const res = await fetch(
    `https://translation.googleapis.com/language/translate/v2?key=${GOOGLE_TRANSLATE_KEY}`,
    { method:"POST", headers:{ "Content-Type":"application/json" },
      body: JSON.stringify({ q: text, target }) }
  );
  const j = await res.json();
  return j.data.translations[0].translatedText;
}

async function polish(text, langName) {
  if (text.trim().split(/\s+/).length < 3) return text;
  const sys = `You are an expert native ${langName} copy-editor. Improve wording without changing meaning.`;
  const r = await openai.chat.completions.create({
    model: "gpt-4o-mini",
    messages: [
      { role:"system", content: sys },
      { role:"user",   content: text }
    ],
    max_tokens: 400
  });
  return r.choices[0].message.content.trim();
}

async function tts(text, voice, rate="90%") {
  const languageCode = voice.split("-").slice(0,2).join("-");
  const ssml = `<speak><prosody rate="${rate}">${text}</prosody></speak>`;

  let j = await fetch(
    `https://texttospeech.googleapis.com/v1/text:synthesize?key=${GOOGLE_TTS_KEY}`,
    { method:"POST", headers:{ "Content-Type":"application/json" },
      body: JSON.stringify({
        input:{ ssml },
        voice:{ languageCode, name: voice },
        audioConfig:{ audioEncoding:"MP3" }
      }) }
  ).then(r => r.json());

  if (!j.audioContent) {
    j = await fetch(
      `https://texttospeech.googleapis.com/v1/text:synthesize?key=${GOOGLE_TTS_KEY}`,
      { method:"POST", headers:{ "Content-Type":"application/json" },
        body: JSON.stringify({
          input:{ ssml },
          voice:{ languageCode },
          audioConfig:{ audioEncoding:"MP3" }
        }) }
    ).then(r => r.json());
    if (!j.audioContent) throw new Error("TTS error:"+JSON.stringify(j));
  }

  const path = `/tmp/tts_${Date.now()}.mp3`;
  fs.writeFileSync(path, Buffer.from(j.audioContent,"base64"));
  return path;
}

async function upload(path, filename) {
  const data = fs.readFileSync(path);
  const { error } = await supabase.storage
    .from("tts-voices")
    .upload(filename, data, { contentType:"audio/mpeg", upsert:true });
  if (error) throw error;
  return `${SUPABASE_URL}/storage/v1/object/public/tts-voices/${filename}`;
}

// ─── Express App ───
const app = express();
app.use(bodyParser.urlencoded({ extended:false }));
app.use(bodyParser.json());

app.post("/webhook", async (req, res) => {
  const from      = req.body.From;
  const bodyText  = (req.body.Body||"").trim();
  const mediaUrl  = req.body.MediaUrl0;
  const mediaType = req.body.MediaContentType0;

  try {
    // fetch or create user row
    let { data:user } = await supabase
      .from("users")
      .select("source_lang,target_lang,language_step,tts_rate")
      .eq("phone_number", from)
      .single();
    if (!user) {
      await supabase.from("users").insert({
        phone_number: from,
        language_step: "source",
        tts_rate: "90%"
      });
      user = { language_step: "source", tts_rate: "90%" };
    }

    // reset command
    if (/^(change )?language$/i.test(bodyText)) {
      await supabase.from("users").update({
        language_step: "source",
        source_lang: null,
        target_lang: null,
        tts_rate: "90%"
      }).eq("phone_number", from);

      let p = "🔄 Setup reset!\nWhat language are the messages you're receiving in?\n\n";
      for (const k of DIGITS) p += `${k}️⃣ ${LANGS[k].name} (${LANGS[k].code})\n`;
      return res.send(`<Response><Message>${p}</Message></Response>`);
    }

    // source selection
    if (user.language_step === "source") {
      const c = matchChoice(bodyText);
      if (c) {
        await supabase.from("users").update({
          source_lang: c.code,
          language_step: "target"
        }).eq("phone_number", from);

        let p = "✅ Got it! What language should I translate messages into?\n\n";
        for (const k of DIGITS) p += `${k}️⃣ ${LANGS[k].name} (${LANGS[k].code})\n`;
        return res.send(`<Response><Message>${p}</Message></Response>`);
      }
      let p = "👋 Welcome! What language are the messages you're receiving in?\n\n";
      for (const k of DIGITS) p += `${k}️⃣ ${LANGS[k].name} (${LANGS[k].code})\n`;
      return res.send(`<Response><Message>${p}</Message></Response>`);
    }

    // target selection
    if (user.language_step === "target") {
      const c = matchChoice(bodyText);
      if (c) {
        await supabase.from("users").update({
          target_lang: c.code,
          language_step: "voice"
        }).eq("phone_number", from);
        return res.send(`<Response><Message>
✅ Finally, choose voice speed:
1️⃣ Normal
2️⃣ Slow
</Message></Response>`);
      }
      let p = "⚠️ Please choose the language I should translate into:\n\n";
      for (const k of DIGITS) p += `${k}️⃣ ${LANGS[k].name} (${LANGS[k].code})\n`;
      return res.send(`<Response><Message>${p}</Message></Response>`);
    }

    // voice speed selection
    if (user.language_step === "voice") {
      let rate = "90%";
      if (/^2$/.test(bodyText) || /slow/i.test(bodyText)) rate = "80%";
      await supabase.from("users").update({
        tts_rate: rate,
        language_step: "done"
      }).eq("phone_number", from);
      return res.send(`<Response><Message>✅ Setup complete! Send a voice note or text.</Message></Response>`);
    }

    // translation phase
    const src       = user.source_lang;
    const tgt       = user.target_lang;
    const rate      = user.tts_rate;
    const voiceName = LANGS[DIGITS.find(k=>LANGS[k].code===tgt)].voice;

    // --- AUDIO PATH ---
    if (mediaUrl && mediaType?.startsWith("audio")) {
      const auth = "Basic "+Buffer.from(`${TWILIO_ACCOUNT_SID}:${TWILIO_AUTH_TOKEN}`).toString("base64");
      const raw = `/tmp/raw_${Date.now()}.ogg`;
      const wav = `/tmp/wav_${Date.now()}.wav`;
      fs.writeFileSync(raw, await (await fetch(mediaUrl,{headers:{Authorization:auth}})).buffer());
      await convertAudio(raw,wav);
      const r = await transcribe(wav);
      let orig = r.text;
      let det  = (r.lang||"").slice(0,2);
      if (!det) det = (await detectLang(orig)).slice(0,2);

      // decide direction
      let dest = (det===tgt ? src : tgt);

      // translate & polish
      const rawT = await translate(orig, dest);
      const pol  = await polish(rawT, LANGS[DIGITS.find(k=>LANGS[k].code===dest)].name);

      // build three TwiML messages
      let resp = `<Response>\n`;
      resp += `  <Message>🗣 Heard (${det||"unknown"}): ${orig}</Message>\n`;
      resp += `  <Message>🌎 Translated (${dest}): ${pol}</Message>\n`;

      // TTS + media
      try {
        const mp3 = await tts(pol, voiceName, rate);
        const url = await upload(mp3, `tts_${Date.now()}.mp3`);
        resp += `  <Message><Media>${url}</Media></Message>\n`;
      } catch(e) {
        console.error("TTS error:", e.message);
      }

      resp += `</Response>`;
      res.set("Content-Type","text/xml");
      return res.send(resp);
    }

    // --- TEXT PATH ---
    if (bodyText) {
      const det = (await detectLang(bodyText)).slice(0,2);
      let dest = (det===tgt ? src : tgt);

      const rawT = await translate(bodyText, dest);
      const pol  = await polish(rawT, LANGS[DIGITS.find(k=>LANGS[k].code===dest)].name);

      res.set("Content-Type","text/xml");
      return res.send(`
        <Response>
          <Message>🌎 Translated (${dest}): ${pol}</Message>
        </Response>`);
    }

    // fallback
    return res.send(`<Response><Message>⚠️ Please send a voice note or text message.</Message></Response>`);
  } catch (err) {
    console.error("Webhook error:", err);
    return res.send(`<Response><Message>⚠️ Error processing message. Try again later.</Message></Response>`);
  }
});

app.get("/healthz", (_, r) => r.status(200).send("OK"));
app.listen(PORT, () => console.log(`🚀 Server listening on ${PORT}`));
