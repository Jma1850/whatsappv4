/* ────────────────────────────────────────────────────────────────────────
   server.js – WhatsApp voice+text translator bot
   • 5-language pilot menu
   • Runtime voice discovery (Neural2→WaveNet→Standard)
   • Robust audio flow: detects real Content-Type, converts to WAV, whispers
   • TTS fallback chain: primary→lang default→en-US-Standard-A
   • Two-step setup + reset command + flip logic + logging
─────────────────────────────────────────────────────────────────────────*/
import express   from "express";
import bodyParser from "body-parser";
import fetch     from "node-fetch";
import ffmpeg    from "fluent-ffmpeg";
import fs        from "fs";
import { randomUUID as uuid } from "crypto";
import OpenAI    from "openai";
import { createClient } from "@supabase/supabase-js";
import * as dotenv from "dotenv";
dotenv.config();

/* ── ENV ── */
const {
  SUPABASE_URL, SUPABASE_KEY,
  OPENAI_API_KEY, GOOGLE_TTS_KEY,
  TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN,
  PORT = 8080
} = process.env;

/* ── CLIENTS ── */
const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);
const openai   = new OpenAI({ apiKey: OPENAI_API_KEY });

/* ── EXPRESS SETUP ── */
const app = express();
app.use(bodyParser.urlencoded({ extended: false }));
app.use(bodyParser.json());

/* ── PILOT LANGUAGES ── */
const MENU = {
  1: { name: "English",    code: "en" },
  2: { name: "Spanish",    code: "es" },
  3: { name: "French",     code: "fr" },
  4: { name: "Portuguese", code: "pt" },
  5: { name: "German",     code: "de" }
};
const DIGITS = Object.keys(MENU);
const menuMsg = title =>
  `${title}\n\n` +
  DIGITS.map(d => `${d}️⃣ ${MENU[d].name} (${MENU[d].code})`).join("\n");
const pickLang = txt => {
  const m = txt.trim();
  const d = m.match(/^\d/);
  if (d && MENU[d]) return MENU[d];
  const lc = m.toLowerCase();
  return Object.values(MENU).find(
    o => o.code === lc || o.name.toLowerCase() === lc
  );
};
const twiml = (...lines) =>
  `<Response>${lines.map(l => `\n<Message>${l}</Message>`).join("")}\n</Response>`;

/* ── FFMPEG (convert any format → 16k WAV) ── */
const toWav = (inFile, outFile) =>
  new Promise((res, rej) =>
    ffmpeg(inFile)
      .audioCodec("pcm_s16le")
      .outputOptions(["-ac", "1", "-ar", "16000", "-f", "wav"])
      .on("error", rej)
      .on("end", () => res(outFile))
      .save(outFile)
  );

/* ── Whisper (reads WAV) ── */
async function whisper(wavPath) {
  try {
    const r = await openai.audio.transcriptions.create({
      model: "whisper-large-v3",
      file: fs.createReadStream(wavPath),
      response_format: "json"
    });
    return { txt: r.text, lang: (r.language || "").slice(0, 2) };
  } catch {
    const r = await openai.audio.transcriptions.create({
      model: "whisper-1",
      file: fs.createReadStream(wavPath),
      response_format: "json"
    });
    return { txt: r.text, lang: (r.language || "").slice(0, 2) };
  }
}

/* ── Google Detect fallback ── */
const detectLang = async q =>
  (
    await fetch(
      `https://translation.googleapis.com/language/translate/v2/detect?key=${GOOGLE_TTS_KEY}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ q })
      }
    ).then(r => r.json())
  ).data.detections[0][0].language;

/* ── OpenAI Translate ── */
async function translate(text, target) {
  const r = await openai.chat.completions.create({
    model: "gpt-4o-mini",
    messages: [
      { role: "system", content: `Translate to ${target}. Return ONLY the translation.` },
      { role: "user", content: text }
    ],
    max_tokens: 400
  });
  return r.choices[0].message.content.trim();
}

/* ── Runtime voice discovery ── */
let voiceCache = null;
async function loadVoices() {
  if (voiceCache) return;
  const { voices } = await fetch(
    `https://texttospeech.googleapis.com/v1/voices?key=${GOOGLE_TTS_KEY}`
  ).then(r => r.json());
  voiceCache = voices.reduce((map, v) => {
    v.languageCodes.forEach(c => (map[c] ||= []).push(v));
    return map;
  }, {});
}
(async () => {
  try {
    await loadVoices();
    console.log("🔊 voice cache ready");
  } catch (e) {
    console.error("Voice preload error:", e.message);
  }
})();
async function pickVoice(lang) {
  await loadVoices();
  const list = voiceCache[lang] || [];
  return (
    list.find(v => v.name.includes("Neural2")) ||
    list.find(v => v.name.includes("WaveNet")) ||
    list.find(v => v.name.includes("Standard")) ||
    { name: "en-US-Standard-A" }
  ).name;
}

/* ── TTS with three-step fallback ── */
async function tts(text, lang) {
  const voiceName = await pickVoice(lang);
  let actualLang = lang;

  // If pickVoice resulted in the ultimate fallback, ensure the language code matches.
  if (voiceName === "en-US-Standard-A") {
    actualLang = "en-US";
  }

  const call = async (nameToUse, langToUse) => {
    const r = await fetch(
      `https://texttospeech.googleapis.com/v1/text:synthesize?key=${GOOGLE_TTS_KEY}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          input: { text },
          voice: { languageCode: langToUse, name: nameToUse },
          audioConfig: { audioEncoding: "MP3", speakingRate: 0.9 }
        })
      }
    ).then(r => r.json());
    return r.audioContent ? Buffer.from(r.audioContent, "base64") : null;
  };

  const buf = await call(voiceName, actualLang);
  if (buf) return buf;

  throw new Error(`TTS failed for ${lang} with voice ${voiceName}`);
}

/* ── Supabase logging ── */
const logRow = d => supabase.from("translations").insert({ ...d, id: uuid() });

/* ── Webhook ── */
app.post("/webhook", async (req, res) => {
  // Robust param extraction (case-insensitive)
  const body = req.body;
  const fromKey = Object.keys(body).find(k => /^From$/i.test(k));
  const phone   = fromKey ? body[fromKey] : null;
  const textKey = Object.keys(body).find(k => /^Body$/i.test(k));
  const text    = textKey ? (body[textKey] || "").trim() : "";
  const numKey  = Object.keys(body).find(k => /^NumMedia$/i.test(k));
  const numMed  = numKey ? parseInt(body[numKey], 10) : 0;
  const urlKey  = Object.keys(body).find(k => /^MediaUrl0$/i.test(k));
  const mUrl    = urlKey ? body[urlKey] : null;

  console.log("📩 Incoming", { phone, numMedia: numMed, mUrl });

  try {
    // Reset flow
    if (/^(reset|change language)$/i.test(text)) {
      await supabase
        .from("users")
        .upsert({
          phone_number: phone,
          language_step: "source",
          source_lang: null,
          target_lang: null
        });
      return res.send(twiml(menuMsg("🔄 Setup reset!\nPick the language you RECEIVE:")));
    }

    // Fetch or create user
    let { data: u } = await supabase
      .from("users")
      .select("*")
      .eq("phone_number", phone)
      .single();

    if (!u) {
      await supabase.from("users").insert({
        phone_number: phone,
        language_step: "source"
      });
      u = { language_step: "source" };
    }

    // Step 1: choose source language
    if (u.language_step === "source") {
      const c = pickLang(text);
      if (c) {
        await supabase
          .from("users")
          .update({ source_lang: c.code, language_step: "target" })
          .eq("phone_number", phone);
        return res.send(twiml(menuMsg("✅ Now pick the language I should SEND:")));
      }
      return res.send(twiml("❌ Reply 1-5.", menuMsg("Languages:")));
    }

    // Step 2: choose target language
    if (u.language_step === "target") {
      const c = pickLang(text);
      if (c) {
        if (c.code === u.source_lang)
          return res.send(
            twiml(
              "⚠️ Target must differ from source. Pick again.",
              menuMsg("Languages:")
            )
          );
        await supabase
          .from("users")
          .update({ target_lang: c.code, language_step: "ready" })
          .eq("phone_number", phone);
        return res.send(twiml("✅ Setup complete! Send text or a voice note."));
      }
      return res.send(twiml("❌ Reply 1-5.", menuMsg("Languages:")));
    }

    // Ensure setup done
    if (!u.source_lang || !u.target_lang)
      return res.send(twiml("⚠️ Setup incomplete. Text *reset* to start over."));

    // Translation phase
    let original = "", detected = "";

    if (numMed > 0 && mUrl) {
      // Download with auth
      const auth = "Basic " + Buffer.from(
        `${TWILIO_ACCOUNT_SID}:${TWILIO_AUTH_TOKEN}`
      ).toString("base64");

      const resp = await fetch(mUrl, { headers: { Authorization: auth } });
      const buf  = await resp.arrayBuffer();
      const ctype = resp.headers.get("content-type") || "";
      const ext = ctype.includes("ogg")
        ? ".ogg"
        : ctype.includes("mpeg")
        ? ".mp3"
        : ctype.includes("mp4") || ctype.includes("m4a")
        ? ".m4a"
        : ".dat";

      const raw = `/tmp/${uuid()}${ext}`;
      const wav = raw.replace(ext, ".wav");
      fs.writeFileSync(raw, Buffer.from(buf));
      await toWav(raw, wav);

      try {
        const { txt, lang } = await whisper(wav);
        original = txt;
        detected = lang || (await detectLang(original)).slice(0, 2);
      } finally {
        fs.unlinkSync(raw);
        fs.unlinkSync(wav);
      }
    } else if (text) {
      original = text;
      detected = (await detectLang(original)).slice(0, 2);
    }

    if (!original)
      return res.send(twiml("⚠️ Send text or a voice note."));

    const dest = detected === u.target_lang ? u.source_lang : u.target_lang;
    const translated = await translate(original, dest);

    await logRow({
      phone_number: phone,
      original_text: original,
      translated_text: translated,
      language_from: detected,
      language_to: dest
    });

    // Text reply
    if (numMed === 0) return res.send(twiml(translated));

    // Audio reply
    try {
      const mp3 = (await tts(translated, dest)).toString("base64");
      return res.send(
        twiml(
          `🗣 ${original}`,
          translated,
          `<Media>data:audio/mpeg;base64,${mp3}</Media>`
        )
      );
    } catch (e) {
      console.error("TTS error:", e.message);
      return res.send(twiml(`🗣 ${original}`, translated));
    }
  } catch (err) {
    console.error("Webhook error:", err);
    return res.send(twiml("⚠️ Error processing message. Please try again."));
  }
});

/* health */
app.get("/healthz", (_, r) => r.status(200).send("OK"));
app.listen(PORT, () => console.log("🚀 running on", PORT));
