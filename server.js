/* ────────────────────────────────────────────────────────────────────────
   server.js  –  WhatsApp voice+text translator bot
   • 5-language pilot menu
   • Runtime voice discovery (Neural2→WaveNet→Standard) _grouped by two-letter code_
   • Robust audio flow: download, convert to WAV, Whisper
   • TTS fallback chain: primary→lang default→en-US-Standard-A
   • Upload MP3 to Supabase Storage for Twilio <Media> URL
   • Two-step setup + reset + flip logic + logging
─────────────────────────────────────────────────────────────────────────*/
import express   from "express";
import bodyParser from "body-parser";
import fetch     from "node-fetch";
import ffmpeg    from "fluent-ffmpeg";
import fs        from "fs";
import { randomUUID as uuid } from "crypto";
import OpenAI    from "openai";
import { createClient } from "@supabase/supabase-js";
import * as dotenv from "dotenv";
dotenv.config();

/* ── ENV ── */
const {
  SUPABASE_URL, SUPABASE_KEY,
  OPENAI_API_KEY, GOOGLE_TTS_KEY,
  TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN,
  PORT = 8080
} = process.env;

/* ── CLIENTS ── */
const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);
const openai   = new OpenAI({ apiKey: OPENAI_API_KEY });

/* ── EXPRESS ── */
const app = express();
app.use(bodyParser.urlencoded({ extended:false }));
app.use(bodyParser.json());

/* ── PILOT LANGUAGES ── */
const MENU = {
  1:{ name:"English",    code:"en" },
  2:{ name:"Spanish",    code:"es" },
  3:{ name:"French",     code:"fr" },
  4:{ name:"Portuguese", code:"pt" },
  5:{ name:"German",     code:"de" }
};
const DIGITS = Object.keys(MENU);
const menuMsg = title =>
  `${title}\n\n` +
  DIGITS.map(d => `${d}️⃣ ${MENU[d].name} (${MENU[d].code})`).join("\n");
const pickLang = txt => {
  const m=txt.trim(), d=m.match(/^\d/);
  if(d && MENU[d[0]]) return MENU[d[0]];
  const lc=m.toLowerCase();
  return Object.values(MENU).find(
    o => o.code===lc||o.name.toLowerCase()===lc
  );
};
const twiml = (...lines) =>
  `<Response>${lines.map(l=>`\n<Message>${l}</Message>`).join("")}\n</Response>`;

/* ── FFMPEG CONVERSION ── */
const toWav = (inF, outF) =>
  new Promise((res, rej)=>
    ffmpeg(inF)
      .audioCodec("pcm_s16le")
      .outputOptions(["-ac","1","-ar","16000","-f","wav"])
      .on("error", rej)
      .on("end", ()=>res(outF))
      .save(outF)
  );

/* ── WHISPER ── */
async function whisper(wavPath) {
  try {
    const r = await openai.audio.transcriptions.create({
      model:"whisper-large-v3",
      file:fs.createReadStream(wavPath),
      response_format:"json"
    });
    return { txt:r.text, lang:(r.language||"").slice(0,2) };
  } catch {
    const r = await openai.audio.transcriptions.create({
      model:"whisper-1",
      file:fs.createReadStream(wavPath),
      response_format:"json"
    });
    return { txt:r.text, lang:(r.language||"").slice(0,2) };
  }
}

/* ── GOOGLE DETECT ── */
const detectLang = async q =>
  (
    await fetch(
      `https://translation.googleapis.com/language/translate/v2/detect?key=${GOOGLE_TTS_KEY}`,
      { method:"POST", headers:{"Content-Type":"application/json"}, body:JSON.stringify({q}) }
    ).then(r=>r.json())
  ).data.detections[0][0].language;

/* ── OPENAI TRANSLATE ── */
async function translate(text,target) {
  const r = await openai.chat.completions.create({
    model:"gpt-4o-mini",
    messages:[
      { role:"system",content:`Translate to ${target}. Return ONLY the translation.` },
      { role:"user",  content:text }
    ],
    max_tokens:400
  });
  return r.choices[0].message.content.trim();
}

/* ── VOICE DISCOVERY (group by two-letter) ── */
let voiceCache = null;
async function loadVoices(){
  if(voiceCache) return;
  const { voices } = await fetch(
    `https://texttospeech.googleapis.com/v1/voices?key=${GOOGLE_TTS_KEY}`
  ).then(r=>r.json());
  // group by two-letter code
  voiceCache = voices.reduce((map,v) => {
    v.languageCodes.forEach(full=>{
      const code = full.split("-",1)[0];
      (map[code] ||= []).push(v);
    });
    return map;
  }, {});
}
(async()=>{
  try{ await loadVoices(); console.log("🔊 voice cache ready"); }
  catch(e){ console.error("Voice preload error:", e.message); }
})();
async function pickVoice(lang){
  await loadVoices();
  const list = voiceCache[lang] || [];
  return (
    list.find(v=>v.name.includes("Neural2")) ||
    list.find(v=>v.name.includes("WaveNet")) ||
    list.find(v=>v.name.includes("Standard")) ||
    { name:"en-US-Standard-A" }
  ).name;
}

/* ── TTS + FALLBACK ── */
async function tts(text,lang){
  const synth = async name => {
    const r = await fetch(
      `https://texttospeech.googleapis.com/v1/text:synthesize?key=${GOOGLE_TTS_KEY}`,
      {
        method:"POST",
        headers:{"Content-Type":"application/json"},
        body:JSON.stringify({
          input:{ text },
          voice:{ languageCode:lang, name },
          audioConfig:{ audioEncoding:"MP3", speakingRate:0.9 }
        })
      }
    ).then(r=>r.json());
    return r.audioContent ? Buffer.from(r.audioContent,"base64") : null;
  };
  let buf = await synth(await pickVoice(lang));
  if(buf) return buf;
  buf = await synth(lang);
  if(buf) return buf;
  buf = await synth("en-US-Standard-A");
  if(buf) return buf;
  throw new Error(`TTS failed for ${lang}`);
}

/* ── UPLOAD MP3 → SUPABASE ── */
async function uploadAudio(buffer){
  const fn = `tts_${uuid()}.mp3`;
  const { error } = await supabase
    .storage.from("tts-voices")
    .upload(fn, buffer, { contentType:"audio/mpeg", upsert:true });
  if(error) throw error;
  return `${SUPABASE_URL}/storage/v1/object/public/tts-voices/${fn}`;
}

/* ── LOGGING ── */
const logRow = d => supabase.from("translations").insert({ ...d, id:uuid() });

/* ── WEBHOOK ── */
app.post("/webhook", async (req, res) => {
  const { From:from, Body:bodyRaw, NumMedia, MediaUrl0:url } = req.body;
  const text = (bodyRaw||"").trim();
  const num  = parseInt(NumMedia||"0",10);

  console.log("📩 Incoming", { from, num, url });

  try {
    // RESET
    if(/^(reset|change language)$/i.test(text)){
      await supabase.from("users").upsert({
        phone_number:from, language_step:"source", source_lang:null, target_lang:null
      });
      return res.send(twiml(menuMsg("🔄 Setup reset!\nPick the language you RECEIVE:")));
    }

    // FETCH/INSERT USER
    let { data:u } = await supabase.from("users").select("*").eq("phone_number",from).single();
    if(!u){
      await supabase.from("users").insert({ phone_number:from, language_step:"source" });
      u = { language_step:"source" };
    }

    // STEP1: source language
    if(u.language_step==="source"){
      const c=pickLang(text);
      if(c){
        await supabase.from("users")
          .update({ source_lang:c.code, language_step:"target" })
          .eq("phone_number",from);
        return res.send(twiml(menuMsg("✅ Now pick the language I should SEND:")));
      }
      return res.send(twiml("❌ Reply 1-5.", menuMsg("Languages:")));
    }

    // STEP2: target language
    if(u.language_step==="target"){
      const c=pickLang(text);
      if(c){
        if(c.code===u.source_lang)
          return res.send(twiml("⚠️ Target must differ. Pick again.", menuMsg("Languages:")));
        await supabase.from("users")
          .update({ target_lang:c.code, language_step:"ready" })
          .eq("phone_number",from);
        return res.send(twiml("✅ Setup complete! Send text or a voice note."));
      }
      return res.send(twiml("❌ Reply 1-5.", menuMsg("Languages:")));
    }

    // ENSURE READY
    if(!u.source_lang||!u.target_lang)
      return res.send(twiml("⚠️ Setup incomplete. Text *reset* to start over."));

    // TRANSLATION PHASE
    let original="", detected="";
    if(num>0 && url){
      // download + convert
      const auth="Basic "+Buffer.from(`${TWILIO_ACCOUNT_SID}:${TWILIO_AUTH_TOKEN}`).toString("base64");
      const resp=await fetch(url,{ headers:{ Authorization:auth } });
      const buf=await resp.buffer();
      const ctype=resp.headers.get("content-type")||"";
      const ext = ctype.includes("ogg")?".ogg"
                : ctype.includes("mpeg")?".mp3"
                : ctype.includes("mp4")||ctype.includes("m4a")?".m4a"
                : ".dat";
      const raw=`/tmp/${uuid()}${ext}`, wav=raw.replace(ext,".wav");
      fs.writeFileSync(raw,buf);
      await toWav(raw,wav);
      try{
        const r = await whisper(wav);
        original=r.txt; detected=r.lang || (await detectLang(original)).slice(0,2);
      }finally{ fs.unlinkSync(raw); fs.unlinkSync(wav); }
    } else if(text){
      original=text; detected=(await detectLang(original)).slice(0,2);
    }

    if(!original) return res.send(twiml("⚠️ Send text or a voice note."));

    const dest = detected===u.target_lang ? u.source_lang : u.target_lang;
    const translated = await translate(original,dest);

    await logRow({
      phone_number:from,
      original_text:original,
      translated_text:translated,
      language_from:detected,
      language_to:dest
    });

    // TEXT reply
    if(num===0) return res.send(twiml(translated));

    // AUDIO reply
    try{
      const mp3buf = await tts(translated,dest);
      const publicUrl = await uploadAudio(mp3buf);
      return res.send(twiml(
        `🗣 ${original}`,
        translated,
        `<Media>${publicUrl}</Media>`
      ));
    }catch(e){
      console.error("TTS/upload error:",e.message);
      return res.send(twiml(`🗣 ${original}`,translated));
    }

  }catch(err){
    console.error("Webhook error:",err);
    return res.send(twiml("⚠️ Error processing message. Try again later."));
  }
});

/* ── HEALTH ── */
app.get("/healthz",(_,r)=>r.status(200).send("OK"));
app.listen(PORT,()=>console.log("🚀 running on",PORT));
