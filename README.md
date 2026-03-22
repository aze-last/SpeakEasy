# SpeakEasy — Setup Guide
### English · Tagalog · Bisaya Speech Transcriber
#### Whisper (local) + Qwen2.5 via Ollama + Expo Mobile App

---

## 📁 Project Structure

```
SpeakEasy/
├── backend/
│   └── server.py          ← FastAPI + Whisper + Ollama
├── SpeakEasy/             ← Expo mobile app
│   ├── App.js
│   ├── app.json
│   └── package.json
└── README.md
```

---

## ⚙️ STEP 1: Backend Setup (Your PC)

### Install dependencies
```bash
pip install fastapi uvicorn python-multipart openai-whisper torch httpx
```

### Make sure Ollama is running with Qwen2.5
```bash
ollama serve
# In another terminal, verify:
ollama list
# You should see qwen2.5 in the list
```

### Run the backend server
```bash
cd backend
uvicorn server:app --host 0.0.0.0 --port 8000 --reload
```

✅ First run downloads Whisper large-v3 model (~3GB). Subsequent runs are instant.

### Find your PC's local IP
```bash
# Windows
ipconfig
# Look for: IPv4 Address . . . . : 192.168.1.X
```

---

## ⚙️ STEP 2: Mobile App Setup

### Update your PC's IP in App.js
Open `SpeakEasy/App.js` and change line 19:
```js
const SERVER_URL = "http://192.168.1.X:8000";
//                           ^^^^^^^^^^^
//                    Replace with your actual PC IP
```

### Install and run
```bash
cd SpeakEasy
npm install
npx expo start
```

Scan the QR code with **Expo Go** app on your phone.
Both your phone and PC must be on the **same WiFi network**.

---

## 🔁 How It Works

```
📱 You tap record (or upload audio/video)
        ↓
📡 App sends file to your PC via local WiFi
        ↓
🧠 Whisper Large-V3 transcribes
   (English, Tagalog, Bisaya, auto-detected)
        ↓
🤖 Qwen2.5 summarizes into:
   • Key feedback points
   • Action items list
        ↓
📋 App shows transcript + summary + timeline
```

---

## 🛠 Troubleshooting

| Problem | Fix |
|---|---|
| "Cannot connect to server" | Check PC IP in App.js, make sure both on same WiFi |
| Whisper downloading slowly | Normal on first run (~3GB). Let it finish. |
| Ollama not responding | Run `ollama serve` in terminal |
| Wrong Qwen model name | Run `ollama list` and update `OLLAMA_MODEL` in server.py |
| Audio permission denied | Allow microphone in phone settings |
| Accuracy low on Bisaya | Expected ~75-80%. Edit corrections in transcript view. |

---

## 💡 Tips for Best Accuracy

- Record in a **quiet room**
- Hold phone **close to the speaker** (teacher)  
- Speak at **normal pace**, not too fast
- Shorter recordings (under 10 mins) process faster

---

## 🔐 Privacy
- All audio processed **locally on your PC**
- Nothing sent to cloud
- No API keys needed
- No token costs ever
