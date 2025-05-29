/* ────────────────────────────────────────────────────────────────────────
   server.js  –  WhatsApp voice + text translator bot  (stable audio flow)
   Node 18+
─────────────────────────────────────────────────────────────────────────*/
import express from "express";
import bodyParser from "body-parser";
import fetch from "node-fetch";
import ffmpeg from "fluent-ffmpeg";
import fs from "fs";
import { randomUUID as uuid } from "crypto";
import OpenAI from "openai";
import { createClient } from "@supabase/supabase-js";
import * as dotenv from "dotenv";
import twilio from "twilio";
dotenv.config();

/* env */
const {
  SUPABASE_URL, SUPABASE_KEY,
  OPENAI_API_KEY, GOOGLE_TTS_KEY,
  TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN,
  PORT = 8080,
  WHISPER_MODEL, TRANSLATE_MODEL
} = process.env;

/* db + openai */
const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);
const openai   = new OpenAI({ apiKey: OPENAI_API_KEY });

/* express */
const app = express();
app.use(bodyParser.urlencoded({ extended:false }));
app.use(bodyParser.json());

/* Twilio request validation middleware */
// TWILIO_AUTH_TOKEN is available here from the destructuring assignment in the "env" section
const validateTwilioRequest = (req, res, next) => {
  const isValid = twilio.validateExpressRequest(req, TWILIO_AUTH_TOKEN, {
    url: `${req.protocol}://${req.get('host')}${req.originalUrl}`
  });

  if (isValid) {
    next();
  }
  // If !isValid, twilio.validateExpressRequest will have already sent a 403 response.
};

/* languages (pilot 5) */
const MENU={
  1:{name:"English",code:"en"},2:{name:"Spanish",code:"es"},
  3:{name:"French",code:"fr"},4:{name:"Portuguese",code:"pt"},5:{name:"German",code:"de"}};
const DIGITS=Object.keys(MENU);
const menu=t=>`${t}\n\n${DIGITS.map(d=>`${d}️⃣ ${MENU[d].name} (${MENU[d].code})`).join("\n")}`;
const pick=t=>{const m=t.trim();const d=m.match(/^\d/);if(d&&MENU[d])return MENU[d];const lc=m.toLowerCase();return Object.values(MENU).find(o=>o.code===lc||o.name.toLowerCase()===lc)};
const twiml=(...b)=>`<Response>${b.map(x=>`\n<Message>${x}</Message>`).join("")}\n</Response>`;

/* ffmpeg helper */
const toWav=(inF,outF)=>new Promise((res,rej)=>
  ffmpeg(inF).audioCodec("pcm_s16le").outputOptions(["-ac","1","-ar","16000","-f","wav"])
    .on("error",rej).on("end",()=>res(outF)).save(outF));

/* whisper */
async function whisper(wavPath){
  const primaryModel = WHISPER_MODEL || "whisper-large-v3";
  let r;
  try{
    r = await openai.audio.transcriptions.create({model: primaryModel, file:fs.createReadStream(wavPath), response_format:"json"});
  } catch (error) {
    console.warn(`Whisper primary model ${primaryModel} failed:`, error.message);
    if (primaryModel !== "whisper-1") {
      console.log("Attempting fallback to whisper-1");
      r = await openai.audio.transcriptions.create({model:"whisper-1", file:fs.createReadStream(wavPath), response_format:"json"});
    } else {
      throw error; // Re-throw if primary was already whisper-1 or if no fallback defined
    }
  }
  return {txt:r.text, lang:(r.language||"").slice(0,2)};
}

/* detect */
const detect=async q=>(await fetch(`https://translation.googleapis.com/language/translate/v2/detect?key=${GOOGLE_TTS_KEY}`,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({q})}).then(r=>r.json())).data.detections[0][0].language;

/* translate */
async function translate(text,target){
  const translationModel = TRANSLATE_MODEL || "gpt-4o-mini";
  const r=await openai.chat.completions.create({model: translationModel, messages:[{role:"system",content:`Translate to ${target}. ONLY translation.`},{role:"user",content:text}],max_tokens:400});
  return r.choices[0].message.content.trim();
}

/* runtime voice discovery */
let voices=null;
async function loadVoices(){ if(voices) return;
  const {voices:arr}=await fetch(`https://texttospeech.googleapis.com/v1/voices?key=${GOOGLE_TTS_KEY}`).then(r=>r.json());
  voices=arr.reduce((m,v)=>{v.languageCodes.forEach(c=>(m[c]??=[]).push(v));return m;},{});
}
(async()=>{try{await loadVoices();console.log("🔊 voice cache ready");}catch(e){console.error("voice preload",e.message)}})();
async function bestVoice(lang){
  await loadVoices();
  const list=voices[lang]||[];
  return (list.find(v=>v.name.includes("Neural2"))||list.find(v=>v.name.includes("WaveNet"))||list.find(v=>v.name.includes("Standard"))||{name:"en-US-Standard-A"}).name;
}

/* TTS with fallback */
async function tts(text,lang){
  const synth=async name=>{
    const r=await fetch(`https://texttospeech.googleapis.com/v1/text:synthesize?key=${GOOGLE_TTS_KEY}`,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({input:{text},voice:{languageCode:lang,name},audioConfig:{audioEncoding:"MP3",speakingRate:0.9}})}).then(r=>r.json());
    return r.audioContent?Buffer.from(r.audioContent,"base64"):null};
  let buf=await synth(await bestVoice(lang)); if(buf) return buf;
  buf=await synth(lang); if(buf) return buf;
  buf=await synth("en-US-Standard-A"); if(buf) return buf;
  throw Error("TTS failed");
}

/* log helper */
const logRow=d=>supabase.from("translations").insert({...d,id:uuid()});

/* webhook */
app.post("/webhook", validateTwilioRequest, async(req,res)=>{
  console.log("📩",{NumMedia:req.body.NumMedia});
  try{
    const phone=req.body.From;
    const text =(req.body.Body||"").trim();
    const mUrl=req.body.MediaUrl0;

    /* reset */
    if(/^(reset|change language)$/i.test(text)){
      await supabase.from("users").upsert({phone_number:phone,language_step:"source",source_lang:null,target_lang:null});
      return res.send(twiml(menu("🔄 Setup reset!\nPick the language you RECEIVE:")));
    }

    /* user row */
    let {data:u}=await supabase.from("users").select("*").eq("phone_number",phone).single();
    if(!u){await supabase.from("users").insert({phone_number:phone,language_step:"source"});u={language_step:"source"}}

    /* source step */
    if(u.language_step==="source"){
      const c=pick(text);
      if(c){await supabase.from("users").update({source_lang:c.code,language_step:"target"}).eq("phone_number",phone);
        return res.send(twiml(menu("✅ Now pick the language I should SEND:"))); }
      return res.send(twiml("❌ Reply 1-5.",menu("Languages:")));
    }

    /* target step */
    if(u.language_step==="target"){
      const c=pick(text);
      if(c){
        if(c.code===u.source_lang)return res.send(twiml("⚠️ Target must differ from source. Pick again.",menu("Languages:")));
        await supabase.from("users").update({target_lang:c.code,language_step:"ready"}).eq("phone_number",phone);
        return res.send(twiml("✅ Setup complete! Send text or a voice note."));
      }
      return res.send(twiml("❌ Reply 1-5.",menu("Languages:")));
    }

    /* ensure ready */
    if(!u.source_lang||!u.target_lang)return res.send(twiml("⚠️ Setup incomplete. Text *reset* to start over."));

    /* ---- translate ---- */
    let original="", detected="";
    if(mUrl){
      const auth="Basic "+Buffer.from(`${TWILIO_ACCOUNT_SID}:${TWILIO_AUTH_TOKEN}`).toString("base64");
      const resp=await fetch(mUrl,{headers:{Authorization:auth}});
      const buf = await resp.buffer();
      const ctype=resp.headers.get("content-type")||"";
      const ext = ctype.includes("ogg")?".ogg":ctype.includes("mpeg")?".mp3":ctype.includes("mp4")||ctype.includes("m4a")?".m4a":".dat";
      const raw = `/tmp/${uuid()}${ext}`;
      const wav = raw.replace(ext,".wav");
      fs.writeFileSync(raw,buf);
      await toWav(raw,wav);
      try{
        const {txt,lang}=await whisper(wav);
        original=txt; detected=lang||(await detect(original)).slice(0,2);
      }finally{fs.unlinkSync(raw);fs.unlinkSync(wav);}
    }else if(text){
      original=text; detected=(await detect(original)).slice(0,2);
    }

    if(!original)return res.send(twiml("⚠️ Send text or a voice note."));

    const dest=detected===u.target_lang?u.source_lang:u.target_lang;
    const translated=await translate(original,dest);
    await logRow({phone_number:phone,original_text:original,translated_text:translated,language_from:detected,language_to:dest});

    /* text */
    if(!mUrl)return res.send(twiml(translated));

    /* audio */
    try{
      const b64=(await tts(translated,dest)).toString("base64");
      return res.send(twiml(`🗣 ${original}`,translated,`<Media>data:audio/mpeg;base64,${b64}</Media>`));
    }catch(e){
      console.error("TTS error",e.message);
      return res.send(twiml(`🗣 ${original}`,translated));
    }

  }catch(err){
    console.error("Webhook error",err);
    return res.send(twiml("⚠️ Error processing voice note. Please try again."));
  }
});

/* health */
app.get("/healthz",(_,r)=>r.status(200).send("OK"));
app.listen(PORT,()=>console.log("🚀 running on",PORT));
