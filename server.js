/* ───────────────────────────────────────────────────────────────────────
   TuCan server.js  —  WhatsApp voice↔text translator bot
   • 5-language wizard          • Whisper + GPT-4o translate
   • Google TTS (gender)        • Stripe pay-wall (5 free msgs)
   • Supabase logging           • Async Twilio replies (no 15-s timeout)
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

/* ── crash-guard ───────────────────────────────────────────────────── */
process.on("unhandledRejection", r => console.error("🔴 UNHANDLED", r));

/* ── ENV ───────────────────────────────────────────────────────────── */
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
  TWILIO_PHONE_NUMBER,     // +14155238886  (NO “whatsapp:” prefix)
  PORT = 8080
} = process.env;

const WHATSAPP_FROM = TWILIO_PHONE_NUMBER.startsWith("whatsapp:")
  ? TWILIO_PHONE_NUMBER
  : `whatsapp:${TWILIO_PHONE_NUMBER}`;

/* ── CLIENTS ───────────────────────────────────────────────────────── */
const supabase     = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
const openai       = new OpenAI({ apiKey: OPENAI_API_KEY });
const stripe       = new Stripe(STRIPE_SECRET_KEY, { apiVersion: "2023-10-16" });
const twilioClient = twilio(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN);

/* ── EXPRESS ───────────────────────────────────────────────────────── */
const app = express();

/* ====================================================================
   1️⃣  STRIPE WEBHOOK  (raw body)
==================================================================== */
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
      console.error("stripe sig err", e.message);
      return res.sendStatus(400);
    }

    if (event.type === "checkout.session.completed") {
      const s    = event.data.object;
      const plan = s.metadata.tier === "monthly" ? "MONTHLY"
                 : s.metadata.tier === "annual"  ? "ANNUAL"
                 : "LIFETIME";

      // 1️⃣  update by stripe_cust_id
      const upd1 = await supabase
        .from("users")
        .update({ plan, free_used: 0, stripe_sub_id: s.subscription })
        .eq("stripe_cust_id", s.customer);

      // 2️⃣  fallback by metadata.uid
      if (upd1.data?.length === 0) {
        await supabase
          .from("users")
          .update({
            plan,
            free_used: 0,
            stripe_cust_id: s.customer,
            stripe_sub_id:  s.subscription
          })
          .eq("id", s.metadata.uid);
      }
    }

    if (event.type === "customer.subscription.deleted") {
      const sub = event.data.object;
      await supabase
        .from("users")
        .update({ plan: "FREE" })
        .eq("stripe_sub_id", sub.id);
    }

    res.json({ received: true });
  }
);

/* ====================================================================
   2️⃣  CONSTANTS & HELPERS
==================================================================== */
const MENU = {
  1:{ name:"English",    code:"en" },
  2:{ name:"Spanish",    code:"es" },
  3:{ name:"French",     code:"fr" },
  4:{ name:"Portuguese", code:"pt" },
  5:{ name:"German",     code:"de" }
};
const DIGITS  = Object.keys(MENU);
const menuMsg = t =>
  `${t}\n\n${DIGITS.map(d=>`${d}️⃣ ${MENU[d].name} (${MENU[d].code})`).join("\n")}`;
const pickLang = txt => {
  const m = txt.trim(), d = m.match(/^\d/);
  if (d && MENU[d[0]]) return MENU[d[0]];
  const lc = m.toLowerCase();
  return Object.values(MENU).find(o=>o.code===lc||o.name.toLowerCase()===lc);
};
const paywallMsg =
`⚠️ You’ve used your 5 free translations.

Reply with:
1️⃣ Monthly  $4.99
2️⃣ Annual   $49.99
3️⃣ Lifetime $199`;

/* — audio helpers — */
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

/* — Google TTS voices — */
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
(async()=>{try{await loadVoices();console.log("🔊 voice cache ready");}catch{}})();
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
  let buf=await synth(await pickVoice(lang,gender)); if(buf)return buf;
  buf=await synth(lang);               if(buf)return buf;
  buf=await synth("en-US-Standard-A"); if(buf)return buf;
  throw new Error("TTS failed");
}
async function uploadAudio(buffer){
  const fn=`tts_${uuid()}.mp3`;
  const {error} = await supabase
    .storage.from("tts-voices")
    .upload(fn,buffer,{contentType:"audio/mpeg",upsert:true});
  if(error) throw error;
  return `${SUPABASE_URL}/storage/v1/object/public/tts-voices/${fn}`;
}

/* — Stripe checkout link — */
async function ensureCustomer(u){
  if(u.stripe_cust_id) return u.stripe_cust_id;
  const c = await stripe.customers.create({ description:`TuCan ${u.phone_number}` });
  await supabase.from("users").update({stripe_cust_id:c.id}).eq("id",u.id);
  return c.id;
}
async function checkoutUrl(u,tier){
  const price = tier==="monthly"?PRICE_MONTHLY:tier==="annual"?PRICE_ANNUAL:PRICE_LIFE;
  const s = await stripe.checkout.sessions.create({
    mode: tier==="life"?"payment":"subscription",
    customer: await ensureCustomer(u),
    line_items:[{price,quantity:1}],
    success_url:"https://checkout.stripe.com/success",
    cancel_url:"https://checkout.stripe.com/cancel",
    metadata:{tier}
  });
  return s.url;
}

/* — logging — */
const logRow = d => supabase.from("translations").insert({ ...d, id:uuid() });

/* — send WhatsApp message — */
async function sendMessage(to, body, mediaUrl){
  const payload = { from: WHATSAPP_FROM, to, body };
  if(mediaUrl) payload.mediaUrl = [mediaUrl];
  console.log("➔", payload);
  await twilioClient.messages.create(payload);
}

/* ====================================================================
   3️⃣  handleIncoming  (whole flow)
==================================================================== */
async function handleIncoming(from, text, num, mediaUrl){
  if(!from) return;    // guard for empty pings

  /* fetch / init user */
  let { data:user } = await supabase
    .from("users")
    .select("*")
    .eq("phone_number",from)
    .single();

  if(!user){
    ({ data:user } = await supabase
      .from("users")
      .upsert(
        { phone_number:from, language_step:"source", plan:"FREE", free_used:0 },
        { onConflict:["phone_number"] }
      )
      .select("*").single());
  }
  const isFree = !user.plan || user.plan==="FREE";

  /* paywall button */
  if(/^[1-3]$/.test(text) && isFree && user.free_used>=5){
    const tier = text==="1"?"monthly":text==="2"?"annual":"life";
    try{
      const link = await checkoutUrl(user,tier);
      await sendMessage(from, `Tap to pay → ${link}`);
    }catch(e){
      console.error("Stripe checkout err:",e.message);
      await sendMessage(from,"⚠️ Payment link error. Try again later.");
    }
    return;
  }

  /* reset */
  if(/^(reset|change language)$/i.test(text)){
    await supabase.from("users").update({
      language_step:"source",
      source_lang:null,target_lang:null,voice_gender:null
    }).eq("phone_number",from);
    await sendMessage(from, menuMsg("🔄 Setup reset!\nPick the language you RECEIVE:"));
    return;
  }

  /* paywall gate */
  if(isFree && user.free_used>=5){
    await sendMessage(from,paywallMsg);
    return;
  }

  /* wizard step 1 */
  if(user.language_step==="source"){
    const c = pickLang(text);
    if(c){
      await supabase.from("users")
        .update({ source_lang:c.code, language_step:"target" })
        .eq("phone_number",from);
      await sendMessage(from, menuMsg("✅ Now pick the language I should SEND:"));
    }else{
      await sendMessage(from, menuMsg("❌ Reply 1-5.\nLanguages:"));
    }
    return;
  }

  /* wizard step 2 */
  if(user.language_step==="target"){
    const c = pickLang(text);
    if(c){
      if(c.code===user.source_lang){
        await sendMessage(from, menuMsg("⚠️ Target must differ.\nLanguages:"));
        return;
      }
      await supabase.from("users")
        .update({ target_lang:c.code, language_step:"gender" })
        .eq("phone_number",from);
      await sendMessage(from,"🔊 Voice gender?\n1️⃣ Male\n2️⃣ Female");
    }else{
      await sendMessage(from, menuMsg("❌ Reply 1-5.\nLanguages:"));
    }
    return;
  }

  /* wizard step 3 */
  if(user.language_step==="gender"){
    let g=null;
    if(/^1$/.test(text)||/male/i.test(text))   g="MALE";
    if(/^2$/.test(text)||/female/i.test(text)) g="FEMALE";
    if(g){
      await supabase.from("users")
        .update({ voice_gender:g, language_step:"ready" })
        .eq("phone_number",from);
      await sendMessage(from,"✅ Setup complete! Send text or a voice note.");
    }else{
      await sendMessage(from,"❌ Reply 1 or 2.\n1️⃣ Male\n2️⃣ Female");
    }
    return;
  }

  /* guard */
  if(!user.source_lang||!user.target_lang||!user.voice_gender){
    await sendMessage(from,"⚠️ Setup incomplete. Text *reset* to start over.");
    return;
  }

  /* transcription / detection */
  let original="", detected="";
  if(num>0 && mediaUrl){
    const auth="Basic "+Buffer.from(
      `${TWILIO_ACCOUNT_SID}:${TWILIO_AUTH_TOKEN}`
    ).toString("base64");
    const resp=await fetch(mediaUrl,{headers:{Authorization:auth}});
    const buf =await resp.buffer();
    const ctype=resp.headers.get("content-type")||"";
    const ext = ctype.includes("ogg")?".ogg":
                ctype.includes("mpeg")?".mp3":
                ctype.includes("mp4")||ctype.includes("m4a")?".m4a":".dat";
    const raw=`/tmp/${uuid()}${ext}`,wav=raw.replace(ext,".wav");
    fs.writeFileSync(raw,buf); await toWav(raw,wav);
    try{
      const r=await whisper(wav);
      original=r.txt;
      detected=r.lang||(await detectLang(original)).slice(0,2);
    }finally{fs.unlinkSync(raw);fs.unlinkSync(wav);}
  }else if(text){
    original=text;
    detected=(await detectLang(original)).slice(0,2);
  }
  if(!original){
    await sendMessage(from,"⚠️ Send text or a voice note.");
    return;
  }

  /* translate */
  const dest       = detected===user.target_lang ? user.source_lang : user.target_lang;
  const translated = await translate(original,dest);

  /* free usage count */
  if(isFree){
    await supabase.from("users")
      .update({ free_used:user.free_used+1 })
      .eq("phone_number",from);
  }

  /* log translation */
  await logRow({
    phone_number:from,
    original_text:original,
    translated_text:translated,
    language_from:detected,
    language_to:dest
  });

  /* reply */
  if(num===0){
    await sendMessage(from, translated);
    return;
  }
  try{
    const mp3 = await tts(translated,dest,user.voice_gender);
    const pub = await uploadAudio(mp3);
    await sendMessage(from, `🗣 ${original}\n\n${translated}`, pub);
  }catch(e){
    console.error("TTS/upload error:", e.message);
    await sendMessage(from, `🗣 ${original}\n\n${translated}`);
  }
}

/* ====================================================================
   4️⃣  Twilio entry — ACK immediately, then process
==================================================================== */
app.post(
  "/webhook",
  bodyParser.urlencoded({ extended:false, limit:"2mb" }),
  (req,res) => {
    if(!req.body || !req.body.From){
      return res.set("Content-Type","text/xml").send("<Response></Response>");
    }
    const { From, Body, NumMedia, MediaUrl0 } = req.body;
    res.set("Content-Type","text/xml").send("<Response></Response>");
    handleIncoming(
      From,
      (Body||"").trim(),
      parseInt(NumMedia||"0",10),
      MediaUrl0
    ).catch(e=>console.error("handleIncoming ERR", e));
  }
);

/* ── health ───────────────────────────────────────────────────────── */
app.get("/healthz",(_,r)=>r.send("OK"));
app.listen(PORT,()=>{
  console.log("→ SUPABASE_URL:",!!SUPABASE_URL);
  console.log("→ SERVICE_ROLE_KEY present?",!!SUPABASE_SERVICE_ROLE_KEY);
  console.log("🚀 running on",PORT);
});
