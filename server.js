/* ────────────────────────────────────────────────────────────────────────
   server.js  –  WhatsApp voice + text translator bot
   • 5-language pilot menu
   • Runtime Google-voice discovery (Neural2 → WaveNet → Standard)
   • Handles .m4a / .mp4 / .mp3 / .ogg / .wav
   • TTS fallback chain (always returns audio)
─────────────────────────────────────────────────────────────────────────*/
import express from "express";
import bodyParser from "body-parser";
import fetch from "node-fetch";
import fs from "fs";
import { randomUUID as uuid } from "crypto";
import OpenAI from "openai";
import { createClient } from "@supabase/supabase-js";
import * as dotenv from "dotenv";
dotenv.config();

/* ── env ── */
const {
  SUPABASE_URL,
  SUPABASE_KEY,
  OPENAI_API_KEY,
  GOOGLE_TTS_KEY,
  TWILIO_ACCOUNT_SID,
  TWILIO_AUTH_TOKEN,
  PORT = 8080
} = process.env;

/* ── clients ── */
const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);
const openai = new OpenAI({ apiKey: OPENAI_API_KEY });
const app = express();
app.use(bodyParser.urlencoded({ extended: false }));
app.use(bodyParser.json());

/* ── pilot languages ── */
const MENU = {
  1: { name: "English", code: "en" },
  2: { name: "Spanish", code: "es" },
  3: { name: "French", code: "fr" },
  4: { name: "Portuguese", code: "pt" },
  5: { name: "German", code: "de" }
};
const DIGITS = Object.keys(MENU);
const menu = (t) =>
  `${t}\n\n${DIGITS.map((d) => `${d}️⃣ ${MENU[d].name} (${MENU[d].code})`).join("\n")}`;
const pick = (txt) => {
  const m = txt.trim();
  const d = m.match(/^\d/);
  if (d && MENU[d]) return MENU[d];
  const lc = m.toLowerCase();
  return Object.values(MENU).find(
    (o) => o.code === lc || o.name.toLowerCase() === lc
  );
};
const twiml = (...l) =>
  `<Response>${l.map((x) => `\n<Message>${x}</Message>`).join("")}\n</Response>`;

/* ── Whisper transcription ── */
async function transcribe(filePath) {
  try {
    const r = await openai.audio.transcriptions.create({
      model: "whisper-large-v3",
      file: fs.createReadStream(filePath),
      response_format: "json"
    });
    return { text: r.text, lang: (r.language || "").slice(0, 2) };
  } catch {
    const r = await openai.audio.transcriptions.create({
      model: "whisper-1",
      file: fs.createReadStream(filePath),
      response_format: "json"
    });
    return { text: r.text, lang: (r.language || "").slice(0, 2) };
  }
}

/* ── Google Detect fallback ── */
const detect = async (q) =>
  (
    await fetch(
      `https://translation.googleapis.com/language/translate/v2/detect?key=${GOOGLE_TTS_KEY}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ q })
      }
    ).then((r) => r.json())
  ).data.detections[0][0].language;

/* ── OpenAI translate ── */
async function translate(text, target) {
  const r = await openai.chat.completions.create({
    model: "gpt-4o-mini",
    messages: [
      {
        role: "system",
        content: `Translate to ${target}. Return ONLY the translation.`
      },
      { role: "user", content: text }
    ],
    max_tokens: 400
  });
  return r.choices[0].message.content.trim();
}

/* ── runtime Google voice discovery ── */
let voiceCache = null;
async function loadVoices() {
  if (voiceCache) return;
  const { voices } = await fetch(
    `https://texttospeech.googleapis.com/v1/voices?key=${GOOGLE_TTS_KEY}`
  ).then((r) => r.json());
  voiceCache = voices.reduce((m, v) => {
    v.languageCodes.forEach((c) => (m[c] ??= []).push(v));
    return m;
  }, {});
}
(async () => {
  try {
    await loadVoices();
    console.log("🔊 voice cache ready");
  } catch (e) {
    console.error("Voice preload:", e.message);
  }
})();
async function pickVoice(lang) {
  await loadVoices();
  const list = voiceCache[lang] || [];
  return (
    list.find((v) => v.name.includes("Neural2")) ||
    list.find((v) => v.name.includes("WaveNet")) ||
    list.find((v) => v.name.includes("Standard")) || { name: "en-US-Standard-A" }
  ).name;
}

/* ── TTS with robust fallback ─ */
async function tts(text, langCode) {
  const synth = async (voiceName) => {
    const r = await fetch(
      `https://texttospeech.googleapis.com/v1/text:synthesize?key=${GOOGLE_TTS_KEY}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          input: { text },
          voice: { languageCode: langCode, name: voiceName },
          audioConfig: { audioEncoding: "MP3", speakingRate: 0.9 }
        })
      }
    ).then((r) => r.json());
    return r.audioContent ? Buffer.from(r.audioContent, "base64") : null;
  };

  const primary = await pickVoice(langCode);
  let buf = await synth(primary);
  if (buf) return buf;
  console.warn(`TTS primary voice failed (${primary}); retry default`);

  buf = await synth(langCode);
  if (buf) return buf;
  console.warn(`TTS default failed (${langCode}); retry en-US-Standard-A`);

  buf = await synth("en-US-Standard-A");
  if (buf) return buf;

  throw new Error(`TTS failed for ${langCode}`);
}

/* ── Supabase log helper ─ */
const logRow = (d) => supabase.from("translations").insert({ ...d, id: uuid() });

/* ── webhook ─ */
app.post("/webhook", async (req, res) => {
  console.log("📩 Incoming", {
    From: req.body.From,
    NumMedia: req.body.NumMedia
  });
  try {
    const phone = req.body.From;
    const body = (req.body.Body || "").trim();
    const mUrl = req.body.MediaUrl0;
    const mType = req.body.MediaContentType0 || "";

    /* reset */
    if (/^(reset|change language)$/i.test(body)) {
      await supabase
        .from("users")
        .upsert({
          phone_number: phone,
          language_step: "source",
          source_lang: null,
          target_lang: null
        });
      return res.send(
        twiml(menu("🔄 Setup reset!\nPick the language you RECEIVE:"))
      );
    }

    /* fetch user */
    let { data: u } = await supabase
      .from("users")
      .select("*")
      .eq("phone_number", phone)
      .single();
    if (!u) {
      await supabase
        .from("users")
        .insert({ phone_number: phone, language_step: "source" });
      u = { language_step: "source" };
    }

    /* source step */
    if (u.language_step === "source") {
      const c = pick(body);
      if (c) {
        await supabase
          .from("users")
          .update({ source_lang: c.code, language_step: "target" })
          .eq("phone_number", phone);
        return res.send(
          twiml(menu("✅ Now pick the language I should SEND:"))
        );
      }
      return res.send(twiml("❌ Reply 1-5.", menu("Languages:")));
    }

    /* target step */
    if (u.language_step === "target") {
      const c = pick(body);
      if (c) {
        if (c.code === u.source_lang)
          return res.send(
            twiml("⚠️ Target must differ from source. Pick again.", menu("Languages:"))
          );
        await supabase
          .from("users")
          .update({ target_lang: c.code, language_step: "ready" })
          .eq("phone_number", phone);
        return res.send(
          twiml("✅ Setup complete! Send text or a voice note.")
        );
      }
      return res.send(twiml("❌ Reply 1-5.", menu("Languages:")));
    }

    /* ensure ready */
    if (!u.source_lang || !u.target_lang)
      return res.send(twiml("⚠️ Setup incomplete. Text *reset* to start over."));

    /* ---- translation ---- */
    let original = "",
      detected = "";

    if (mUrl && mType.startsWith("audio")) {
      const auth =
        "Basic " +
        Buffer.from(
          `${TWILIO_ACCOUNT_SID}:${TWILIO_AUTH_TOKEN}`
        ).toString("base64");
      const buf = await fetch(mUrl, {
        headers: { Authorization: auth }
      }).then((r) => r.buffer());

      const ext = mType.includes("ogg")
        ? ".ogg"
        : mType.includes("mpeg")
        ? ".mp3"
        : mType.includes("mp4") || mType.includes("m4a")
        ? ".m4a"
        : ".dat";
      const raw = `/tmp/${uuid()}${ext}`;
      fs.writeFileSync(raw, buf);

      try {
        const { text, lang } = await transcribe(raw);
        original = text;
        detected = lang || (await detect(original)).slice(0, 2);
      } finally {
        fs.unlinkSync(raw);
      }
    } else if (body) {
      original = body;
      detected = (await detect(original)).slice(0, 2);
    }

    if (!original) return res.send(twiml("⚠️ Send text or a voice note."));

    const dest = detected === u.target_lang ? u.source_lang : u.target_lang;
    const translated = await translate(original, dest);
    await logRow({
      phone_number: phone,
      original_text: original,
      translated_text: translated,
      language_from: detected,
      language_to: dest
    });

    /* text reply */
    if (!mUrl) return res.send(twiml(translated));

    /* audio reply */
    try {
      const b64 = (await tts(translated, dest)).toString("base64");
      return res.send(
        twiml(
          `🗣 ${original}`,
          translated,
          `<Media>data:audio/mpeg;base64,${b64}</Media>`
        )
      );
    } catch (e) {
      console.error("TTS error", e.message);
      return res.send(twiml(`🗣 ${original}`, translated));
    }
  } catch (err) {
    console.error("Webhook error", err);
    return res.send(
      twiml("⚠️ Error processing voice note. Please try again.")
    );
  }
});

/* health */
app.get("/healthz", (_, r) => r.status(200).send("OK"));
app.listen(PORT, () => console.log("🚀 running on", PORT));
