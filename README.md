# ⚡ MINI BOT MD v2.0 — 24/7 Zero-Sleep WhatsApp Bot for Heroku

Ultra-lightweight, crash-proof WhatsApp MD Bot (**Baileys v7 + 120+ Commands**) designed specifically for Heroku Free & Eco dynos (stays well below 512 MB RAM).

## 🚀 Key Features:
1. **Low Memory Footprint:** ~65–95 MB RAM (no heavy native `sharp`/`ffmpeg` bloat; runs cleanly with `--max-old-space-size=250`).
2. **24/7 Zero-Sleep Keepalive:** Har 25 second baad public `/health` endpoint ko self-ping bhejta hai.
3. **Web Pairing Code:** Browser UI se number daal kar instant 8-digit pairing code lein (`/pair?number=...`).
4. **Cloud Persistent Login + 401 Shield:** Lean MongoDB Atlas backup & auto-restore + transient disconnect/401 protection.
5. **120+ Commands:** Categorized menus for Owner, Group, Channel (`@newsletter`), Downloader, aur Tools/Search.

---

## 🛠️ Heroku Par Deploy Kaise Karein:

1. Repo push karein (`git push origin main`).
2. [Heroku Dashboard](https://dashboard.heroku.com/apps) par **New > Create new app** karein aur **Deploy > GitHub** se connect karein (standard `heroku/nodejs` buildpack).
3. **Settings > Reveal Config Vars** mein ye add karein:
   - `APP_URL`: `https://your-app-name.herokuapp.com`
   - `MONGODB_URI`: `mongodb+srv://<username>:<password>@<cluster>.mongodb.net/?retryWrites=true&w=majority`
   - `OWNER_NUMBER`: `923438673242`
   - `OWNER_NAME`: `MR SAQIB`
   - `BOT_NAME`: `MINI BOT MD`
4. Heroku par **Deploy Branch (`main`)** par click karein, web app open karke phone number pair karein, aur WhatsApp par `.menu` bhejein!
