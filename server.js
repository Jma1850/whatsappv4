// server.js – Universal Bi-Directional Translator (voice & text, with “Heard” + “Translated”)
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
  SUPABASE_URL, SUPABASE_KEY,
  OPENAI_API_KEY,
  GOOGLE_TRANSLATE_KEY, GOOGLE_TTS_KEY,
  TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN,
  PORT = 8080
} = process.env;

/* ─── Clients ─── */
const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);
const openai   = new OpenAI({ apiKey: OPENAI_API_KEY });

/* ─── Language Menu ─── */
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
  return Object.values(LANGS).find(
    v => c === v.code || c === v.name.toLowerCase()
  );
};

/* ─── Helpers ─── */
const convertAudio = (i, o) =>
  new Promise((res, rej) =>
    ffmpeg(i)
      .audioCodec("pcm_s16le")
      .outputOptions(["-ac", "1", "-ar", "16000", "-f", "wav"])
      .on("error", rej)
      .on("end", () => res(o))
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
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ q: text })
    }
  );
  const j = await res.json();
  return j.data.detections[0][0].language;
}

async function translate(text, target) {
  const res = await fetch(
    `https://translation.googleapis.com/language/translate/v2?key=${GOOGLE_TRANSLATE_KEY}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ q: text, target })
    }
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
      { role: "system", content: sys },
      { role: "user",   content: text }
    ],
    max_tokens: 400
  });
  return r.choices[0].message.content.trim();
}

async function tts(text, voice) {
  const languageCode = voice.split("-").slice(0, 2).join("-");
  const ssml = `<speak><prosody rate="90%">${text}</prosody></speak>`;

  // Try specified voice
  let j = await fetch(
    `https://texttospeech.googleapis.com/v1/text:synthesize?key=${GOOGLE_TTS_KEY}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        input: { ssml },
        voice: { languageCode, name: voice },
        audioConfig: { audioEncoding: "MP3" }
      })
    }
  ).then(r => r.json());

  // Fallback to default if named voice fails
  if (!j.audioContent) {
    j = await fetch(
      `https://texttospeech.googleapis.com/v1/text:synthesize?key=${GOOGLE_TTS_KEY}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          input: { ssml },
          voice: { languageCode },
          audioConfig: { audioEncoding: "MP3" }
        })
      }
    ).then(r => r.json());
    if (!j.audioContent) throw new Error("TTS error: " + JSON.stringify(j));
  }

  const path = `/tmp/tts_${Date.now()}.mp3`;
  fs.writeFileSync(path, Buffer.from(j.audioContent, "base64"));
  return path;
}

async function upload(path, filename) {
  const { error } = await supabase.storage
    .from("tts-voices")
    .upload(filename, fs.readFileSync(path), {
      contentType: "audio/mpeg",
      upsert: true
    });
  if (error) throw error;
  return `${SUPABASE_URL}/storage/v1/object/public/tts-voices/${filename}`;
}

/* ─── Express App ─── */
const app = express();
app.use(bodyParser.urlencoded({ extended: false }));
app.use(bodyParser.json());

app.post("/webhook", async (req, res) => {
  const from      = req.body.From;
  const bodyText  = (req.body.Body || "").trim();
  const mediaUrl  = req.body.MediaUrl0;
  const mediaType = req.body.MediaContentType0;

  try {
    // fetch or create user
    let { data: user } = await supabase
      .from("users")
      .select("source_lang,target_lang,language_step")
      .eq("phone_number", from)
      .single();

    if (!user) {
      await supabase.from("users").insert({
        phone_number: from,
        language_step: "source"
      });
      user = { language_step: "source" };
    }

    // reset command
    if (/^(change )?language$/i.test(bodyText)) {
      await supabase.from("users").update({
        language_step: "source",
        source_lang: null,
        target_lang: null
      }).eq("phone_number", from);

      let prompt = "🔄 Language setup reset!\nWhat language are the messages you're receiving in?\n\n";
      for (const k of DIGITS) {
        prompt += `${k}️⃣ ${LANGS[k].name} (${LANGS[k].code})\n`;
      }
      return res.send(`<Response><Message>${prompt}</Message></Response>`);
    }

    // step 1: source language
    if (user.language_step === "source") {
      const choice = matchChoice(bodyText);
      if (choice) {
        await supabase.from("users").update({
          source_lang: choice.code,
          language_step: "target"
        }).eq("phone_number", from);

        let prompt = "✅ Got it! What language should I translate messages into?\n\n";
        for (const k of DIGITS) {
          prompt += `${k}️⃣ ${LANGS[k].name} (${LANGS[k].code})\n`;
        }
        return res.send(`<Response><Message>${prompt}</Message></Response>`);
      }

      let prompt = "👋 Welcome! What language are the messages you're receiving in?\n\n";
      for (const k of DIGITS) {
        prompt += `${k}️⃣ ${LANGS[k].name} (${LANGS[k].code})\n`;
      }
      return res.send(`<Response><Message>${prompt}</Message></Response>`);
    }

    // step 2: target language
    if (user.language_step === "target") {
      const choice = matchChoice(bodyText);
      if (choice) {
        await supabase.from("users").update({
          target_lang: choice.code,
          language_step: "done"
        }).eq("phone_number", from);

        return res.send(`<Response><Message>✅ You're all set! Send a voice note or text to translate.</Message></Response>`);
      }

      let prompt = "⚠️ Please choose the language I should translate into:\n\n";
      for (const k of DIGITS) {
        prompt += `${k}️⃣ ${LANGS[k].name} (${LANGS[k].code})\n`;
      }
      return res.send(`<Response><Message>${prompt}</Message></Response>`);
    }

    // translation phase
    const src       = user.source_lang;
    const tgt       = user.target_lang;
    const voiceName = LANGS[DIGITS.find(k => LANGS[k].code === tgt)].voice;

    let original, detected;

    // if audio
    if (mediaUrl && mediaType?.startsWith("audio")) {
      const auth = "Basic " + Buffer.from(
        `${TWILIO_ACCOUNT_SID}:${TWILIO_AUTH_TOKEN}`
      ).toString("base64");

      const rawPath = `/tmp/raw_${Date.now()}.ogg`;
      const wavPath = `/tmp/wav_${Date.now()}.wav`;
      fs.writeFileSync(rawPath,
        await (await fetch(mediaUrl, { headers: { Authorization: auth } })).buffer()
      );

      await convertAudio(rawPath, wavPath);
      const r = await transcribe(wavPath);
      original = r.text;
      detected = (r.lang || "").slice(0, 2);

      // fallback detect if Whisper blank
      if (!detected) {
        detected = (await detectLang(original)).slice(0, 2);
      }
    }

    // if text
    if (bodyText && !mediaUrl) {
      original = bodyText;
      detected = (await detectLang(original)).slice(0, 2);
    }

    if (!original) {
      return res.send(`<Response><Message>⚠️ Please send a voice note or text message.</Message></Response>`);
    }

    // decide direction
    let dest = tgt;
    if (!detected)       dest = tgt;   // unknown → target
    else if (detected === tgt) dest = src;
    else if (detected === src) dest = tgt;
    else                     dest = src;

    // translate + polish
    const rawTranslated = await translate(original, dest);
    const polishedText  = await polish(rawTranslated, LANGS[DIGITS.find(k => LANGS[k].code === dest)].name);

    // TTS
    let mediaTag = "";
    try {
      const ttsPath = await tts(polishedText, voiceName);
      const publicUrl = await upload(ttsPath, `tts_${Date.now()}.mp3`);
      mediaTag = `<Media>${publicUrl}</Media>`;
    } catch (e) {
      console.error("TTS error:", e.message);
    }

    // TwiML reply: always include “Heard” + “Translated” text, and attach <Media> if audio
    res.set("Content-Type", "text/xml");
    return res.send(`
      <Response>
        <Message>
🗣 Heard (${detected || "unknown"}): ${original}

🌎 Translated (${dest}): ${polishedText}
${mediaTag}
        </Message>
      </Response>
    `);
  } catch (err) {
    console.error("Webhook error:", err);
    return res.send(`<Response><Message>⚠️ Error processing message. Try again later.</Message></Response>`);
  }
});

app.get("/healthz", (_, r) => r.status(200).send("OK"));
app.listen(PORT, () => console.log(`🚀 Server listening on ${PORT}`));
