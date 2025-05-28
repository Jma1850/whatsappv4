/* ── server.js : WhatsApp Voice + Text Translator ─────────────────────── */
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
const app      = express();
app.use(bodyParser.urlencoded({ extended:false }));
app.use(bodyParser.json());

/* ── supported languages & voices ── */
const MENU = {
  1:{ name:"English",    code:"en", voice:"en-US-Neural2-D" },
  2:{ name:"Spanish",    code:"es", voice:"es-ES-Neural2-A" },
  3:{ name:"French",     code:"fr", voice:"fr-FR-Neural2-B" },
  4:{ name:"Portuguese", code:"pt", voice:"pt-BR-Neural2-A" }
};
const DIGITS = Object.keys(MENU);

/* ── helpers ── */
const renderMenu = t =>
  `${t}\n\n${DIGITS.map(d=>`${d}️⃣ ${MENU[d].name} (${MENU[d].code})`).join("\n")}`;

const pickLang = txt => {
  const d = txt.trim().match(/^\d/); if (d && MENU[d[0]]) return MENU[d[0]];
  const lc = txt.trim().toLowerCase();
  return Object.values(MENU).find(o=>o.code===lc || o.name.toLowerCase()===lc);
};

const twiml = (...bubbles)=>
  `<Response>${bubbles.map(b=>`\n<Message>${b}</Message>`).join("")}\n</Response>`;

/* convert ogg -> wav 16 kHz mono */
const toWav = (inFile,outFile)=> new Promise((res,rej)=>
  ffmpeg(inFile).audioCodec("pcm_s16le")
    .outputOptions(["-ac","1","-ar","16000","-f","wav"])
    .on("error",rej).on("end",()=>res(outFile)).save(outFile));

async function whisper(buf){
  const ogg=`/tmp/${uuid()}.ogg`, wav=ogg.replace(".ogg",".wav");
  fs.writeFileSync(ogg,buf); await toWav(ogg,wav);
  try{
    const r=await openai.audio.transcriptions.create({model:"whisper-large-v3",file:fs.createReadStream(wav),response_format:"json"});
    return { txt:r.text, lang:(r.language||"").slice(0,2) };
  }catch{
    const r=await openai.audio.transcriptions.create({model:"whisper-1",file:fs.createReadStream(wav),response_format:"json"});
    return { txt:r.text, lang:(r.language||"").slice(0,2) };
  }finally{ fs.unlinkSync(ogg); fs.unlinkSync(wav); }
}

const detect = async q =>
  (await fetch(`https://translation.googleapis.com/language/translate/v2/detect?key=${GOOGLE_TTS_KEY}`,
    {method:"POST",headers:{ "Content-Type":"application/json"},body:JSON.stringify({q})}).then(r=>r.json()))
  .data.detections[0][0].language;

async function translate(text,target){
  const r = await openai.chat.completions.create({
    model:"gpt-4o-mini",
    messages:[
      {role:"system",content:`Translate to ${target}. Reply ONLY the translation.`},
      {role:"user",content:text}
    ],
    max_tokens:400
  });
  return r.choices[0].message.content.trim();
}

async function tts(text,voice){
  const lang=voice.split("-",2)[0];
  const r=await fetch(`https://texttospeech.googleapis.com/v1/text:synthesize?key=${GOOGLE_TTS_KEY}`,{
    method:"POST",headers:{ "Content-Type":"application/json"},
    body:JSON.stringify({input:{text},voice:{languageCode:lang,name:voice},audioConfig:{audioEncoding:"MP3"}})
  });
  const j=await r.json(); if(!j.audioContent) throw Error("TTS fail");
  return Buffer.from(j.audioContent,"base64");
}

const logRow = d=>supabase.from("translations").insert({...d,id:uuid()});

/* ── webhook ── */
app.post("/webhook", async (req,res)=>{
  const phone=req.body.From;
  const body =(req.body.Body||"").trim();
  const mUrl=req.body.MediaUrl0, mType=req.body.MediaContentType0;

  /* reset command */
  if(/^(reset|change language)$/i.test(body)){
    await supabase.from("users").upsert({phone_number:phone,language_step:"source",source_lang:null,target_lang:null,tts_rate:"90%"});
    return res.send(twiml(renderMenu("🔄 Setup reset!\nPick the language you RECEIVE:")));
  }

  /* fetch user */
  let {data:u} = await supabase.from("users").select("*").eq("phone_number",phone).single();
  if(!u){ await supabase.from("users").insert({phone_number:phone,language_step:"source",tts_rate:"90%"}); u={language_step:"source"}; }

  /* ── Step: pick RECEIVED language ── */
  if(u.language_step==="source"){
    const c=pickLang(body);
    if(c){
      await supabase.from("users").update({source_lang:c.code,language_step:"target"}).eq("phone_number",phone);
      return res.send(twiml(renderMenu("✅ Now pick the language I should SEND:")));
    }
    return res.send(twiml("❌ Reply 1-4.",renderMenu("Languages:")));
  }

  /* ── Step: pick SEND language ── */
  if(u.language_step==="target"){
    const c=pickLang(body);
    if(c){
      if(c.code===u.source_lang) return res.send(twiml("⚠️ Target must differ from source. Pick again.",renderMenu("Languages:")));
      await supabase.from("users").update({target_lang:c.code,language_step:"voice"}).eq("phone_number",phone);
      return res.send(twiml("🔉 Choose voice speed:\n1️⃣ Normal\n2️⃣ Slow (80%)"));
    }
    return res.send(twiml("❌ Reply 1-4.",renderMenu("Languages:")));
  }

  /* ── Optional voice-speed step ── */
  if(u.language_step==="voice"){
    let rate="90%"; if(/^2$/.test(body)||/slow/i.test(body)) rate="80%";
    await supabase.from("users").update({tts_rate:rate,language_step:"ready"}).eq("phone_number",phone);
    return res.send(twiml("✅ Setup complete! Send text or a voice note."));
  }

  /* ── Translation phase ── */
  if(!u.source_lang||!u.target_lang) return res.send(twiml("⚠️ Setup incomplete. Text *reset* to start over."));

  let original="", detected="";
  if(mUrl && mType?.startsWith("audio")){
    const buf=await fetch(mUrl).then(r=>r.buffer());
    ({txt:original,lang:detected}=await whisper(buf));
    if(!detected) detected=await detect(original);
  }else if(body){
    original=body; detected=(await detect(original)).slice(0,2);
  }

  if(!original) return res.send(twiml("⚠️ Send text or a voice note."));

  const dest = detected===u.target_lang ? u.source_lang : u.target_lang;
  const translated = await translate(original,dest);

  await logRow({ phone_number:phone, original_text:original, translated_text:translated, language_from:detected, language_to:dest });

  /* TEXT → single bubble */
  if(!mUrl) return res.send(twiml(translated));

  /* AUDIO → 3 bubbles */
  try{
    const voice = MENU[DIGITS.find(k=>MENU[k].code===dest)].voice;
    const audio = (await tts(translated,voice)).toString("base64");
    return res.send(twiml(
      `🗣 ${original}`,
      translated,
      `<Media>data:audio/mpeg;base64,${audio}</Media>`
    ));
  }catch(e){
    console.error("TTS:",e.message);
    return res.send(twiml(`🗣 ${original}`, translated));
  }
});

/* health */
app.get("/healthz",(_,r)=>r.status(200).send("OK"));
app.listen(PORT,()=>console.log("🚀 running on",PORT));
