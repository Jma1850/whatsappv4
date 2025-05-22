# WhatsApp Voice Translator (Railway Edition)

## Quick Deploy
1. Click the **Deploy on Railway** button (add one in repo).
2. Set env vars as shown in `.env.example`.
3. In Twilio Console → WhatsApp Sandbox → set the incoming webhook to:
   ```
   https://<your-railway-domain>.up.railway.app/webhook
   ```
4. Send a voice note to your WhatsApp sandbox number and receive the Spanish translation back.

---
> **Note:** When you’re ready to scale or move to Supabase Edge Functions, copy the business logic (transcribe, translate, reply) into a Deno function wrapper—no other changes needed.
