# Jimmy Prompt Tester

Internal tool for testing different system prompts and voice IDs against the Jimmy AI conversation system.

## Local Development

```bash
cd prompt-tester
npm install
npm run dev
# Opens at http://localhost:5174
```

Make sure the main backend is running (`cd backend && npm run dev`).

## Deploy to Vercel

1. Create a new Vercel project pointing to the `prompt-tester/` folder as the root.
2. Set the environment variable:
   ```
   VITE_BACKEND_URL=https://vice-lac.vercel.app
   ```
3. Deploy — Vercel will auto-detect Vite..

## Usage

1. **Backend URL** — point this to your deployed backend (or `http://localhost:3001` for local testing)
2. **Voice ID** — Resemble AI voice UUID. Default is Jimmy's voice `09d4ef3e`
3. **System Prompt** — the full system prompt sent to the LLM. Pre-filled with the current production prompt
4. Click **Start Call**, speak into your mic, and evaluate Jimmy's responses

The existing production app is **not affected** — custom prompt/voiceId only apply to calls that explicitly send them.
