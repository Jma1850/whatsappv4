import express from "express";
import bodyParser from "body-parser";
import fetch from "node-fetch";
import ffmpeg from "fluent-ffmpeg";
import fs from "fs";
import { randomUUID as uuid } from "crypto";
import OpenAI from "openai";
import { createClient } from "@supabase/supabase-js";
import * as dotenv from "dotenv";
dotenv.config();

/* ── env ── */
const {
  SUPABASE_URL, SUPABASE_KEY,
  OPENAI_API_KEY, GOOGLE_TTS_KEY,
  PORT = 8080
} = process.env;

/* ── clients ── */
const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);
const openai   = new OpenAI({ apiKey: OPENAI_API_KEY });
const app = express();
app.use(bodyParser.urlencoded({ extended:false }));
app.use(bodyParser.json());

/* ── language menu ── */
const MENU = {
  1:{ name:"English",    code:"en", voice:"en-US-Neural2-D" },
  2:{ name:"Spanish",    code:"es", voice:"es-ES-Neural2-A" },
  3:{ name:"French",     code:"fr", voice:"fr-FR-Neural2-B" },
  4:{ name:"Portuguese", code:"pt", voice:"pt-BR-Neural2-A" }
};
const DIGITS = Object.keys(MENU);
const menu = t => `${t}\n\n`+DIGITS.map(d=>`${d}️⃣ ${MENU[d].name} (${MENU[d].code})`).join("\n");
const pick = t => { const m=t.trim(); const d=m.match(/^\d/); if(d&&MENU[d])return MENU[d]; const lc=m.toLowerCase(); return Object.values(MENU).find(o=>o.code===lc||o.name.toLowerCase()===lc); };
const twiml = (...m)=>`<Response>${m.map(x=>`\n<Message>${x}</Message>`).join("")}\n</Response>`;

/* ── helpers ── */
const wav = (i,o)=>new Promise((r,j)=>ffmpeg(i).audioCodec("pcm_s16le").outputOptions(["-ac","1","-ar","16000","-f","wav"]).on("error",j).on("end",()=>r(o)).save(o));
async function whisper(buf){ const a=`/tmp/${uuid()}.ogg`, w=a.replace(".ogg",".wav"); fs.writeFileSync(a,buf); await wav(a,w); try{ const r=await openai.audio.transcriptions.create({model:"whisper-large-v3",file:fs.createReadStream(w),response_format:"json"}); return{txt:r.text,lang:r.language||""}; }catch{ const r=await openai.audio.transcriptions.create({model:"whisper-1",file:fs.createReadStream(w),response_format:"json"}); return{txt:r.text,lang:r.language||""}; } finally{fs.unlinkSync(a);fs.unlinkSync(w);} }
const detect = async q=>(await fetch(`https://translation.googleapis.com/language/translate/v2/detect?key=${GOOGLE_TTS_KEY}`,{method:"POST",headers:{ "Content-Type":"application/json"},body:JSON.stringify({q})}).then(r=>r.json())).data.detections[0][0].language;
const translate = async(q,t)=>(await fetch(`https://translation.googleapis.com/language/translate/v2?key=${GOOGLE_TTS_KEY}`,{method:"POST",headers:{ "Content-Type":"application/json"},body:JSON.stringify({q,target:t})}).then(r=>r.json())).data.translations[0].translatedText;
async function tts(txt,voice){ const lang=voice.split("-",2)[0]; const r=await fetch(`https://texttospeech.googleapis.com/v1/text:synthesize?key=${GOOGLE_TTS_KEY}`,{method:"POST",headers:{ "Content-Type":"application/json"},body:JSON.stringify({input:{text:txt},voice:{languageCode:lang,name:voice},audioConfig:{audioEncoding:"MP3"}})}); const j=await r.json(); if(!j.audioContent) throw Error("TTS fail"); return Buffer.from(j.audioContent,"base64"); }
const logRow = d=>supabase.from("translations").insert({...d,id:uuid()});

/* ── webhook ── */
app.post("/webhook",async(req,res)=>{
  const from=req.body.From;
  const msg =(req.body.Body||"").trim();
  const mUrl=req.body.MediaUrl0, mType=req.body.MediaContentType0;

  let {data:u}=await supabase.from("users").select("*").eq("phone_number",from).single();
  if(!u){ await supabase.from("users").insert({phone_number:from,language_step:"source"}); return res.send(twiml(menu("👋 Welcome! Pick the language you RECEIVE:"))); }

  /* step 1  */
  if(u.language_step==="source"){
    const c=pick(msg); if(c){ await supabase.from("users").update({source_lang:c.code,language_step:"target"}).eq("phone_number",from); return res.send(twiml(menu("✅ Now pick the language I should SEND:"))); }
    return res.send(twiml("❌ Reply 1-4.",menu("Languages:")));
  }
  /* step 2  */
  if(u.language_step==="target"){
    const c=pick(msg); if(c){ await supabase.from("users").update({target_lang:c.code,language_step:"ready"}).eq("phone_number",from); return res.send(twiml("✅ Setup complete! Send text or a voice note.")); }
    return res.send(twiml("❌ Reply 1-4.",menu("Languages:")));
  }

  /* must have both src & tgt now */
  if(!u.source_lang||!u.target_lang) return res.send(twiml("⚠️ Setup incomplete. Text *reset* to start over."));

  /* translate */
  let orig="", det="";
  if(mUrl && mType?.startsWith("audio")){ const buf=await fetch(mUrl).then(r=>r.buffer()); ({txt:orig,lang:det}=await whisper(buf)); if(!det) det=await detect(orig); }
  else if(msg){ orig=msg; det=(await detect(orig)); }

  if(!orig) return res.send(twiml("⚠️ Send text or a voice note."));

  const dest = det===u.target_lang ? u.source_lang : u.target_lang;
  const out  = await translate(orig,dest);
  await logRow({phone_number:from,original_text:orig,translated_text:out,language_from:det,language_to:dest});

  /* TEXT message → only translation bubble */
  if(!mUrl) return res.send(twiml(out));

  /* AUDIO message → 3 bubbles */
  try{
    const voice=MENU[DIGITS.find(k=>MENU[k].code===dest)].voice;
    const mp3  = await tts(out,voice);
    const b64  = mp3.toString("base64");
    return res.send(twiml(
      `🗣 ${orig}`,     // bubble 1: plain original
      out,             // bubble 2: plain translation
      `<Media>data:audio/mpeg;base64,${b64}</Media>` // bubble 3: audio
    ));
  }catch(e){ console.error("TTS:",e.message); return res.send(twiml(`🗣 ${orig}`, out)); }

});

app.get("/healthz",(_,r)=>r.status(200).send("OK"));
app.listen(PORT,()=>console.log("🚀 running on",PORT));
