# ⚡ MINI BOT MD — 24/7 Zero-Sleep WhatsApp Bot for Heroku

Ultra-lightweight, crash-proof WhatsApp MD Bot designed specifically for Heroku Free & Eco dynos.

## 🚀 Key Advantages Over Heavy Bots:
1. **Ultra-Low Memory:** Sirf **35MB - 50MB RAM** leta hai (Heroku ki 512MB limit se 90% kam, kabhi freeze ya crash nahi hoga).
2. **24/7 Zero-Sleep:** Har 25 second baad public router ko self-ping bhejta hai taake Heroku ka 30-min idle sleep timer hamesha reset rahe.
3. **Web Pairing Code:** Kisi terminal ya QR scan ki zaroorat nahi. Direct browser par apna number daal kar 8-digit pairing code lein.
4. **Cloud Persistent Login:** Agar `MONGODB_URI` set ho, to dyno restart hone par bhi login session MongoDB Atlas se wapas restore ho jata hai.

---

## 📋 Available Commands:
| Command | Description |
| :--- | :--- |
| `.ping` | Bot ki response speed (latency), live RAM, aur uptime dikhata hai |
| `.menu` | Clean stylish command menu card |
| `.alive` | 24/7 online status confirm karta hai |
| `.ram` | Heroku V8 heap aur memory metrics detail mein batata hai |
| `.owner` | Bot owner contact card |
| `.echo <text>` | Text ko wapas echo karta hai |

---

## 🛠️ Heroku Par Deploy Kaise Karein (2 Minutes Guide):

### Step 1: Naya GitHub Repo Banayein
1. GitHub par ja kar ek naya private ya public repository banayein: `mini-bot-md`.
2. Apne computer ke terminal mein is folder (`D:\mini-bot`) se push karein:
```bash
cd D:\mini-bot
git init
git add .
git commit -m "feat: initial mini bot release"
git branch -M main
git remote add origin https://github.com/YOUR_USERNAME/mini-bot-md.git
git push -u origin main
```

### Step 2: Heroku Par Deploy Karein
1. [Heroku Dashboard](https://dashboard.heroku.com/apps) par **New > Create new app** karein (e.g. `saqib-mini-bot`).
2. **Deploy** tab par ja kar **GitHub** select karein aur `mini-bot-md` repo connect karein.
3. Neeche **"Deploy Branch"** (main) par click kar dein!

### Step 3: Config Vars Set Karein (Settings Tab)
Heroku app ki **Settings > Reveal Config Vars** mein ye add karein:
- `APP_URL`: `https://saqib-mini-bot.herokuapp.com` (Aapki Heroku app ka URL)
- `MONGODB_URI`: `mongodb+srv://ayeshasaqibdeveloper_db_user:PnvBxy3CUfX3VvMU@cluster0.pnvfozw.mongodb.net/?retryWrites=true&w=majority`
- `OWNER_NUMBER`: `923438673242`
- `OWNER_NAME`: `MR SAQIB`

---

## 📱 Bot Ko WhatsApp Se Pair Kaise Karein:
1. Browser mein apni Heroku app ka link open karein: `https://saqib-mini-bot.herokuapp.com`.
2. Apna WhatsApp number likhein (e.g. `923438673242`).
3. **"Get WhatsApp Pairing Code"** par click karein.
4. Phone par WhatsApp open karein ➔ **Linked Devices** ➔ **Link with Phone Number** ➔ 8-digit code daal dein.
5. Bot foran connect ho jayega aur WhatsApp par `.ping` bhej kar test karein!
