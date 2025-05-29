/* ────────────────────────────────────────────────────────────────────────
   server.js  –  WhatsApp voice + text translator bot (runtime voices)
─────────────────────────────────────────────────────────────────────────*/
import express  from "express";
import bodyParser from "body-parser";
import fetch    from "node-fetch";
import ffmpeg   from "fluent-ffmpeg";
import fs       from "fs";
import { randomUUID as uuid } from "crypto";
import OpenAI   from "openai";
import { createClient } from "@supabase/supabase-js";
import * as dotenv from "dotenv";
dotenv.config();

/* ── env ── */
const {
  SUPABASE_URL, SUPABASE_KEY,
  OPENAI_API_KEY, GOOGLE_TTS_KEY,
  TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN,
  PORT = 8080
} = process.env;

/* ── clients ── */
const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);
const openai   = new OpenAI({ apiKey: OPENAI_API_KEY });
const app      = express();
app.use(bodyParser.urlencoded({ extended:false }));
app.use(bodyParser.json());

/* ── languages (pilot 5) ── */
const MENU = {
  1:{ name:"English",    code:"en" },
  2:{ name:"Spanish",    code:"es" },
  3:{ name:"French",     code:"fr" },
  4:{ name:"Portuguese", code:"pt" },
  5:{ name:"German",     code:"de" }
};
const DIGITS = Object.keys(MENU);
const menu = t => `${t}\n\n`+DIGITS.map(d=>`${d}️⃣ ${MENU[d].name} (${MENU[d].code})`).join("\n");
const pick = t => { const m=t.trim(); const d=m.match(/^\d/); if(d&&MENU[d])return MENU[d]; const lc=m.toLowerCase(); return Object.values(MENU).find(o=>o.code===lc||o.name.toLowerCase()===lc); };
const twiml = (...msg)=>`<Response>${msg.map(m=>`\n<Message>${m}</Message>`).join("")}\n</Response>`;

/* ── ffmpeg helper ── */
const toWav = (i,o)=>new Promise((r,j)=>ffmpeg(i).audioCodec("pcm_s16le").outputOptions(["-ac","1","-ar","16000","-f","wav"]).on("error",j).on("end",()=>r(o)).save(o));

/* ── Whisper ── */
async function whisper(buf){
  const ogg=`/tmp/${uuid()}.ogg`, wav=ogg.replace(".ogg",".wav");
  fs.writeFileSync(ogg,buf); await toWav(ogg,wav);
  try{
    const r=await openai.audio.transcriptions.create({model:"whisper-large-v3",file:fs.createReadStream(wav),response_format:"json"});
    return { text:r.text, lang:(r.language||"").slice(0,2) };
  }catch{
    const r=await openai.audio.transcriptions.create({model:"whisper-1",file:fs.createReadStream(wav),response_format:"json"});
    return { text:r.text, lang:(r.language||"").slice(0,2) };
  }finally{ fs.unlinkSync(ogg); fs.unlinkSync(wav); }
}

/* ── Google detect (fallback) ── */
const detect = async q =>
  (await fetch(`https://translation.googleapis.com/language/translate/v2/detect?key=${GOOGLE_TTS_KEY}`,{
    method:"POST",headers:{ "Content-Type":"application/json"},body:JSON.stringify({ q })
  }).then(r=>r.json())).data.detections[0][0].language;

/* ── OpenAI translate ── */
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

/* ── Runtime voice discovery ── */
let voiceCache=null;
async function loadVoiceCatalog(){
  if(voiceCache) return;
  const url=`https://texttospeech.googleapis.com/v1/voices?key=${GOOGLE_TTS_KEY}`;
  const { voices } = await fetch(url).then(r=>r.json());
  voiceCache = voices.reduce((map,v)=>{
    v.languageCodes.forEach(c=>(map[c] ||= []).push(v)); return map;
  },{});
}
async function pickVoice(lang){
  await loadVoiceCatalog();
  const L = voiceCache[lang] || [];
  return (
    L.find(v=>v.name.includes("Neural2")) ||
    L.find(v=>v.name.includes("WaveNet")) ||
    L.find(v=>v.name.includes("Standard")) ||
    { name:"en-US-Standard-A" }
  ).name;
}

/* ── TTS (Normal / Slow) ── */
async function tts(text, langCode, rate="90%"){
  const voiceName = await pickVoice(langCode);
  const speakingRate = parseFloat(rate)/100;
  const r = await fetch(`https://texttospeech.googleapis.com/v1/text:synthesize?key=${GOOGLE_TTS_KEY}`,{
    method:"POST",headers:{ "Content-Type":"application/json"},
    body:JSON.stringify({
      input:{ text },
      voice:{ languageCode:langCode, name:voiceName },
      audioConfig:{ audioEncoding:"MP3", speakingRate }
    })
  });
  const j=await r.json();
  if(!j.audioContent) throw Error("TTS fail:"+JSON.stringify(j.error||j));
  return Buffer.from(j.audioContent,"base64");
}

/* ── Supabase log ── */
const logRow = d => supabase.from("translations").insert({ ...d, id: uuid() });

/* ── webhook ── */
app.post("/webhook",async(req,res)=>{
  const phone=req.body.From;
  const text =(req.body.Body||"").trim();
  const mUrl=req.body.MediaUrl0, mType=req.body.MediaContentType0;

  /* reset command */
  if(/^(reset|change language)$/i.test(text)){
    await supabase.from("users").upsert({phone_number:phone,language_step:"source",source_lang:null,target_lang:null,tts_rate:"90%"});
    return res.send(twiml(renderMenu("🔄 Setup reset!\nPick the language you RECEIVE:")));
  }

  /* user row */
  let {data:u}=await supabase.from("users").select("*").eq("phone_number",phone).single();
  if(!u){ await supabase.from("users").insert({phone_number:phone,language_step:"source",tts_rate:"90%"}); u={language_step:"source"}; }

  /* source step */
  if(u.language_step==="source"){
    const c=pick(text);
    if(c){ await supabase.from("users").update({source_lang:c.code,language_step:"target"}).eq("phone_number",phone); return res.send(twiml(renderMenu("✅ Now pick the language I should SEND:"))); }
    return res.send(twiml("❌ Reply 1-5.",renderMenu("Languages:")));
  }

  /* target step */
  if(u.language_step==="target"){
    const c=pick(text);
    if(c){
      if(c.code===u.source_lang) return res.send(twiml("⚠️ Target must differ from source. Pick again.",renderMenu("Languages:")));
      await supabase.from("users").update({target_lang:c.code,language_step:"voice"}).eq("phone_number",phone);
      return res.send(twiml("🔉 Choose voice speed:\n1️⃣ Normal\n2️⃣ Slow (80%)"));
    }
    return res.send(twiml("❌ Reply 1-5.",renderMenu("Languages:")));
  }

  /* voice-speed step */
  if(u.language_step==="voice"){
    const rate = /^2$/.test(text)||/slow/i.test(text) ? "80%" : "90%";
    await supabase.from("users").update({tts_rate:rate,language_step:"ready"}).eq("phone_number",phone);
    return res.send(twiml("✅ Setup complete! Send text or a voice note."));
  }

  /* translation phase */
  if(!u.source_lang||!u.target_lang) return res.send(twiml("⚠️ Setup incomplete. Text *reset* to start over."));

  /* get original + detected lang */
  let orig="", det="";
  if(mUrl && mType?.startsWith("audio")){
    const auth="Basic "+Buffer.from(`${TWILIO_ACCOUNT_SID}:${TWILIO_AUTH_TOKEN}`).toString("base64");
    const buf=await fetch(mUrl,{ headers:{ Authorization:auth }}).then(r=>r.buffer());
    ({text:orig,lang:det}=await whisper(buf));
    if(!det) det=(await detect(orig)).slice(0,2);
  }else if(text){
    orig=text; det=(await detect(orig)).slice(0,2);
  }

  if(!orig) return res.send(twiml("⚠️ Send text or a voice note."));

  const dest = det===u.target_lang ? u.source_lang : u.target_lang;
  const translated = await translate(orig,dest);
  await logRow({ phone_number:phone, original_text:orig, translated_text:translated, language_from:det, language_to:dest });

  /* TEXT → 1 bubble */
  if(!mUrl) return res.send(twiml(translated));

  /* AUDIO → 3 bubbles */
  try{
    const b64 = (await tts(translated,dest,u.tts_rate)).toString("base64");
    return res.send(twiml(`🗣 ${orig}`, translated, `<Media>data:audio/mpeg;base64,${b64}</Media>`));
  }catch(e){
    console.error("TTS error:",e.message);
    return res.send(twiml(`🗣 ${orig}`, translated));
  }
});

/* health */
app.get("/healthz",(_,r)=>r.status(200).send("OK"));
app.listen(PORT,()=>console.log("🚀 running on",PORT));
