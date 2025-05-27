// server.js – Universal Translator for WhatsApp (voice & text)
import express from "express";
import bodyParser from "body-parser";
import fetch from "node-fetch";
import ffmpeg from "fluent-ffmpeg";
import fs from "fs";
import OpenAI from "openai";
import { createClient } from "@supabase/supabase-js";
import dotenv from "dotenv";
dotenv.config();

/* ENV */
const {
  SUPABASE_URL, SUPABASE_KEY,
  OPENAI_API_KEY,
  GOOGLE_TRANSLATE_KEY, GOOGLE_TTS_KEY,
  TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN,
  PORT = 8080
} = process.env;

/* Clients */
const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);
const openai   = new OpenAI({ apiKey: OPENAI_API_KEY });

/* Language Menu */
const LANGS = {
  1: { name: "English",    code: "en", voice: "en-US-Wavenet-D"  },
  2: { name: "Spanish",    code: "es", voice: "es-ES-Neural2-A"  },
  3: { name: "French",     code: "fr", voice: "fr-FR-N  
CNN-B"  },
  4: { name: "Portuguese", code: "pt", voice: "pt-BR-Wavenet-A"  }
};
const DIGITS = Object.keys(LANGS);
const matchChoice = txt => {
  const c = txt.trim().toLowerCase();
  const d = c.match(/^\d/)?.[0];
  if (d && LANGS[d]) return LANGS[d];
  return Object.values(LANGS).find(v => c === v.code || c === v.name.toLowerCase());
};

/* Audio & AI Helpers */
const convert = (inP, outP) =>
  new Promise((res, rej) =>
    ffmpeg(inP)
      .audioCodec("pcm_s16le")
      .outputOptions(["-ac", "1", "-ar", "16000", "-f", "wav"])
      .on("error", rej)
      .on("end", () => res(outP))
      .save(outP)
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
  } catch (e) {
    const r = await openai.audio.transcriptions.create({
      model: "whisper-1",
      file: fs.createReadStream(wav),
      response_format: "json"
    });
    console.log("Whisper: whisper-1 fallback");
    return { text: r.text, lang: r.language || null };
  }
}

const detectLang = async txt => {
  const r = await fetch(
    `https://translation.googleapis.com/language/translate/v2/detect?key=${GOOGLE_TRANSLATE_KEY}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ q: txt })
    }
  );
  const j = await r.json();
  return j.data.detections[0][0].language;
};

const translate = async (txt, tgt) => {
  const r = await fetch(
    `https://translation.googleapis.com/language/translate/v2?key=${GOOGLE_TRANSLATE_KEY}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ q: txt, target: tgt })
    }
  );
  const j = await r.json();
  return j.data.translations[0].translatedText;
};

const polish = async (txt, langName) => {
  if (txt.trim().split(/\s+/).length < 3) return txt;
  const sys = `You are an expert native ${langName} copy-editor. Improve wording without changing meaning.`;
  const r = await openai.chat.completions.create({
    model: "gpt-4o-mini",
    messages: [
      { role: "system", content: sys },
      { role: "user", content: txt }
    ],
    max_tokens: 400
  });
  return r.choices[0].message.content.trim();
};

async function tts(text, voiceName) {
  const languageCode = voiceName.split("-").slice(0, 2).join("-");
  const ssml = `<speak><prosody rate="90%">${text}</prosody></speak>`;
  let j = await fetch(
    `https://texttospeech.googleapis.com/v1/text:synthesize?key=${GOOGLE_TTS_KEY}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        input: { ssml },
        voice: { languageCode, name: voiceName },
        audioConfig: { audioEncoding: "MP3" }
      })
    }
  ).then(r => r.json());

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

const upload = async (path, filename) => {
  const data = fs.readFileSync(path);
  const { error } = await supabase.storage
    .from("tts-voices")
    .upload(filename, data, { contentType: "audio/mpeg", upsert: true });
  if (error) throw error;
  return `${SUPABASE_URL}/storage/v1/object/public/tts-voices/${filename}`;
};

/* Express */
const app = express();
app.use(bodyParser.urlencoded({ extended: false }));
app.use(bodyParser.json());

app.post("/webhook", async (req, res) => {
  const from = req.body.From;
  const body = (req.body.Body || "").trim();
  const mediaUrl = req.body.MediaUrl0;
  const mediaType = req.body.MediaContentType0;

  try {
    // Fetch or create user
    let { data: user } = await supabase
      .from("users")
      .select("source_lang,target_lang,language_step")
      .eq("phone_number", from)
      .single();

    if (!user) {
      await supabase
        .from("users")
        .insert({ phone_number: from, language_step: "source" });
      user = { language_step: "source" };
    }

    // Reset command
    if (/^(change )?language$/i.test(body)) {
      await supabase
        .from("users")
        .update({ language_step: "source", source_lang: null, target_lang: null })
        .eq("phone_number", from);

      let prompt = `🔄 Language setup reset!
What language are the messages you're receiving in?\n\n`;
      for (const k of DIGITS) {
        prompt += `${k}️⃣ ${LANGS[k].name} (${LANGS[k].code})\n`;
      }
      return res.send(`<Response><Message>${prompt}</Message></Response>`);
    }

    // Step 1: choose source
    if (user.language_step === "source") {
      const choice = matchChoice(body);
      if (choice) {
        await supabase
          .from("users")
          .update({ source_lang: choice.code, language_step: "target" })
          .eq("phone_number", from);

        let prompt = `✅ Got it! What language should I translate messages into?\n\n`;
        for (const k of DIGITS) {
          prompt += `${k}️⃣ ${LANGS[k].name} (${LANGS[k].code})\n`;
        }
        return res.send(`<Response><Message>${prompt}</Message></Response>`);
      }

      let prompt = `👋 Welcome! What language are the messages you're receiving in?\n\n`;
      for (const k of DIGITS) {
        prompt += `${k}️⃣ ${LANGS[k].name} (${LANGS[k].code})\n`;
      }
      return res.send(`<Response><Message>${prompt}</Message></Response>`);
    }

    // Step 2: choose target
    if (user.language_step === "target") {
      const choice = matchChoice(body);
      if (choice) {
        await supabase
          .from("users")
          .update({ target_lang: choice.code, language_step: "done" })
          .eq("phone_number", from);

        return res.send(
          `<Response><Message>✅ You're all set! Send a voice note or text to translate.</Message></Response>`
        );
      }

      let prompt = `⚠️ Please choose the language I should translate into:\n\n`;
      for (const k of DIGITS) {
        prompt += `${k}️⃣ ${LANGS[k].name} (${LANGS[k].code})\n`;
      }
      return res.send(`<Response><Message>${prompt}</Message></Response>`);
    }

    // Translation phase (both audio & text)
    const src = user.source_lang;
    const tgt = user.target_lang;
    const voiceName = LANGS[DIGITS.find(k => LANGS[k].code === tgt)].voice;

    let orig, detected;

    // If it's a voice note
    if (mediaUrl && mediaType?.startsWith("audio")) {
      const auth =
        "Basic " +
        Buffer.from(`${TWILIO_ACCOUNT_SID}:${TWILIO_AUTH_TOKEN}`).toString("base64");

      const rawPath = `/tmp/raw_${Date.now()}.ogg`;
      const wavPath = `/tmp/wav_${Date.now()}.wav`;
      fs.writeFileSync(
        rawPath,
        await (await fetch(mediaUrl, { headers: { Authorization: auth } })).buffer()
      );

      await convert(rawPath, wavPath);
      const r = await transcribe(wavPath);
      orig = r.text;
      detected = (r.lang || "").slice(0, 2);

      // ── NEW fallback: if Whisper didn't detect, use Google_detect
      if (!detected) {
        detected = (await detectLang(orig)).slice(0, 2);
      }
    }

    // If it's text
    if (body && !mediaUrl) {
      orig = body;
      detected = (await detectLang(orig)).slice(0, 2);
    }

    if (!orig) {
      return res.send(
        `<Response><Message>⚠️ Please send a voice note or text message.</Message></Response>`
      );
    }

    // Decide direction (flip logic)
    let dest = tgt; // default translate into TARGET
    if (!detected) dest = tgt; // unknown → into TARGET
    else if (detected === tgt) dest = src;
    else if (detected === src) dest = tgt;
    else dest = src; // any other → into SOURCE

    // Perform translation + polish
    const rawTranslated = await translate(orig, dest);
    const polished = await polish(rawTranslated, LANGS[DIGITS.find(k => LANGS[k].code === dest)].name);

    // Generate TTS (with safe fallback)
    let mediaResponse = "";
    try {
      const ttsPath = await tts(polished, voiceName);
      const publicUrl = await upload(ttsPath, `tts_${Date.now()}.mp3`);
      mediaResponse = `<Media>${publicUrl}</Media>`;
    } catch (e) {
      console.error("TTS error:", e.message);
    }

    // Send back both text and (if available) audio
    res.set("Content-Type", "text/xml");
    return res.send(`
      <Response>
        <Message>
🗣 Heard (${detected || "unknown"}): ${orig}

🌎 Translated (${dest}): ${polished}
        </Message>
        ${mediaResponse}
      </Response>
    `);
  } catch (err) {
    console.error("Webhook error:", err);
    return res.send(
      `<Response><Message>⚠️ Error processing message. Try again later.</Message></Response>`
    );
  }
});

app.get("/healthz", (_, res) => res.status(200).send("OK"));
app.listen(PORT, () => console.log(`🚀 Server listening on ${PORT}`));
