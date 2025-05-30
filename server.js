/* ───────────────────────────────────────────────────────────────────────
   TuCan server.js  –  WhatsApp voice↔text translator bot
   (Stripe + pay-wall + audio + Supabase)
────────────────────────────────────────────────────────────────────────*/
import express   from "express";
import bodyParser from "body-parser";
import fetch     from "node-fetch";
import ffmpeg    from "fluent-ffmpeg";
import fs        from "fs";
import { randomUUID as uuid } from "crypto";
import OpenAI    from "openai";
import Stripe    from "stripe";
import { createClient } from "@supabase/supabase-js";
import * as dotenv from "dotenv";
dotenv.config();

/* top of file, right after imports */
process.on("unhandledRejection", (reason, p) => {
  console.error("🔴 UNHANDLED REJECTION", reason);
});

/* ── ENV ── */
const {
  SUPABASE_URL, SUPABASE_KEY,
  OPENAI_API_KEY, GOOGLE_TTS_KEY,
  STRIPE_SECRET_KEY, STRIPE_WEBHOOK_SECRET,
  PRICE_MONTHLY, PRICE_ANNUAL, PRICE_LIFE,
  TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN,
  PORT = 8080
} = process.env;

/* ── CLIENTS ── */
const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);
const openai   = new OpenAI({ apiKey: OPENAI_API_KEY });
const stripe   = new Stripe(STRIPE_SECRET_KEY, { apiVersion: "2023-10-16" });

/* ── EXPRESS ── */
const app = express();
app.use(bodyParser.urlencoded({ extended:false }));
app.use(bodyParser.json());

/* ── 5-language menu ── */
const MENU = {
  1:{ name:"English",    code:"en" },
  2:{ name:"Spanish",    code:"es" },
  3:{ name:"French",     code:"fr" },
  4:{ name:"Portuguese", code:"pt" },
  5:{ name:"German",     code:"de" }
};
const DIGITS = Object.keys(MENU);
const menuMsg = t=>`${t}\n\n${DIGITS.map(d=>`${d}️⃣ ${MENU[d].name} (${MENU[d].code})`).join("\n")}`;
const pickLang = txt=>{
  const m = txt.trim(), d = m.match(/^\d/);
  if(d && MENU[d[0]]) return MENU[d[0]];
  const lc = m.toLowerCase();
  return Object.values(MENU).find(o=>o.code===lc||o.name.toLowerCase()===lc);
};
const twiml = (...lines)=>
  `<Response>${lines.map(l=>`\n<Message>${l}</Message>`).join("")}\n</Response>`;

/* ── FFMPEG helper ── */
const toWav = (inF,outF)=>
  new Promise((res,rej)=>
    ffmpeg(inF)
      .audioCodec("pcm_s16le")
      .outputOptions(["-ac","1","-ar","16000","-f","wav"])
      .on("error",rej).on("end",()=>res(outF)).save(outF));

/* ── Whisper helper ── */
async function whisper(wav){
  try{
    const r = await openai.audio.transcriptions.create({
      model:"whisper-large-v3",
      file:fs.createReadStream(wav), response_format:"json"
    });
    return { txt:r.text, lang:(r.language||"").slice(0,2) };
  }catch{
    const r = await openai.audio.transcriptions.create({
      model:"whisper-1",
      file:fs.createReadStream(wav), response_format:"json"
    });
    return { txt:r.text, lang:(r.language||"").slice(0,2) };
  }
}

/* ── Google Detect helper ── */
const detectLang = async q=>
  (await fetch(
    `https://translation.googleapis.com/language/translate/v2/detect?key=${GOOGLE_TTS_KEY}`,
    {method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({q})}
  ).then(r=>r.json())).data.detections[0][0].language;

/* ── GPT Translate helper ── */
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

/* ── Google TTS voice discovery ── */
let voiceCache=null;
async function loadVoices(){
  if(voiceCache) return;
  const {voices}=await fetch(`https://texttospeech.googleapis.com/v1/voices?key=${GOOGLE_TTS_KEY}`).then(r=>r.json());
  voiceCache = voices.reduce((m,v)=>{
    v.languageCodes.forEach(full=>{
      const code=full.split("-",1)[0];
      (m[code] ||= []).push(v);
    });
    return m;
  },{});
}
(async()=>{try{await loadVoices();console.log("🔊 voice cache ready");}catch(e){console.error(e);}})();

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
      {method:"POST",headers:{"Content-Type":"application/json"},
       body:JSON.stringify({
         input:{text},
         voice:{languageCode:lc,name},
         audioConfig:{audioEncoding:"MP3",speakingRate:0.9}
       })}
    ).then(r=>r.json());
    return r.audioContent?Buffer.from(r.audioContent,"base64"):null;
  };
   +  if (!from) {
+    return res.sendStatus(200);          // ignore pings with no sender
+  }
  let b=await synth(await pickVoice(lang,gender)); if(b) return b;
  b=await synth(lang); if(b) return b;
  b=await synth("en-US-Standard-A"); if(b) return b;
  throw new Error("TTS failed");
}
async function uploadAudio(buf){
  const fn=`tts_${uuid()}.mp3`;
  const {error}=await supabase.storage.from("tts-voices").upload(fn,buf,{contentType:"audio/mpeg",upsert:true});
  if(error) throw error;
  return `${SUPABASE_URL}/storage/v1/object/public/tts-voices/${fn}`;
}

/* ── Stripe helpers ── */
async function ensureCustomer(u){
  if(u.stripe_cust_id) return u.stripe_cust_id;
  const c=await stripe.customers.create({description:`TuCan ${u.phone_number}`});
  await supabase.from("users").update({stripe_cust_id:c.id}).eq("id",u.id);
  return c.id;
}
async function checkoutUrl(u,tier){
  const price = tier==="monthly"?PRICE_MONTHLY : tier==="annual"?PRICE_ANNUAL : PRICE_LIFE;
  const s=await stripe.checkout.sessions.create({
    mode:tier==="life"?"payment":"subscription",
    customer:await ensureCustomer(u),
    line_items:[{price,quantity:1}],
    success_url:"https://checkout.stripe.com/success",
    cancel_url:"https://checkout.stripe.com/cancel",
    metadata:{uid:u.id,tier}
  });
  return s.url;
}

/* ── Pay-wall message ── */
const paywallMsg =
`⚠️ You’ve used your 5 free translations.

Reply with:
1️⃣  Monthly  $4.99
2️⃣  Annual   $49.99
3️⃣  Lifetime $199`;

/* ── Logger helper ── */
const logRow=d=>supabase.from("translations").insert({...d,id:uuid()});

/* ── WEBHOOK (Twilio) ── */
app.post("/webhook", async (req,res)=>{
  const {From:from,Body:raw,NumMedia,MediaUrl0:url}=req.body;
  const text=(raw||"").trim(); const num=parseInt(NumMedia||"0",10);

  /* Fetch or create user */
  let {data:user}=await supabase.from("users").select("*").eq("phone_number",from).single();
  if(!user){
    const {data:newUser,error}=await supabase.from("users")
      .upsert({phone_number:from,language_step:"source",plan:"FREE",free_used:0},
              {onConflict:["phone_number"]})
      .select("*").single();
    if(error) throw error;
    user=newUser;
  }
  const isFree=!user.plan||user.plan==="FREE";

  /* Pay-wall button */
  if(/^[1-3]$/.test(text)&&isFree&&user.free_used>=5){
    const tier=text==="1"?"monthly":text==="2"?"annual":"life";
    try{
      const link=await checkoutUrl(user,tier);
      return res.send(twiml(`Tap to pay → ${link}`));
    }catch(e){
      console.error("Stripe checkout error:",e.message);
      return res.send(twiml("⚠️ Payment link error. Try again later."));
    }
  }

  /* Reset */
  if(/^(reset|change language)$/i.test(text)){
    await supabase.from("users").update({
      language_step:"source",source_lang:null,target_lang:null,voice_gender:null
    }).eq("phone_number",from);
    return res.send(twiml(menuMsg("🔄 Setup reset!\nPick the language you RECEIVE:")));
  }

  /* Pay-wall gate */
  if(isFree&&user.free_used>=5) return res.send(twiml(paywallMsg));

  /* Wizard steps */
  if(user.language_step==="source"){
    const c=pickLang(text);
    if(c){
      await supabase.from("users").update({source_lang:c.code,language_step:"target"}).eq("phone_number",from);
      return res.send(twiml(menuMsg("✅ Now pick the language I should SEND:")));
    }
    return res.send(twiml("❌ Reply 1-5.",menuMsg("Languages:")));
  }
  if(user.language_step==="target"){
    const c=pickLang(text);
    if(c){
      if(c.code===user.source_lang) return res.send(twiml("⚠️ Target must differ.",menuMsg("Languages:")));
      await supabase.from("users").update({target_lang:c.code,language_step:"gender"}).eq("phone_number",from);
      return res.send(twiml("🔊 Voice gender?\n1️⃣ Male\n2️⃣ Female"));
    }
    return res.send(twiml("❌ Reply 1-5.",menuMsg("Languages:")));
  }
  if(user.language_step==="gender"){
    let g=null;
    if(/^1$/.test(text)||/male/i.test(text))   g="MALE";
    if(/^2$/.test(text)||/female/i.test(text)) g="FEMALE";
    if(g){
      await supabase.from("users").update({voice_gender:g,language_step:"ready"}).eq("phone_number",from);
      return res.send(twiml("✅ Setup complete! Send text or a voice note."));
    }
    return res.send(twiml("❌ Reply 1 or 2.","1️⃣ Male\n2️⃣ Female"));
  }
  if(!user.source_lang||!user.target_lang||!user.voice_gender)
    return res.send(twiml("⚠️ Setup incomplete. Text *reset* to start over."));

  /* Translation */
  let original="", detected="";
  if(num>0&&url){
    const auth="Basic "+Buffer.from(`${TWILIO_ACCOUNT_SID}:${TWILIO_AUTH_TOKEN}`).toString("base64");
    const resp=await fetch(url,{headers:{Authorization:auth}});
    const buf=await resp.buffer();
    const ctype=resp.headers.get("content-type")||"";
    const ext=ctype.includes("ogg")?".ogg":ctype.includes("mpeg")?".mp3":
              ctype.includes("mp4")||ctype.includes("m4a")?".m4a":".dat";
    const raw=`/tmp/${uuid()}${ext}`; const wav=raw.replace(ext,".wav");
    fs.writeFileSync(raw,buf); await toWav(raw,wav);
    try{
      const r=await whisper(wav); original=r.txt; detected=r.lang||(await detectLang(original)).slice(0,2);
    }finally{fs.unlinkSync(raw);fs.unlinkSync(wav);}
  }else if(text){
    original=text; detected=(await detectLang(original)).slice(0,2);
  }
  if(!original) return res.send(twiml("⚠️ Send text or a voice note."));

  const dest=detected===user.target_lang?user.source_lang:user.target_lang;
  const translated=await translate(original,dest);

  /* increment counter */
  if(isFree){
    await supabase.from("users").update({free_used:user.free_used+1}).eq("phone_number",from);
  }

  await logRow({phone_number:from,original_text:original,translated_text:translated,
                language_from:detected,language_to:dest});

  if(num===0) return res.send(twiml(translated));

  try{
    const mp3=await tts(translated,dest,user.voice_gender);
    const pub=await uploadAudio(mp3);
    return res.send(twiml(`🗣 ${original}`,translated,`<Media>${pub}</Media>`));
  }catch(e){
    console.error("TTS/upload error:",e.message);
    return res.send(twiml(`🗣 ${original}`,translated));
  }
});

/* ── Stripe webhook ── */
app.post("/stripe-webhook",
  bodyParser.raw({type:"application/json"}), async(req,res)=>{
    let event;
    try{
      event=stripe.webhooks.constructEvent(
        req.body, req.headers["stripe-signature"], STRIPE_WEBHOOK_SECRET);
    }catch(e){console.error("stripe sig err",e.message); return res.sendStatus(400);}
    if(event.type==="checkout.session.completed"){
      const s=event.data.object; const {uid,tier}=s.metadata;
      const plan=tier==="monthly"?"MONTHLY":tier==="annual"?"ANNUAL":"LIFETIME";
      await supabase.from("users").update({
        plan, free_used:0, stripe_cust_id:s.customer,
        stripe_sub_id: tier==="life"?null:s.subscription
      }).eq("id",uid);
    }
    if(event.type==="customer.subscription.deleted"){
      const sub=event.data.object;
      await supabase.from("users").update({plan:"FREE"}).eq("stripe_sub_id",sub.id);
    }
    res.json({received:true});
});

/* ── Health ── */
app.get("/healthz",(_,r)=>r.send("OK"));
app.listen(PORT,()=>console.log("🚀 running on",PORT));
