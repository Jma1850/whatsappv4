/* ────────────────────────────────────────────────────────────────────────
   server.js  –  WhatsApp voice + text translator bot (runtime voices)
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

/* ── express ── */
const app = express();
app.use(bodyParser.urlencoded({ extended:false }));
app.use(bodyParser.json());

/* ── pilot language menu ── */
const MENU = {
  1:{ name:"English",    code:"en" },
  2:{ name:"Spanish",    code:"es" },
  3:{ name:"French",     code:"fr" },
  4:{ name:"Portuguese", code:"pt" },
  5:{ name:"German",     code:"de" }
};
const DIGITS = Object.keys(MENU);
const menu = t => `${t}\n\n`+DIGITS.map(d=>`${d}️⃣ ${MENU[d].name} (${MENU[d].code})`).join("\n");
const pick = txt => { const m=txt.trim(); const d=m.match(/^\d/); if(d&&MENU[d])return MENU[d]; const lc=m.toLowerCase(); return Object.values(MENU).find(o=>o.code===lc||o.name.toLowerCase()===lc); };
const twiml = (...msg)=>`<Response>${msg.map(m=>`\n<Message>${m}</Message>`).join("")}\n</Response>`;

/* ffmpeg, whisper, detect, translate helpers unchanged … */
/* runtime voice discovery helpers unchanged … */
/* pre-warm cache at boot unchanged … */

/* ── webhook ── */
app.post("/webhook", async (req,res)=>{
  console.log("📩 Incoming", { From:req.body.From, NumMedia:req.body.NumMedia, MediaType:req.body.MediaContentType0 });

  try{
    const phone=req.body.From;
    const text =(req.body.Body||"").trim();
    const mUrl=req.body.MediaUrl0, mType=req.body.MediaContentType0;

    /* RESET command */
    if(/^(reset|change language)$/i.test(text)){
      await supabase.from("users").upsert({ phone_number:phone, language_step:"source", source_lang:null, target_lang:null, tts_rate:"90%" });
      return res.send(twiml(menu("🔄 Setup reset!\nPick the language you RECEIVE:")));   // ← fixed
    }

    /* fetch user */
    let {data:u}=await supabase.from("users").select("*").eq("phone_number",phone).single();
    if(!u){ await supabase.from("users").insert({ phone_number:phone, language_step:"source", tts_rate:"90%" }); u={language_step:"source"}; }

    /* source step */
    if(u.language_step==="source"){
      const c=pick(text);
      if(c){ await supabase.from("users").update({source_lang:c.code,language_step:"target"}).eq("phone_number",phone);
        return res.send(twiml(menu("✅ Now pick the language I should SEND:"))); }
      return res.send(twiml("❌ Reply 1-5.",menu("Languages:")));
    }

    /* target step */
    if(u.language_step==="target"){
      const c=pick(text);
      if(c){
        if(c.code===u.source_lang) return res.send(twiml("⚠️ Target must differ from source. Pick again.",menu("Languages:")));  // ← fixed
        await supabase.from("users").update({target_lang:c.code,language_step:"voice"}).eq("phone_number",phone);
        return res.send(twiml("🔉 Choose voice speed:\n1️⃣ Normal\n2️⃣ Slow (80%)"));
      }
      return res.send(twiml("❌ Reply 1-5.",menu("Languages:")));
    }

    /* voice-speed, translation, etc.  (unchanged) */
    /* … */
  }catch(err){
    console.error("Webhook error:",err);
    return res.send(twiml("⚠️ Error processing voice note. Please try again."));
  }
});

/* health + listen unchanged */
app.get("/healthz",(_,r)=>r.status(200).send("OK"));
app.listen(PORT,()=>console.log("🚀 running on",PORT));
