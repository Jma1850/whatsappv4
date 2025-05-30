/* ───────────────────────────────────────────────────────────────────────
   TuCan server.js  —  WhatsApp voice↔text translator bot
   » Async Twilio replies to avoid 15s timeouts
   » Stripe paywall & webhook
   » Whisper / GPT-4o translate, Google TTS, Supabase logging
────────────────────────────────────────────────────────────────────────*/
import express      from "express";
import bodyParser   from "body-parser";
import fetch        from "node-fetch";
import ffmpeg       from "fluent-ffmpeg";
import fs           from "fs";
import { randomUUID as uuid } from "crypto";
import OpenAI       from "openai";
import Stripe       from "stripe";
import twilio       from "twilio";
import { createClient } from "@supabase/supabase-js";
import * as dotenv  from "dotenv";
dotenv.config();

// Globals
process.on("unhandledRejection", r => console.error("🔴 UNHANDLED", r));

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
  TWILIO_PHONE_NUMBER,   // should be like "+14155238886"
  PORT = 8080
} = process.env;

// build correct WhatsApp-from address
const WHATSAPP_FROM = TWILIO_PHONE_NUMBER.startsWith("whatsapp:")
  ? TWILIO_PHONE_NUMBER
  : `whatsapp:${TWILIO_PHONE_NUMBER}`;

// Clients
const supabase     = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
const openai       = new OpenAI({ apiKey: OPENAI_API_KEY });
const stripeClient = new Stripe(STRIPE_SECRET_KEY, { apiVersion: "2023-10-16" });
const twilioClient = twilio(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN);

// Express setup
const app = express();

/* ====================================================================
   1️⃣  Stripe Webhook
   ==================================================================== */
app.post(
  "/stripe-webhook",
  bodyParser.raw({ type: "application/json" }),
  async (req, res) => {
    let event;
    try {
      event = stripeClient.webhooks.constructEvent(
        req.body,
        req.headers["stripe-signature"],
        STRIPE_WEBHOOK_SECRET
      );
    } catch (e) {
      console.error("🔴 stripe sig err", e.message);
      return res.sendStatus(400);
    }

    if (event.type === "checkout.session.completed") {
      const s    = event.data.object;
      const plan = s.metadata.tier === "monthly" ? "MONTHLY"
                 : s.metadata.tier === "annual"  ? "ANNUAL"
                 : "LIFETIME";

      // try update by stripe_cust_id
      const upd1 = await supabase
        .from("users")
        .update({ plan, free_used: 0, stripe_sub_id: s.subscription })
        .eq("stripe_cust_id", s.customer)
        .select("id");
      console.log("Supabase update by stripe_cust_id:", upd1);

      if (upd1.error || upd1.data.length === 0) {
        console.warn("❗ fallback to UID:", s.metadata.uid);
        const upd2 = await supabase
          .from("users")
          .update({
            plan,
            free_used: 0,
            stripe_cust_id: s.customer,
            stripe_sub_id:   s.subscription
          })
          .eq("id", s.metadata.uid)
          .select("id");
        console.log("Supabase fallback update:", upd2);
      }
    }

    if (event.type === "customer.subscription.deleted") {
      const sub = event.data.object;
      const upd3 = await supabase
        .from("users")
        .update({ plan: "FREE" })
        .eq("stripe_sub_id", sub.id)
        .select("id");
      console.log("subscription.deleted → reset FREE:", upd3);
    }

    res.json({ received: true });
  }
);

/* ====================================================================
   2️⃣  Twilio /webhook
   ==================================================================== */
app.use(bodyParser.urlencoded({ extended: false })); // Twilio form posts

// Constants & helpers
const MENU = {
  1: { name:"English",    code:"en" },
  2: { name:"Spanish",    code:"es" },
  3: { name:"French",     code:"fr" },
  4: { name:"Portuguese", code:"pt" },
  5: { name:"German",     code:"de" }
};
const DIGITS = Object.keys(MENU);
const menuMsg = title =>
  `${title}\n\n${DIGITS.map(d=>`${d}️⃣ ${MENU[d].name} (${MENU[d].code})`).join("\n")}`;
const pickLang = txt => {
  const m = txt.trim(), d = m.match(/^\d/);
  if (d && MENU[d[0]]) return MENU[d[0]];
  const lc = m.toLowerCase();
  return Object.values(MENU).find(o=>o.code===lc||o.name.toLowerCase()===lc);
};
const paywallMsg = `⚠️ You’ve used your 5 free translations.\n\nReply with:\n1️⃣  Monthly  $4.99\n2️⃣  Annual   $49.99\n3️⃣  Lifetime $199`;

// Audio & translation helpers (unchanged)
const toWav = (inF,outF) =>
  new Promise((res, rej)=>
    ffmpeg(inF).audioCodec("pcm_s16le")
      .outputOptions(["-ac","1","-ar","16000","-f","wav"])
      .on("error", rej).on("end", ()=>res(outF))
      .save(outF)
  );
async function whisper(wavPath){
  try {
    const r = await openai.audio.transcriptions.create({
      model: "whisper-large-v3",
      file: fs.createReadStream(wavPath),
      response_format: "json"
    });
    return { txt: r.text, lang: (r.language||"").slice(0,2) };
  } catch {
    const r = await openai.audio.transcriptions.create({
      model: "whisper-1",
      file: fs.createReadStream(wavPath),
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
async function translate(text,target){
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
let voiceCache=null;
async function loadVoices(){
  if(voiceCache) return;
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
(async()=>{ try{ await loadVoices(); console.log("🔊 voice cache ready"); } catch(e){}})();
async function pickVoice(lang,gender){
  await loadVoices();
  let list = (voiceCache[lang]||[]).filter(v=>v.ssmlGender===gender);
  if(!list.length) list = voiceCache[lang]||[];
  return (
    list.find(v=>v.name.includes("Neural2")) ||
    list.find(v=>v.name.includes("WaveNet")) ||
    list.find(v=>v.name.includes("Standard")) ||
    { name:"en-US-Standard-A" }
  ).name;
}
async function tts(text,lang,gender){
  const synth = async name=>{
    const lc = name.split("-",2).join("-");
    const r = await fetch(
      `https://texttospeech.googleapis.com/v1/text:synthesize?key=${GOOGLE_TTS_KEY}`,
      {
        method:"POST",
        headers:{"Content-Type":"application/json"},
        body: JSON.stringify({
          input:{text},
          voice:{languageCode:lc,name},
          audioConfig:{audioEncoding:"MP3", speakingRate:0.9}
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
async function uploadAudio(buffer){
  const fn = `tts_${uuid()}.mp3`;
  const { error } = await supabase
    .storage.from("tts-voices")
    .upload(fn, buffer, { contentType:"audio/mpeg", upsert:true });
  if(error) throw error;
  return `${SUPABASE_URL}/storage/v1/object/public/tts-voices/${fn}`;
}

// Async handler
async function handleIncoming(from, body, num, mediaUrl){
  // ... your existing Twilio flow, but use:
  //   await twilioClient.messages.create({
  //     from: WHATSAPP_FROM,
  //     to:   from,
  //     body: reply,
  //     mediaUrl: mediaUrl ? [mediaUrl] : undefined
  //   });
  //
  // Ensure every .create uses WHATSAPP_FROM.
}

// /webhook route: immediately ACK then process
app.post("/webhook", (req, res) => {
  const { From: from, Body, NumMedia, MediaUrl0 } = req.body;
  console.log("📩 TWILIO /webhook hit:", from, Body, NumMedia);
  res.set("Content-Type","text/xml");
  res.send("<Response></Response>");
  handleIncoming(from, (Body||"").trim(), parseInt(NumMedia||"0",10), MediaUrl0)
    .catch(e => console.error("⚠️ handleIncoming error:", e));
});

// health check
app.get("/healthz", (_, r) => r.send("OK"));
app.listen(PORT, () => console.log("🚀 running on", PORT));
