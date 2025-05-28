/* ────────────────────────────────────────────────────────────────────────
   server.js  –  WhatsApp voice + text translator bot
   Requires Node 18+ (uses crypto.randomUUID)
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
  SUPABASE_URL,
  SUPABASE_KEY,
  OPENAI_API_KEY,
  GOOGLE_TTS_KEY,
  TWILIO_ACCOUNT_SID,
  TWILIO_AUTH_TOKEN,
  PORT = 8080
} = process.env;

/* ── clients ── */
const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);
const openai   = new OpenAI({ apiKey: OPENAI_API_KEY });

/* ── express ── */
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
const renderMenu = title =>
  `${title}\n\n` + DIGITS.map(d => `${d}️⃣ ${MENU[d].name} (${MENU[d].code})`).join("\n");

const pickLang = txt => {
  const d = txt.trim().match(/^\d/);
  if (d && MENU[d[0]]) return MENU[d[0]];
  const lc = txt.trim().toLowerCase();
  return Object.values(MENU).find(o => o.code === lc || o.name.toLowerCase() === lc);
};
const twiml = (...lines)=>`<Response>${lines.map(l=>`\n<Message>${l}</Message>`).join("")}\n</Response>`;

/* ── ffmpeg helper ── */
const toWav = (inF,outF)=>new Promise((res,rej)=>
  ffmpeg(inF).audioCodec("pcm_s16le")
    .outputOptions(["-ac","1","-ar","16000","-f","wav"])
    .on("error",rej).on("end",()=>res(outF)).save(outF));

/* ── Whisper transcription ── */
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

/* ── Google language detect (fallback) ── */
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

/* ── Google TTS (honours tts_rate) ── */
async function tts(text, voice, ratePct = "90%"){
  const lang = voice.split("-",2)[0];
  const speakingRate = parseFloat(ratePct)/100;      // 0.9 for "90%"
  const r = await fetch(`https://texttospeech.googleapis.com/v1/text:synthesize?key=${GOOGLE_TTS_KEY}`,{
    method:"POST",headers:{ "Content-Type":"application/json"},
    body:JSON.stringify({
      input:{ text },
      voice:{ languageCode:lang, name:voice },
      audioConfig:{ audioEncoding:"MP3", speakingRate }
    })
  });
  const j=await r.json();
  if(!j.audioContent) throw Error("TTS fail");
  return Buffer.from(j.audioContent,"base64");
}

/* ── Supabase log helper ── */
const logRow = d => supabase.from("translations").insert({ ...d, id: uuid() });

/* ── webhook ── */
app.post("/webhook", async (req,res)=>{
  const phone=req.body.From;
  const body =(req.body.Body||"").trim();
  const mUrl=req.body.MediaUrl0, mType=req.body.MediaContentType0;

  /* Reset command */
  if(/^(reset|change language)$/i.test(body)){
    await supabase.from("users").upsert({ phone_number:phone, language_step:"source", source_lang:null, target_lang:null, tts_rate:"90%" });
    return res.send(twiml(renderMenu("🔄 Setup reset!\nPick the language you RECEIVE:")));
  }

  /* Fetch user */
  let { data:user } = await supabase.from("users").select("*").eq("phone_number",phone).single();
  if(!user){                                             // first contact
    await supabase.from("users").insert({ phone_number:phone, language_step:"source", tts_rate:"90%" });
    user = { language_step:"source" };
  }

  /* Step: pick source lang */
  if(user.language_step==="source"){
    const c = pickLang(body);
    if(c){
      await supabase.from("users").update({source_lang:c.code,language_step:"target"}).eq("phone_number",phone);
      return res.send(twiml(renderMenu("✅ Now pick the language I should SEND:")));
    }
    return res.send(twiml("❌ Reply 1-4.",renderMenu("Languages:")));
  }

  /* Step: pick target lang (guard) */
  if(user.language_step==="target"){
    const c = pickLang(body);
    if(c){
      if(c.code===user.source_lang) return res.send(twiml("⚠️ Target must differ from source. Pick again.",renderMenu("Languages:")));
      await supabase.from("users").update({target_lang:c.code,language_step:"voice"}).eq("phone_number",phone);
      return res.send(twiml("🔉 Choose voice speed:\n1️⃣ Normal\n2️⃣ Slow (80%)"));
    }
    return res.send(twiml("❌ Reply 1-4.",renderMenu("Languages:")));
  }

  /* Step: voice-speed */
  if(user.language_step==="voice"){
    let rate="90%"; if(/^2$/.test(body)||/slow/i.test(body)) rate="80%";
    await supabase.from("users").update({tts_rate:rate,language_step:"ready"}).eq("phone_number",phone);
    return res.send(twiml("✅ Setup complete! Send text or a voice note."));
  }

  /* Ensure ready */
  if(!user.source_lang||!user.target_lang) return res.send(twiml("⚠️ Setup incomplete. Text *reset* to start over."));

  /* ── Translation ── */
  let original="", detected="";
  if(mUrl && mType?.startsWith("audio")){
    /* authenticated fetch */
    const auth = "Basic " + Buffer.from(`${TWILIO_ACCOUNT_SID}:${TWILIO_AUTH_TOKEN}`).toString("base64");
    const buf = await fetch(mUrl,{ headers:{ Authorization: auth }}).then(r=>r.buffer());
    ({ text:original, lang:detected } = await whisper(buf));
    if(!detected) detected = (await detect(original)).slice(0,2);
  }else if(body){
    original = body;
    detected = (await detect(original)).slice(0,2);
  }

  if(!original) return res.send(twiml("⚠️ Send text or a voice note."));

  const dest = detected === user.target_lang ? user.source_lang : user.target_lang;
  const translated = await translate(original,dest);
  await logRow({ phone_number:phone, original_text:original, translated_text:translated, language_from:detected, language_to:dest });

  /* TEXT → 1 bubble */
  if(!mUrl) return res.send(twiml(translated));

  /* AUDIO → 3 bubbles */
  try{
    const voice = MENU[DIGITS.find(k=>MENU[k].code===dest)].voice;
    const audio = (await tts(translated,voice,user.tts_rate)).toString("base64");
    return res.send(twiml(
      `🗣 ${original}`,
      translated,
      `<Media>data:audio/mpeg;base64,${audio}</Media>`
    ));
  }catch(err){
    console.error("TTS error:",err.message);
    return res.send(twiml(`🗣 ${original}`, translated));
  }
});

/* health */
app.get("/healthz",(_,r)=>r.status(200).send("OK"));
app.listen(PORT,()=>console.log("🚀 running on",PORT));
