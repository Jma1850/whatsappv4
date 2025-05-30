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
  TWILIO_PHONE_NUMBER,
  PORT = 8080
} = process.env;

// Clients
const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
const openai   = new OpenAI({ apiKey: OPENAI_API_KEY });
const stripe   = new Stripe(STRIPE_SECRET_KEY, { apiVersion: "2023-10-16" });
const twilioClient = twilio(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN);

// Express setup
const app = express();

/* ====================
   1) Stripe Webhook
   ==================== */
app.post(
  "/stripe-webhook",
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

/* ====================
   2) Twilio /webhook
   ==================== */
app.use(bodyParser.urlencoded({ extended: false })); // Twilio form posts

// quick constants
const MENU = {
  1:{name:"English", code:"en"},
  2:{name:"Spanish", code:"es"},
  3:{name:"French",  code:"fr"},
  4:{name:"Portuguese",code:"pt"},
  5:{name:"German",   code:"de"}
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
const paywallMsg = `⚠️ You’ve used your 5 free translations.

Reply with:
1️⃣  Monthly  $4.99
2️⃣  Annual   $49.99
3️⃣  Lifetime $199`;

// audio + translate helpers (unchanged from before)
const toWav = (i,o)=>new Promise((r,j)=>
  ffmpeg(i).audioCodec("pcm_s16le")
    .outputOptions(["-ac","1","-ar","16000","-f","wav"])
    .on("error",j).on("end",()=>r(o)).save(o)
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
  const r = await openai.chat.completions.create({
    model:"gpt-4o-mini",
    messages:[
      {role:"system",content:`Translate to ${target}. Return ONLY the translation.`},
      {role:"user",content:text}
    ],
    max_tokens:400
  });
  return r.choices[0].message.content.trim();
}
let voiceCache=null;
async function loadVoices(){
  if(voiceCache)return;
  const {voices} = await fetch(
    `https://texttospeech.googleapis.com/v1/voices?key=${GOOGLE_TTS_KEY}`
  ).then(r=>r.json());
  voiceCache = voices.reduce((m,v)=>{
    v.languageCodes.forEach(full=>{
      const code=full.split("-",1)[0];
      (m[code]||=[]).push(v);
    });
    return m;
  },{});
}
(async()=>{try{await loadVoices();console.log("🔊 voice cache ready")}catch(e){}})();
async function pickVoice(lang,gender){
  await loadVoices();
  let list=(voiceCache[lang]||[]).filter(v=>v.ssmlGender===gender);
  if(!list.length) list=voiceCache[lang]||[];
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
  let buf = await synth(await pickVoice(lang,gender)); if(buf)return buf;
  buf = await synth(lang);                if(buf)return buf;
  buf = await synth("en-US-Standard-A"); if(buf)return buf;
  throw new Error("TTS failed");
}
async function uploadAudio(buffer){
  const fn=`tts_${uuid()}.mp3`;
  const {error}=await supabase
    .storage.from("tts-voices")
    .upload(fn,buffer,{contentType:"audio/mpeg",upsert:true});
  if(error)throw error;
  return `${SUPABASE_URL}/storage/v1/object/public/tts-voices/${fn}`;
}

// Twilio client for async replies
const twilioApi = twilioClient;

/* — handleIncoming does the heavy lifting — */
async function handleIncoming(from, text, num, mediaUrl) {
  // fetch or create user
  let { data:user } = await supabase
    .from("users")
    .select("*")
    .eq("phone_number",from)
    .single();
  if(!user){
    const { data:newUser } = await supabase
      .from("users")
      .upsert(
        {phone_number:from,language_step:"source",plan:"FREE",free_used:0},
        {onConflict:["phone_number"]}
      )
      .select("*")
      .single();
    user = newUser;
  }
  const isFree = !user.plan || user.plan==="FREE";

  // paywall buttons
  if(/^[1-3]$/.test(text) && isFree && user.free_used>=5){
    const tier=text==="1"?"monthly":text==="2"?"annual":"life";
    let reply;
    try{
      const link = await checkoutUrl(user,tier);
      reply = `Tap to pay → ${link}`;
    }catch(e){
      reply = "⚠️ Payment link error. Try again later.";
    }
    await twilioApi.messages.create({
      from: `whatsapp:${TWILIO_PHONE_NUMBER}`,
      to: from,
      body: reply
    });
    return;
  }

  // resets, setup steps, etc. (copy your existing logic here,
  // but at the end of each branch use twilioApi.messages.create)

  // final translation phase:
  let original="", detected="";
  if(num>0 && mediaUrl){
    // fetch, ffmpeg, whisper...
  } else {
    original = text;
    detected = await detectLang(original);
  }
  if(!original){
    await twilioApi.messages.create({from:`whatsapp:${TWILIO_PHONE_NUMBER}`,to:from,body:"⚠️ Send text or a voice note."});
    return;
  }
  const dest = detected===user.target_lang?user.source_lang:user.target_lang;
  const translated = await translate(original,dest);

  // increment free_used...
  if(isFree){
    await supabase.from("users").update({free_used:user.free_used+1}).eq("phone_number",from);
  }
  // logRow...

  // if text-only:
  if(num===0){
    await twilioApi.messages.create({
      from: `whatsapp:${TWILIO_PHONE_NUMBER}`,
      to: from,
      body: translated
    });
    return;
  }
  // if audio:
  try{
    const mp3 = await tts(translated,dest,user.voice_gender);
    const pub = await uploadAudio(mp3);
    await twilioApi.messages.create({
      from: `whatsapp:${TWILIO_PHONE_NUMBER}`,
      to: from,
      body: `🗣 ${original}\n\n${translated}`,
      mediaUrl: [pub]
    });
  }catch(e){
    await twilioApi.messages.create({
      from: `whatsapp:${TWILIO_PHONE_NUMBER}`,
      to: from,
      body: `🗣 ${original}\n\n${translated}`
    });
  }
}

/* — the /webhook route simply ACKS and fires handleIncoming — */
app.post("/webhook", (req, res) => {
  const { From:from, Body:raw, NumMedia, MediaUrl0:url } = req.body;
  const text = (raw||"").trim();
  const num  = parseInt(NumMedia||"0",10);

  // immediate Twilio 200 OK
  res.set("Content-Type","text/xml");
  res.send("<Response></Response>");

  // background processing
  handleIncoming(from, text, num, url).catch(err=>{
    console.error("⚠️ background handleIncoming error:", err);
  });
});

/* — health check — */
app.get("/healthz",(_,r)=>r.send("OK"));
app.listen(PORT,()=>console.log("🚀 running on",PORT));
