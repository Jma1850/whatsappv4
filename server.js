/* ── server.js : WhatsApp voice/text translator (OpenAI translate) ────── */
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
  SUPABASE_URL,
  SUPABASE_KEY,
  OPENAI_API_KEY,
  GOOGLE_TTS_KEY,
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
const menu   = t => `${t}\n\n` + DIGITS.map(d=>`${d}️⃣ ${MENU[d].name} (${MENU[d].code})`).join("\n");
const pick   = t => { const m=t.trim(); const d=m.match(/^\d/); if(d&&MENU[d])return MENU[d]; const l=m.toLowerCase(); return Object.values(MENU).find(o=>o.code===l||o.name.toLowerCase()===l); };
const twiml  = (...m)=>`<Response>${m.map(x=>`\n<Message>${x}</Message>`).join("")}\n</Response>`;

/* ── audio helpers ── */
const toWav = (i,o)=>new Promise((r,j)=>ffmpeg(i).audioCodec("pcm_s16le").outputOptions(["-ac","1","-ar","16000","-f","wav"]).on("error",j).on("end",()=>r(o)).save(o));
async function whisper(buf){ const ogg=`/tmp/${uuid()}.ogg`, wav=ogg.replace(".ogg",".wav"); fs.writeFileSync(ogg,buf); await toWav(ogg,wav); try{ const r=await openai.audio.transcriptions.create({model:"whisper-large-v3",file:fs.createReadStream(wav),response_format:"json"}); return{txt:r.text,lang:(r.language||"").slice(0,2)}; }catch{ const r=await openai.audio.transcriptions.create({model:"whisper-1",file:fs.createReadStream(wav),response_format:"json"}); return{txt:r.text,lang:(r.language||"").slice(0,2)}; }finally{fs.unlinkSync(ogg);fs.unlinkSync(wav);} }
const detect = async q=>(await fetch(`https://translation.googleapis.com/language/translate/v2/detect?key=${GOOGLE_TTS_KEY}`,{method:"POST",headers:{ "Content-Type":"application/json"},body:JSON.stringify({q})}).then(r=>r.json())).data.detections[0][0].language;

/* ── NEW OpenAI translate helper ── */
async function translate(text, targetCode) {
  const { choices } = await openai.chat.completions.create({
    model: "gpt-4o-mini",
    messages: [
      { role:"system", content:`Translate the following text to ${targetCode}. Return ONLY the translation.` },
      { role:"user",   content:text }
    ],
    max_tokens: 400
  });
  return choices[0].message.content.trim();
}

/* ── Google TTS ── */
async function tts(text, voice){
  const lang=voice.split("-",2)[0];
  const r=await fetch(`https://texttospeech.googleapis.com/v1/text:synthesize?key=${GOOGLE_TTS_KEY}`,{
    method:"POST",headers:{ "Content-Type":"application/json"},
    body:JSON.stringify({ input:{text}, voice:{ languageCode:lang,name:voice }, audioConfig:{ audioEncoding:"MP3" } })
  });
  const j=await r.json(); if(!j.audioContent) throw Error("TTS fail");
  return Buffer.from(j.audioContent,"base64");
}

/* ── log helper ── */
const log = d=>supabase.from("translations").insert({...d,id:uuid()});

/* ── webhook ── */
app.post("/webhook",async(req,res)=>{
  const from=req.body.From, text=(req.body.Body||"").trim();
  const mUrl=req.body.MediaUrl0, mType=req.body.MediaContentType0;

  let { data:u } = await supabase.from("users").select("*").eq("phone_number",from).single();

  if(!u){ await supabase.from("users").insert({phone_number:from,language_step:"source"}); return res.send(twiml(menu("👋 Welcome! Pick the language you RECEIVE:"))); }

  if(u.language_step==="source"){
    const c=pick(text);
    if(c){ await supabase.from("users").update({source_lang:c.code,language_step:"target"}).eq("phone_number",from); return res.send(twiml(menu("✅ Now pick the language I should SEND:"))); }
    return res.send(twiml("❌ Reply 1-4.",menu("Languages:")));
  }

  if(u.language_step==="target"){
    const c=pick(text);
    if(c){ await supabase.from("users").update({target_lang:c.code,language_step:"ready"}).eq("phone_number",from); return res.send(twiml("✅ Setup complete! Send text or a voice note.")); }
    return res.send(twiml("❌ Reply 1-4.",menu("Languages:")));
  }

  if(!u.source_lang||!u.target_lang) return res.send(twiml("⚠️ Setup incomplete. Text *reset* to start over."));

  /* ----- translate ----- */
  let orig="", det="";
  if(mUrl && mType?.startsWith("audio")){ const buf=await fetch(mUrl).then(r=>r.buffer()); ({txt:orig,lang:det}=await whisper(buf)); if(!det) det=await detect(orig); }
  else if(text){ orig=text; det=(await detect(orig)).slice(0,2); }

  if(!orig) return res.send(twiml("⚠️ Send text or a voice note."));

  const dest = det===u.target_lang ? u.source_lang : u.target_lang;
  const out  = await translate(orig,dest);
  await log({ phone_number:from, original_text:orig, translated_text:out, language_from:det, language_to:dest });

  /* TEXT → single bubble */
  if(!mUrl) return res.send(twiml(out));

  /* AUDIO → 3 bubbles */
  try{
    const voice=MENU[DIGITS.find(k=>MENU[k].code===dest)].voice;
    const audio=await tts(out,voice).toString("base64");
    return res.send(twiml(`🗣 ${orig}`, out, `<Media>data:audio/mpeg;base64,${audio}</Media>`));
  }catch(e){ console.error("TTS:",e.message); return res.send(twiml(`🗣 ${orig}`, out)); }
});

/* health check */
app.get("/healthz",(_,r)=>r.status(200).send("OK"));
app.listen(PORT,()=>console.log("🚀 running on",PORT));
