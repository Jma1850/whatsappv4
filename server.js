// server.js – Auto-flip Translator (fallback detect for voice notes)
import express from "express";
import bodyParser from "body-parser";
import fetch from "node-fetch";
import ffmpeg from "fluent-ffmpeg";
import fs from "fs";
import OpenAI from "openai";
import { createClient } from "@supabase/supabase-js";
import dotenv from "dotenv";
dotenv.config();

/* ─── ENV ─── */
const {
  SUPABASE_URL, SUPABASE_KEY,
  OPENAI_API_KEY,
  GOOGLE_TRANSLATE_KEY, GOOGLE_TTS_KEY,
  TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN,
  PORT = 8080
} = process.env;

/* ─── Clients ─── */
const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);
const openai   = new OpenAI({ apiKey: OPENAI_API_KEY });

/* ─── Languages offered ─── */
const LANGS = {
  1: { name: "English",    code: "en", voice: "en-US-Wavenet-D"  },
  2: { name: "Spanish",    code: "es", voice: "es-ES-Neural2-A"  },
  3: { name: "French",     code: "fr", voice: "fr-FR-Wavenet-B"  },
  4: { name: "Portuguese", code: "pt", voice: "pt-BR-Wavenet-A"  }
};
const DIGITS = Object.keys(LANGS);
const matchChoice = t=>{
  const c=t.trim().toLowerCase();
  const d=c.match(/^\d/)?.[0];
  if(d&&LANGS[d]) return LANGS[d];
  return Object.values(LANGS).find(v=>c===v.code||c===v.name.toLowerCase());
};

/* ─── Helpers ─── */
const convert = (i,o)=>new Promise((r,j)=>ffmpeg(i).audioCodec("pcm_s16le").outputOptions(["-ac","1","-ar","16000","-f","wav"]).on("error",j).on("end",()=>r(o)).save(o));

async function transcribe(wav){
  try{
    const r=await openai.audio.transcriptions.create({model:"whisper-large-v3",file:fs.createReadStream(wav),response_format:"json"});
    console.log("Whisper: large-v3"); return{ text:r.text, lang:r.language||null };
  }catch(e){
    const r=await openai.audio.transcriptions.create({model:"whisper-1",file:fs.createReadStream(wav),response_format:"json"});
    console.log("Whisper: whisper-1 fallback"); return{ text:r.text, lang:r.language||null };
  }
}
const detectLang = async t=>(await fetch(`https://translation.googleapis.com/language/translate/v2/detect?key=${GOOGLE_TRANSLATE_KEY}`,{method:"POST",headers:{ "Content-Type":"application/json"},body:JSON.stringify({q:t})}).then(r=>r.json())).data.detections[0][0].language;
const translate  = async(t,d)=>(await fetch(`https://translation.googleapis.com/language/translate/v2?key=${GOOGLE_TRANSLATE_KEY}`,{method:"POST",headers:{ "Content-Type":"application/json"},body:JSON.stringify({q:t,target:d})}).then(r=>r.json())).data.translations[0].translatedText;
const polish = async(t,n)=> t.split(/\s+/).length<3? t:(await openai.chat.completions.create({model:"gpt-4o-mini",messages:[{role:"system",content:`You are an expert native ${n} copy-editor. Improve wording without changing meaning.`},{role:"user",content:t}],max_tokens:400})).choices[0].message.content.trim();

async function tts(text, voice){
  const languageCode = voice.split("-").slice(0,2).join("-");
  const ssml = `<speak><prosody rate="90%">${text}</prosody></speak>`;
  let j=await fetch(`https://texttospeech.googleapis.com/v1/text:synthesize?key=${GOOGLE_TTS_KEY}`,{method:"POST",headers:{ "Content-Type":"application/json"},body:JSON.stringify({input:{ssml},voice:{languageCode,name:voice},audioConfig:{audioEncoding:"MP3"}})}).then(r=>r.json());
  if(!j.audioContent){
    j=await fetch(`https://texttospeech.googleapis.com/v1/text:synthesize?key=${GOOGLE_TTS_KEY}`,{method:"POST",headers:{ "Content-Type":"application/json"},body:JSON.stringify({input:{ssml},voice:{languageCode},audioConfig:{audioEncoding:"MP3"}})}).then(r=>r.json());
    if(!j.audioContent) throw new Error("TTS error:"+JSON.stringify(j));
  }
  const path=`/tmp/tts_${Date.now()}.mp3`;fs.writeFileSync(path,Buffer.from(j.audioContent,"base64"));return path;
}
const upload = async(p,f)=>{const {error}=await supabase.storage.from("tts-voices").upload(f,fs.readFileSync(p),{contentType:"audio/mpeg",upsert:true});if(error)throw error;return`${SUPABASE_URL}/storage/v1/object/public/tts-voices/${f}`;};

/* ─── Express ─── */
const app=express();app.use(bodyParser.urlencoded({extended:false}));app.use(bodyParser.json());

app.post("/webhook",async(req,res)=>{
  const from=req.body.From;
  const body=(req.body.Body||"").trim();
  const mUrl=req.body.MediaUrl0;
  const mType=req.body.MediaContentType0;

  try{
    let {data:u}=await supabase.from("users").select("source_lang,target_lang,language_step").eq("phone_number",from).single();
    if(!u){await supabase.from("users").insert({phone_number:from,language_step:"source"});u={language_step:"source"};}

    /* Reset command */
    if(/^(change )?language$/i.test(body)){
      await supabase.from("users").update({language_step:"source",source_lang:null,target_lang:null}).eq("phone_number",from);
      let p="🔄 Language setup reset!\nWhat language are the messages you're receiving in?\n\n";
      for(const k of DIGITS)p+=`${k}️⃣ ${LANGS[k].name} (${LANGS[k].code})\n`;
      return res.send(`<Response><Message>${p}</Message></Response>`);
    }

    /* Source selection */
    if(u.language_step==="source"){
      const c=matchChoice(body);
      if(c){
        await supabase.from("users").update({source_lang:c.code,language_step:"target"}).eq("phone_number",from);
        let p="✅ Got it! What language should I translate messages into?\n\n";
        for(const k of DIGITS)p+=`${k}️⃣ ${LANGS[k].name} (${LANGS[k].code})\n`;
        return res.send(`<Response><Message>${p}</Message></Response>`);
      }
      let p="👋 Welcome! What language are the messages you're receiving in?\n\n";
      for(const k of DIGITS)p+=`${k}️⃣ ${LANGS[k].name} (${LANGS[k].code})\n`;
      return res.send(`<Response><Message>${p}</Message></Response>`);
    }

    /* Target selection */
    if(u.language_step==="target"){
      const c=matchChoice(body);
      if(c){await supabase.from("users").update({target_lang:c.code,language_step:"done"}).eq("phone_number",from);return res.send(`<Response><Message>✅ You're all set! Send a voice note or text to translate.</Message></Response>`);}
      let p="⚠️ Please choose the language I should translate into:\n\n";
      for(const k of DIGITS)p+=`${k}️⃣ ${LANGS[k].name} (${LANGS[k].code})\n`;
      return res.send(`<Response><Message>${p}</Message></Response>`);
    }

    /* Translation */
    const src=u.source_lang,tgt=u.target_lang;
    const tgtVoice=Object.values(LANGS).find(l=>l.code===tgt)?.voice||"en-US-Wavenet-D";
    let orig,det;

    /* Voice note path */
    if(mUrl&&mType?.startsWith("audio")){
      const auth="Basic "+Buffer.from(`${TWILIO_ACCOUNT_SID}:${TWILIO_AUTH_TOKEN}`).toString("base64");
      const raw=`/tmp/raw_${Date.now()}`,wav=`/tmp/wav_${Date.now()}.wav`;
      fs.writeFileSync(raw,await (await fetch(mUrl,{headers:{Authorization:auth}})).buffer());
      await convert(raw,wav);
      const r=await transcribe(wav);
      orig=r.text; det=(r.lang||"").slice(0,2);
      if(!det){det=(await detectLang(orig)).slice(0,2);}   // <── NEW fallback detect
    }

    /* Text path */
    if(body&&!mUrl){
      orig=body; det=(await detectLang(orig)).slice(0,2);
    }

    if(!orig) return res.send(`<Response><Message>⚠️ Please send a voice note or text message.</Message></Response>`);

    /* Flip direction */
    let dest=tgt;
    if(!det)          dest=tgt;
    else if(det===tgt)dest=src;
    else if(det===src)dest=tgt;
    else              dest=src;

    const langObj=Object.values(LANGS).find(l=>l.code===dest)||{name:dest,voice:tgtVoice};
    const tl0=await translate(orig,dest);
    const tl =await polish(tl0,langObj.name);

    let voiceUrl=null;
    try{voiceUrl=await upload(await tts(tl,langObj.voice),`tts_${Date.now()}.mp3`);}catch(e){console.error(e.message);}

    res.set("Content-Type","text/xml");
    res.send(`<Response><Message>
🗣 Heard (${det||"unknown"}): ${orig}

🌎 Translated (${dest}): ${tl}
${voiceUrl?`<Media>${voiceUrl}</Media>`:""}
</Message></Response>`);
  }catch(err){
    console.error("Webhook error:",err);
    res.send(`<Response><Message>⚠️ Error processing message. Try again later.</Message></Response>`);
  }
});

app.get("/healthz",(_,r)=>r.status(200).send("OK"));
app.listen(PORT,()=>console.log(`🚀 Server listening on ${PORT}`));
