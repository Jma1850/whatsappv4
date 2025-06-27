/* ──────────────────────────────────────────────────────────────────────
   TuCanChat server.js  –  WhatsApp voice ↔ text translator bot
────────────────────────────────────────────────────────────────────── */
import express          from "express";
import bodyParser       from "body-parser";
import fetch            from "node-fetch";
import ffmpeg           from "fluent-ffmpeg";
import fs               from "fs";
import { randomUUID as uuid } from "crypto";
import OpenAI           from "openai";
import Stripe           from "stripe";
import twilio           from "twilio";
import { createClient } from "@supabase/supabase-js";
import * as dotenv      from "dotenv";
dotenv.config();

/* ── crash guard ── */
process.on("unhandledRejection", r => console.error("🔴 UNHANDLED", r));

/* ── ENV ── */
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
  TWILIO_PHONE_NUMBER,
  PORT = 8080,
} = process.env;
const WHATSAPP_FROM =
  TWILIO_PHONE_NUMBER.startsWith("whatsapp:")
    ? TWILIO_PHONE_NUMBER
    : `whatsapp:${TWILIO_PHONE_NUMBER}`;

/* ── clients ── */
const supabase     = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
const openai       = new OpenAI({ apiKey: OPENAI_API_KEY });
const stripe       = new Stripe(STRIPE_SECRET_KEY, { apiVersion: "2023-10-16" });
const twilioClient = twilio(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN);

/* ──────────────────────────────────────────────────────────────────────
   Stripe helpers
────────────────────────────────────────────────────────────────────── */

/* Ensure the user row has stripe_cust_id before we send them to Checkout */
async function ensureCustomer(user) {
  if (user.stripe_cust_id) return user.stripe_cust_id;

  const c = await stripe.customers.create({
    description: `TuCanChat — ${user.phone_number}`,
    email      : user.email      || undefined,
    name       : user.full_name  || user.phone_number,
    metadata   : { uuid: user.id }                 // keep Supabase UUID in Stripe
  });

  const { error } = await supabase
    .from("users")
    .update({ stripe_cust_id: c.id })
    .eq("id", user.id)
    .single();

  if (error) {
    console.error("❌ Failed to store stripe_cust_id:", error.message);
    throw error;
  }

  return c.id;
}

/* Build and return a hosted-checkout URL */
async function checkoutUrl(user, tier /* 'monthly' | 'annual' | 'life' */) {
  const price =
    tier === "monthly" ? PRICE_MONTHLY :
    tier === "annual"  ? PRICE_ANNUAL  :
    PRICE_LIFE;

  const custId  = await ensureCustomer(user);
  const session = await stripe.checkout.sessions.create({
    mode       : tier === "life" ? "payment" : "subscription",
    customer   : custId,
    line_items : [{ price, quantity: 1 }],
    success_url: "https://tucanchat.io/success",
    cancel_url : "https://tucanchat.io/cancel",
    metadata   : { tier, uuid: user.id }           // uuid for webhook fallback
  });

  return session.url;
}

/* ──────────────────────────────────────────────────────────────────────
   Stripe webhook  (must be above any JSON body-parser)
────────────────────────────────────────────────────────────────────── */
const app = express();

app.post(
  "/stripe-webhook",
  bodyParser.raw({ type: "application/json" }),
  async (req, res) => {
    /* 1. verify signature */
    let event;
    try {
      event = stripe.webhooks.constructEvent(
        req.body,
        req.headers["stripe-signature"],
        STRIPE_WEBHOOK_SECRET
      );
    } catch (err) {
      console.error("⚠️  Stripe signature failed:", err.message);
      return res.sendStatus(400);                // ask Stripe to retry
    }

    /* ─────────  checkout complete → upgrade  ───────── */
    if (event.type === "checkout.session.completed") {
      const s = event.data.object;

      const plan =
        s.metadata.tier === "monthly" ? "MONTHLY" :
        s.metadata.tier === "annual"  ? "ANNUAL"  :
        "LIFETIME";

      const updateFields = {
        plan,
        free_used     : 0,
        stripe_sub_id : s.subscription ?? null,   // null for lifetime
        stripe_cust_id: s.customer                // store for future lookups
      };

      let data = [], error;

      /* 2-A. returning customers (row already has stripe_cust_id) */
      ({ data, error } = await supabase
        .from("users")
        .update(updateFields)
        .eq("stripe_cust_id", s.customer)
        .select());

      /* 2-B. first-timers after helper fix (uuid in Session metadata) */
      if (!data.length && s.metadata?.uuid) {
        ({ data, error } = await supabase
          .from("users")
          .update(updateFields)
          .eq("id", s.metadata.uuid)
          .select());
      }

      /* 2-C. first-timers before helper fix (uuid only on Customer) */
      if (!data.length) {
        const cust = await stripe.customers.retrieve(s.customer);
        if (cust?.metadata?.uuid) {
          ({ data, error } = await supabase
            .from("users")
            .update(updateFields)
            .eq("id", cust.metadata.uuid)
            .select());
        }
      }

      /* 2-D. absolute last chance – match on phone_number
              (stored in customer_details.name as "whatsapp:+506…") */
      if (
        !data.length &&
        s.customer_details?.name &&
        s.customer_details.name.startsWith("whatsapp:+")
      ) {
        ({ data, error } = await supabase
          .from("users")
          .update(updateFields)
          .eq("phone_number", s.customer_details.name)
          .select());
      }

      if (error || !data.length) {
        console.error("❌ Supabase update failed / user not found:", error);
        return res.sendStatus(500);              // let Stripe retry
      }

      console.log("✅ plan set to", plan, "for user", data[0].id);
    }

    /* ─────────  subscription cancelled → downgrade  ───────── */
    if (event.type === "customer.subscription.deleted") {
      const sub = event.data.object;
      const { data, error } = await supabase
        .from("users")
        .update({ plan: "FREE" })
        .eq("stripe_sub_id", sub.id)
        .select();

      if (error || !data.length) {
        console.error("❌ downgrade failed / sub not found:", error);
        return res.sendStatus(500);              // let Stripe retry
      }

      console.log("↩️  subscription cancelled for", sub.id);
    }

    /* 4. ACK Stripe so it stops retrying */
    res.json({ received: true });
  }
);


/* ====================================================================
   2️⃣  CONSTANTS / HELPERS
==================================================================== */
const MENU = {
  1:{ name:"English",    code:"en" },
  2:{ name:"Spanish",    code:"es" },
  3:{ name:"French",     code:"fr" },
  4:{ name:"Portuguese", code:"pt" },
  5:{ name:"German",     code:"de" }
};
const DIGITS = Object.keys(MENU);
const menuMsg = t =>
  `${t}\n\n${DIGITS.map(d=>`${d}️⃣ ${MENU[d].name} (${MENU[d].code})`).join("\n")}`;
const pickLang = txt => {
  const m = txt.trim(), d = m.match(/^\d/);
  if (d && MENU[d[0]]) return MENU[d[0]];
  const lc = m.toLowerCase();
  return Object.values(MENU).find(o=>o.code===lc||o.name.toLowerCase()===lc);
};
const paywallMsg = {
  en: `⚠️ You’ve used your 10 free translations. For unlimited access, please choose
one of the subscription options below:

1️⃣ Monthly  $1.99
2️⃣ Annual   $19.99`,

  es: `⚠️ Has usado tus 10 traducciones gratuitas. Para acceso ilimitado, elige
una de las siguientes opciones de suscripción:

1️⃣ Mensual    $1.99
2️⃣ Anual     $19.99`,

  fr: `⚠️ Vous avez utilisé vos 10 traductions gratuites. Pour un accès illimité, choisissez
l’une des options d’abonnement ci-dessous :

1️⃣ Mensuel   $1.99
2️⃣ Annuel    $19.99`,

  pt: `⚠️ Você usou suas 10 traduções gratuitas. Para acesso ilimitado, escolha
uma das opções de assinatura abaixo:

1️⃣ Mensal    US$1.99
2️⃣ Anual     US$19.99`,

  de: `⚠️ Du hast deine 10 kostenlosen Übersetzungen aufgebraucht. Für unbegrenzten Zugriff wähle
eine der folgenden Abo-Optionen:

1️⃣ Monatlich   $1.99
2️⃣ Jährlich    $19.99`
};

/* ────────── new constants ────────── */
const WELCOME_MSG = `Welcome to TuCanChat🦜
1️⃣ I speak English 🇺🇸 – type 1
2️⃣ Hablo Español 🇪🇸 – escribe 2
3️⃣ Je parle français 🇫🇷 – tapez 3
4️⃣ Eu falo português 🇵🇹 – digite 4
5️⃣ Ich spreche Deutsch 🇩🇪 – tippe 5`;

/* onboarding helper */
const RESET_HELP = `✳️  Type *reset* anytime to restart everything.
✳️  Type *reset source* to change only the language you receive messages in.`;

/* global config */
const MEDIA_DELAY_MS = 3500;   // wait so MP3 lands before tutorial prompt

/* audio helpers */
const toWav = (i,o)=>new Promise((res,rej)=>
  ffmpeg(i).audioCodec("pcm_s16le")
    .outputOptions(["-ac","1","-ar","16000","-f","wav"])
    .on("error",rej).on("end",()=>res(o))
    .save(o)
);
async function whisper(wav){
  try{
    const r = await openai.audio.transcriptions.create({
      model:"whisper-large-v3",
      file:fs.createReadStream(wav),
      response_format:"json"
    });
    return { txt:r.text, lang:(r.language||"").slice(0,2) };
  }catch{
    const r = await openai.audio.transcriptions.create({
      model:"whisper-1",
      file:fs.createReadStream(wav),
      response_format:"json"
    });
    return { txt:r.text, lang:(r.language||"").slice(0,2) };
  }
}
const detectLang = async q =>
  (await fetch(
    `https://translation.googleapis.com/language/translate/v2/detect?key=${GOOGLE_TTS_KEY}`,
    {method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({q})}
  ).then(r=>r.json())).data.detections[0][0].language;
async function translate(text,target){
  const r=await openai.chat.completions.create({
    model:"gpt-4o-mini",
    messages:[
      {role:"system",content:
        `You are a professional translator.
         Never translate the literal keyword "reset"; always leave it as the
         lowercase English word "reset".Never translate the literal keyword "reset source"; always leave it as the
         lowercase English word "reset source".
         Translate everything else to ${target}. Return ONLY the translation.`},
       { role: "user",
        content: `Translate this into ${target}:\n\n${text}` }
    ],
    max_tokens:400
  });
  return r.choices[0].message.content.trim();
}

/* Google TTS voices */
let voiceCache=null;
async function loadVoices(){
  if(voiceCache)return;
  const {voices}=await fetch(
    `https://texttospeech.googleapis.com/v1/voices?key=${GOOGLE_TTS_KEY}`
  ).then(r=>r.json());
  voiceCache=voices.reduce((m,v)=>{
    v.languageCodes.forEach(full=>{
      const code=full.split("-",1)[0];
      (m[code]||=[]).push(v);
    });
    return m;
  },{});
}
(async()=>{try{await loadVoices();console.log("🔊 voice cache ready");}catch{}})();
async function pickVoice(lang,gender){
  await loadVoices();
  let list=(voiceCache[lang]||[]).filter(v=>v.ssmlGender===gender);
  if(!list.length) list=voiceCache[lang]||[];

  /* ⭐ Prefer en-US over en-AU, en-GB, etc. */
  if(lang==="en"){
    const us=list.filter(v=>v.name.startsWith("en-US"));
    if(us.length) list=us;
  }

  return (
    list.find(v=>v.name.includes("Neural2"))||
    list.find(v=>v.name.includes("WaveNet"))||
    list.find(v=>v.name.includes("Standard"))||
    {name:"en-US-Standard-A"}
  ).name;
}
async function tts(text,lang,gender){
  const synth=async name=>{
    const lc=name.split("-",2).join("-");
    const r=await fetch(
      `https://texttospeech.googleapis.com/v1/text:synthesize?key=${GOOGLE_TTS_KEY}`,
      {
        method:"POST",
        headers:{"Content-Type":"application/json"},
        body:JSON.stringify({
          input:{text},
          voice:{languageCode:lc,name},
          audioConfig:{audioEncoding:"MP3",speakingRate:0.9}
        })
      }
    ).then(r=>r.json());
    return r.audioContent?Buffer.from(r.audioContent,"base64"):null;
  };
  let buf=await synth(await pickVoice(lang,gender)); if(buf)return buf;
  buf=await synth(lang);               if(buf)return buf;
  buf=await synth("en-US-Standard-A"); if(buf)return buf;
  throw new Error("TTS failed");
}

/* Storage bucket (self-healing) */
async function ensureBucket(){
  const { error } = await supabase.storage.createBucket("tts-voices",{ public:true });
  if(error && error.code!=="PGRST116") throw error;
}
async function uploadAudio(buffer){
  const fn=`tts_${uuid()}.mp3`;

  let up=await supabase
    .storage.from("tts-voices")
    .upload(fn,buffer,{contentType:"audio/mpeg",upsert:true});

  if(up.error && /Bucket not found/i.test(up.error.message)){
    console.warn("⚠️ Bucket missing → creating …");
    await ensureBucket();
    up=await supabase
      .storage.from("tts-voices")
      .upload(fn,buffer,{contentType:"audio/mpeg",upsert:true});
  }
  if(up.error) throw up.error;
  return `${SUPABASE_URL}/storage/v1/object/public/tts-voices/${fn}`;
}

/* skinny Twilio send */
async function sendMessage(to,body="",mediaUrl){
  const p={ from:WHATSAPP_FROM, to };
  if(mediaUrl) p.mediaUrl=[mediaUrl];
  else         p.body=body;
  await twilioClient.messages.create(p);
}

/* log */
const logRow=d=>supabase.from("translations").insert({ ...d,id:uuid() });

/* ====================================================================
   3️⃣  Main handler
==================================================================== */
async function handleIncoming(from, text = "", num, mediaUrl) {
  if (!from) return;
  const lower = text.trim().toLowerCase();

  /* 0. fetch (or create) user */
  let { data: user } = await supabase
    .from("users")
    .select("*")
    .eq("phone_number", from)
    .single();

  if (!user) {
    ({ data: user } = await supabase
      .from("users")
      .upsert(
        { phone_number: from,
          language_step: "target",
          plan: "FREE",
          free_used: 0 },
        { onConflict: ["phone_number"] }
      )
      .select("*")
      .single());

    await sendMessage(from, WELCOME_MSG);
    return;
  }

  const isFree = !user.plan || user.plan === "FREE";

  /* 1. quick-reset: ONLY the “language you receive messages in” */
  if (/^reset source$/i.test(lower)) {
    await supabase.from("users").update({
      source_lang   : null,
      language_step : "source",
      // keep target_lang, voice_gender, free_used
    }).eq("phone_number", from);

    const heading = await translate(
      "Choose the language you receive messages in (the one you need translated):",
      user.target_lang || "en"
    );
    const menuRaw = `1️⃣ English 🇺🇸 – type 1
2️⃣ Español 🇪🇸 – escribe 2
3️⃣ Français 🇫🇷 – tapez 3
4️⃣ Português 🇵🇹 – digite 4
5️⃣ Deutsch  🇩🇪 – tippe 5`;
    const menuTranslated = await translate(menuRaw, user.target_lang || "en");

    await sendMessage(from, `${heading}\n${menuTranslated}`);
    return;                       // stop further processing
  }

  /* 2. pay-wall button replies (numbers 1–3) */
  if (/^[1-3]$/.test(lower)                // user pressed a button
      && isFree
      && user.free_used >= 10
      && user.language_step === "ready") { // only after onboarding
    const tier = lower === "1" ? "monthly"
              : lower === "2" ? "annual"
              : "life";
    try {
      const link = await checkoutUrl(user, tier);
      await sendMessage(from, `Tap to pay → ${link}`);
    } catch (e) {
      console.error("Stripe checkout err:", e.message);
      await sendMessage(from, "⚠️ Payment link error. Try again later.");
    }
    return;
  }

  /* 3. full reset */
  if (/^(reset|change language)$/i.test(lower)) {
    await supabase.from("users").update({
      language_step : "target",
      source_lang   : null,
      target_lang   : null,
      voice_gender  : null,
      free_used     : 0           // fresh allowance
    }).eq("phone_number", from);

    await sendMessage(from, WELCOME_MSG);
    return;
  }

  /* 4. free-tier gate for normal messages */
  if (isFree && user.free_used >= 10 && user.language_step === "ready") {
    await sendMessage(
      from,
      paywallMsg[(user.target_lang || "en").toLowerCase()] || paywallMsg.en
    );
    return;
  }

  /* … onboarding wizard and rest of handleIncoming continue here … */


/* 4. onboarding wizard ----------------------------------- */
let tutorialFollow = null; // holds next tutorial prompt, if any

/* 4a. pick TARGET language (TuCanChat’s reply language) */
if (user.language_step === "target") {
  const choice = pickLang(text);
  if (choice) {
    await supabase
      .from("users")
      .update({ target_lang: choice.code, language_step: "source" })
      .eq("phone_number", from);

    const heading = await translate(
      "Choose the language you receive messages in (the one you need translated):",
      choice.code
    );
    const menuRaw = `1️⃣ English 🇺🇸 – type 1
2️⃣ Spanish 🇪🇸 – type 2
3️⃣ French  🇫🇷 – type 3
4️⃣ Portuguese 🇵🇹 – type 4
5️⃣ German  🇩🇪 – type 5`;
     
    const menuTranslated = await translate(menuRaw, choice.code);
    await sendMessage(from, `${heading}\n${menuTranslated}`);
  } else {
    await sendMessage(
      from,
      "❌ Reply 1-5.\n1) English\n2) Spanish\n3) French\n4) Portuguese\n5) German"
    );
  }
  return;
}

/* 4b. pick SOURCE language (language you receive messages in) */
if (user.language_step === "source") {
  const choice = pickLang(text);          // returns { code, name }
  if (!choice) {
    await sendMessage(from, menuMsg("❌ Reply 1-5.\nLanguages:"));
    return;
  }

  /* must differ from target */
  if (choice.code === user.target_lang) {
    await sendMessage(from, menuMsg("⚠️ Source must differ.\nLanguages:"));
    return;
  }

  /* has the user already finished setup (came from “reset source”)? */
  const alreadySetup = user.voice_gender && user.target_lang;

  await supabase
    .from("users")
    .update({
      source_lang   : choice.code,
      language_step : alreadySetup ? "ready" : "gender"
    })
    .eq("phone_number", from);

  /* ─────────────  reset-source path  ───────────── */
  if (alreadySetup) {
    /* 1. confirmation */
    const done = await translate(
      `Language change complete. You are now translating messages you receive in ${choice.name}.`,
      user.target_lang
    );
    await sendMessage(from, done);

    /* 2. reset-tips bubble */
    const tips = await translate(RESET_HELP, user.target_lang);
    await sendMessage(from, tips);

    /* 3. ready prompt */
    const readyTxt = await translate("I am ready to translate.", user.target_lang);
    await sendMessage(from, readyTxt);
    return;
  }

  /* ─────────────  normal onboarding continues  ───────────── */
  const gPrompt = await translate(
    "Choose the voice you want me to use when creating audio messages for you\n1️⃣ Male\n2️⃣ Female",
    user.target_lang
  );
  await sendMessage(from, gPrompt);
  return;
}

/* 4c. pick voice gender */
if (user.language_step === "gender") {
  let g = null;
  if (/^1$/.test(lower) || /male/i.test(lower))   g = "MALE";
  if (/^2$/.test(lower) || /female/i.test(lower)) g = "FEMALE";

  if (g) {
    await supabase
      .from("users")
      .update({ voice_gender: g, language_step: "tutorial1" })
      .eq("phone_number", from);

    /* message 1 — intro */
    const msgIntro = await translate(
      "Set-up complete! I am TucanChat, your WhatsApp translation assistant. I am here to help with translating text, voice, and video messages.",
      user.target_lang
    );
    await sendMessage(from, msgIntro);

    /* message 2 — reset tips */
    const resetTips = await translate(RESET_HELP, user.target_lang);
    await sendMessage(from, resetTips);

    /* message 3 — first action prompt */
    const firstAction = await translate(
      "Let’s try it out! Forward me an audio message from another chat you want translated into your language.",
      user.target_lang
    );
    await sendMessage(from, firstAction);

  } else {
    const retry = await translate(
      "❌ Reply 1 or 2.\n1️⃣ Male\n2️⃣ Female",
      user.target_lang
    );
    await sendMessage(from, retry);
  }
  return;
}

/* 4d. capture (but defer) tutorial follow-ups */
if (user.language_step && user.language_step.startsWith("tutorial")) {
  const map = {
    tutorial1: {
      msg: " Now record an audio note in your language—what you want to say. I’ll translate it into your friend’s language so you can forward it",
      next: "tutorial2",
    },
    tutorial2: {
      msg: "Forward that voice message ☝️ to your friend. Then send me a text in your language, or forward me a text in theirs. I'll translate it for them—and any reply they send back—for you.",
      next: "tutorial3",
    },
    tutorial3: {
      msg: "Great! Now you know how to use TucanChat. You can also send me videos and I can translate the audio for you. You have 10 messages for free, and then it is only $1.99/month",
      next: "ready",
    },
  };
  tutorialFollow = map[user.language_step];
  // Do NOT return here – we still need to run translation logic
}

/* fallback if setup not finished */
if (!user.source_lang || !user.target_lang || !user.voice_gender) {
  await sendMessage(from, "⚠️ Setup incomplete. Text *reset* to start over.");
  return;
}

/* ───── transcribe / detect language ───── */
let original = "", detected = "";
if (num > 0 && mediaUrl) {
  const auth = "Basic " + Buffer.from(`${TWILIO_ACCOUNT_SID}:${TWILIO_AUTH_TOKEN}`).toString("base64");
  const resp = await fetch(mediaUrl, { headers: { Authorization: auth } });
  const buf  = await resp.buffer();
  const ctype = resp.headers.get("content-type") || "";
  const ext =
    ctype.includes("ogg")  ? ".ogg" :
    ctype.includes("mpeg") ? ".mp3" :
    (ctype.includes("mp4") || ctype.includes("m4a")) ? ".m4a" : ".dat";
  const raw = `/tmp/${uuid()}${ext}`;
  const wav = raw.replace(ext, ".wav");
  fs.writeFileSync(raw, buf);
  await toWav(raw, wav);
  try {
    const r = await whisper(wav);
    original = r.txt;
    detected = r.lang || (await detectLang(original)).slice(0, 2);
  } finally {
    fs.unlinkSync(raw);
    fs.unlinkSync(wav);
  }
} else if (text) {
  original = text;
  detected = (await detectLang(original)).slice(0, 2);
}
if (!original) {
  await sendMessage(from, "⚠️ Send text or a voice note.");
  return;
}

const dest       = detected === user.target_lang ? user.source_lang : user.target_lang;
const translated = await translate(original, dest);

/* usage + log */
if (isFree && user.language_step === "ready") {
  await supabase
    .from("users")
    .update({ free_used: user.free_used + 1 })
    .eq("phone_number", from);
}
await logRow({
  phone_number:    from,
  original_text:   original,
  translated_text: translated,
  language_from:   detected,
  language_to:     dest,
});

/* ───── reply flow ───── */
if (num === 0) {                              // text-only incoming
  await sendMessage(from, translated);

} else {                                      // voice / media incoming
  await sendMessage(from, `🗣 ${original}`);  // 1. transcript
  await sendMessage(from, translated);        // 2. translation
  try {
    const mp3 = await tts(translated, dest, user.voice_gender);
    const pub = await uploadAudio(mp3);
    await sendMessage(from, "", pub);         // 3. audio reply
  } catch (e) {
    console.error("TTS/upload error:", e.message);
  }
}

/* …and after voice / media incoming */
if (tutorialFollow) {
  await new Promise(r => setTimeout(r, MEDIA_DELAY_MS));
  const follow = await translate(tutorialFollow.msg, user.target_lang);
  await sendMessage(from, follow);
  await supabase
    .from("users")
    .update({ language_step: tutorialFollow.next })
    .eq("phone_number", from);
}
/* ===== end of onboarding + translation handler block ===== */
} // closes handleIncoming

/* ====================================================================
   4️⃣  Twilio entry  (ACK immediately)
==================================================================== */
app.post(
  "/webhook",
  bodyParser.urlencoded({ extended:false, limit:"2mb" }),
  (req,res)=>{
    if(!req.body||!req.body.From){
      return res.set("Content-Type","text/xml").send("<Response></Response>");
    }
    const { From, Body, NumMedia, MediaUrl0 } = req.body;
    res.set("Content-Type","text/xml").send("<Response></Response>");
    handleIncoming(
      From,
      (Body||"").trim(),
      parseInt(NumMedia||"0",10),
      MediaUrl0
    ).catch(e=>console.error("handleIncoming ERR",e));
  }
);

/* health */
app.get("/healthz",(_,r)=>r.send("OK"));
app.listen(PORT,()=>console.log("🚀 running on",PORT));
