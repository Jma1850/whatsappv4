/* ───────────────────────────────────────────────────────────────────────
   TuCan server.js  —  WhatsApp voice↔text translator bot
   » 5-language setup     » Whisper / GPT-4o translate
   » Google TTS voices    » Stripe pay-wall (5 free msgs)
   » Supabase logging     » Resilient to duplicate rows / null pings
────────────────────────────────────────────────────────────────────────*/
import express      from "express";
import bodyParser   from "body-parser";
import fetch        from "node-fetch";
import ffmpeg       from "fluent-ffmpeg";
import fs           from "fs";
import { randomUUID as uuid } from "crypto";
import OpenAI       from "openai";
import Stripe       from "stripe";
import { createClient } from "@supabase/supabase-js";
import * as dotenv  from "dotenv";
dotenv.config();

/* — debug presence of service‐role key — */
console.log("→ SUPABASE_URL:", Boolean(process.env.SUPABASE_URL));
console.log("→ SUPABASE_SERVICE_ROLE_KEY present?", Boolean(process.env.SUPABASE_SERVICE_ROLE_KEY));

/* — global crash guard — */
process.on("unhandledRejection", r => console.error("🔴 UNHANDLED", r));

/* — ENV / CLIENTS — */
const {
  SUPABASE_URL,
  SUPABASE_SERVICE_ROLE_KEY,
  OPENAI_API_KEY,
  GOOGLE_TTS_KEY,
  STRIPE_SECRET_KEY,
  STRIPE_WEBHOOK_SECRET,
  PRICE_MONTHLY,
  PRICE_ANNUAL,
  PRICE_LIFE,
  TWILIO_ACCOUNT_SID,
  TWILIO_AUTH_TOKEN,
  PORT = 8080
} = process.env;

// use the service-role key here:
const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
const openai   = new OpenAI({ apiKey: OPENAI_API_KEY });
const stripe   = new Stripe(STRIPE_SECRET_KEY, { apiVersion: "2023-10-16" });

/* — EXPRESS — */
const app = express();

/* ==================================================================== */
/* 1️⃣  STRIPE RAW-BODY WEBHOOK (must come before json/urlencoded parsers) */
/* ==================================================================== */
app.post("/stripe-webhook",
  bodyParser.raw({ type: "application/json" }),
  async (req, res) => {
    let event;
    try {
      event = stripe.webhooks.constructEvent(
        req.body,
        req.headers["stripe-signature"],
        STRIPE_WEBHOOK_SECRET
      );
    } catch (e) {
      console.error("stripe sig err", e.message);
      return res.sendStatus(400);
    }

    if (event.type === "checkout.session.completed") {
      const s    = event.data.object;
      const tier = s.metadata.tier;
      const plan = tier === "monthly" ? "MONTHLY"
                : tier === "annual"  ? "ANNUAL"
                : "LIFETIME";

      // try update by stripe_cust_id
      const upd1 = await supabase
        .from("users")
        .update({
          plan,
          free_used: 0,
          stripe_sub_id: tier === "life" ? null : s.subscription
        })
        .eq("stripe_cust_id", s.customer)
        .select("id");
      console.log("Supabase update by stripe_cust_id:", upd1);

      if (upd1.error || upd1.data.length === 0) {
        console.warn("❗ No row matched stripe_cust_id, falling back to UID:", s.metadata.uid);
        const upd2 = await supabase
          .from("users")
          .update({
            plan,
            free_used: 0,
            stripe_cust_id: s.customer,
            stripe_sub_id: tier === "life" ? null : s.subscription
          })
          .eq("id", s.metadata.uid)
          .select("id");
        console.log("Supabase fallback update by UID:", upd2);
      } else {
        console.log("✅ Plan upgraded by stripe_cust_id →", upd1.data[0].id);
      }
    }

    if (event.type === "customer.subscription.deleted") {
      const sub = event.data.object;
      const upd3 = await supabase
        .from("users")
        .update({ plan: "FREE" })
        .eq("stripe_sub_id", sub.id)
        .select("id");
      console.log("Subscription cancelled, reset to FREE:", upd3);
    }

    res.json({ received: true });
  });

/* ==================================================================== */
/* 2️⃣  TWILIO & GENERAL PARSERS                                        */
/* ==================================================================== */
app.use(bodyParser.urlencoded({ extended: false }));   // Twilio form posts

/* — Helper constants & functions — */
const MENU = {
  1: { name: "English",    code: "en" },
  2: { name: "Spanish",    code: "es" },
  3: { name: "French",     code: "fr" },
  4: { name: "Portuguese", code: "pt" },
  5: { name: "German",     code: "de" },
};
const DIGITS = Object.keys(MENU);
const menuMsg = t =>
  `${t}\n\n${DIGITS.map(d => `${d}️⃣ ${MENU[d].name} (${MENU[d].code})`).join("\n")}`;
const pickLang = txt => {
  const m = txt.trim(), d = m.match(/^\d/);
  if (d && MENU[d[0]]) return MENU[d[0]];
  const lc = m.toLowerCase();
  return Object.values(MENU).find(o =>
    o.code === lc || o.name.toLowerCase() === lc
  );
};
const twiml = (...l) =>
  `<Response>${l.map(x => `\n<Message>${x}</Message>`).join("")}\n</Response>`;

const paywallMsg = `⚠️ You’ve used your 5 free translations.

Reply with:
1️⃣  Monthly  $4.99
2️⃣  Annual   $49.99
3️⃣  Lifetime $199`;

const toWav = (i, o) =>
  new Promise((res, rej) =>
    ffmpeg(i).audioCodec("pcm_s16le")
      .outputOptions(["-ac","1","-ar","16000","-f","wav"])
      .on("error", rej)
      .on("end", () => res(o))
      .save(o)
  );

async function whisper(wav) {
  try {
    const r = await openai.audio.transcriptions.create({
      model: "whisper-large-v3",
      file: fs.createReadStream(wav),
      response_format: "json"
    });
    return { txt: r.text, lang: (r.language||"").slice(0,2) };
  } catch {
    const r = await openai.audio.transcriptions.create({
      model: "whisper-1",
      file: fs.createReadStream(wav),
      response_format: "json"
    });
    return { txt: r.text, lang: (r.language||"").slice(0,2) };
  }
}

const detectLang = async q =>
  (await fetch(
    `https://translation.googleapis.com/language/translate/v2/detect?key=${GOOGLE_TTS_KEY}`,
    { method:"POST", headers:{"Content-Type":"application/json"}, body: JSON.stringify({q}) }
  ).then(r=>r.json()))
    .data.detections[0][0].language;

async function translate(text, target) {
  const r = await openai.chat.completions.create({
    model:"gpt-4o-mini",
    messages:[
      { role:"system", content:`Translate to ${target}. Return ONLY the translation.` },
      { role:"user",   content:text }
    ],
    max_tokens:400
  });
  return r.choices[0].message.content.trim();
}

let voiceCache = null;
async function loadVoices() {
  if (voiceCache) return;
  const { voices } = await fetch(
    `https://texttospeech.googleapis.com/v1/voices?key=${GOOGLE_TTS_KEY}`
  ).then(r=>r.json());
  voiceCache = voices.reduce((m,v)=>{
    v.languageCodes.forEach(full=>{
      const code = full.split("-",1)[0];
      (m[code] ||= []).push(v);
    });
    return m;
  },{});
}
(async()=>{ try{ await loadVoices(); console.log("🔊 voice cache ready"); } catch(e){console.error(e);} })();

async function pickVoice(lang, gender) {
  await loadVoices();
  let list = (voiceCache[lang]||[]).filter(v=>v.ssmlGender===gender);
  if (!list.length) list = voiceCache[lang]||[];
  return (
    list.find(v=>v.name.includes("Neural2")) ||
    list.find(v=>v.name.includes("WaveNet")) ||
    list.find(v=>v.name.includes("Standard")) ||
    { name:"en-US-Standard-A" }
  ).name;
}

async function tts(text, lang, gender) {
  const synth = async name => {
    const lc = name.split("-",2).join("-");
    const r = await fetch(
      `https://texttospeech.googleapis.com/v1/text:synthesize?key=${GOOGLE_TTS_KEY}`,
      {
        method:"POST",
        headers:{"Content-Type":"application/json"},
        body: JSON.stringify({
          input:{text},
          voice:{languageCode:lc,name},
          audioConfig:{audioEncoding:"MP3",speakingRate:0.9}
        })
      }
    ).then(r=>r.json());
    return r.audioContent?Buffer.from(r.audioContent,"base64"):null;
  };
  let buf = await synth(await pickVoice(lang,gender)); if(buf) return buf;
  buf = await synth(lang);                if(buf) return buf;
  buf = await synth("en-US-Standard-A"); if(buf) return buf;
  throw new Error("TTS failed");
}

async function uploadAudio(buffer) {
  const fn = `tts_${uuid()}.mp3`;
  const { error } = await supabase
    .storage.from("tts-voices")
    .upload(fn, buffer, { contentType:"audio/mpeg", upsert:true });
  if (error) throw error;
  return `${SUPABASE_URL}/storage/v1/object/public/tts-voices/${fn}`;
}

async function ensureCustomer(u) {
  if (u.stripe_cust_id) return u.stripe_cust_id;
  const c = await stripe.customers.create({ description:`TuCan ${u.phone_number}` });
  await supabase.from("users").update({ stripe_cust_id: c.id }).eq("id", u.id);
  return c.id;
}

async function checkoutUrl(u, tier) {
  const price = tier==="monthly"?PRICE_MONTHLY:tier==="annual"?PRICE_ANNUAL:PRICE_LIFE;
  const s = await stripe.checkout.sessions.create({
    mode: tier==="life"?"payment":"subscription",
    customer: await ensureCustomer(u),
    line_items: [{ price, quantity:1 }],
    success_url: "https://checkout.stripe.com/success",
    cancel_url:  "https://checkout.stripe.com/cancel",
    metadata:{ tier }
  });
  return s.url;
}

const logRow = d => supabase.from("translations").insert({ ...d, id:uuid() });

/* ==================================================================== */
/*  TWILIO WHATSAPP WEBHOOK                                             */
/* ==================================================================== */
app.post("/webhook", async (req, res) => {
  const { From: from, Body: raw, NumMedia, MediaUrl0: url } = req.body;
  if (!from) return res.sendStatus(200);

  const text = (raw||"").trim();
  const num  = parseInt(NumMedia||"0",10);

  let { data: user } = await supabase
    .from("users")
    .select("*")
    .eq("phone_number", from)
    .single();

  if (!user) {
    const { data: newUser, error } = await supabase
      .from("users")
      .upsert(
        { phone_number: from, language_step: "source", plan: "FREE", free_used: 0 },
        { onConflict: ["phone_number"] }
      )
      .select("*")
      .single();
    if (error) throw error;
    user = newUser;
  }
  const isFree = !user.plan || user.plan === "FREE";

  if (/^[1-3]$/.test(text) && isFree && user.free_used >= 5) {
    const tier = text==="1"?"monthly":text==="2"?"annual":"life";
    try {
      const link = await checkoutUrl(user, tier);
      return res.send(twiml(`Tap to pay → ${link}`));
    } catch(e) {
      console.error("Stripe checkout error:", e.message);
      return res.send(twiml("⚠️ Payment link error. Try again later."));
    }
  }

  if (/^(reset|change language)$/i.test(text)) {
    await supabase
      .from("users")
      .update({ language_step:"source", source_lang:null, target_lang:null, voice_gender:null })
      .eq("phone_number", from);
    return res.send(twiml(menuMsg("🔄 Setup reset!\nPick the language you RECEIVE:")));
  }

  if (isFree && user.free_used >= 5) {
    return res.send(twiml(paywallMsg));
  }

  // … rest of Twilio flow unchanged …
});

/* — health — */
app.get("/healthz", (_, r) => r.send("OK"));
app.listen(PORT, () => console.log("🚀 running on", PORT));
