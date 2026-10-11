!! ЭТО НЕ ПРОД, НЕТУ БЕЗОПАСНОЙ ЛОГИКИ !!


# AutoCaller

Сервіс для прийому заявок і запуску голосових дзвінків через Twilio, Telegram і голосові AI-сервіси. Користувач залишає дані у формі, сервер перевіряє номер, зберігає ліда в SQLite і надсилає його авторизованим операторам у Telegram. Оператор запускає дзвінок вручну через `/call` або `/dial`, а під час розмови Twilio Media Streams передають аудіо в Deepgram, DeepSeek формує відповідь, а ElevenLabs озвучує її назад у дзвінок.

Ідея взята з проєкту: https://github.com/Barty-Bart/elevenlabs-twilio-ai-caller

## Run on VPS

1. Все скопювати з `.env.example` у `.env` і заповнити токени.
2. Встанови `PUBLIC_BASE_URL` на публічну HTTPS-адресу без шляху.
3. Запусти:

```bash
npm ci
npm start
```

## Linux example

```bash
cp .env.example .env
nano .env
npm ci
NODE_ENV=production PORT=3000 npm start
```

## Стек

- Node.js + Express
- SQLite
- Twilio Voice + Media Streams
- Deepgram
- DeepSeek
- ElevenLabs
- Telegram bot

## Requirements

- Node.js 20+
- A public HTTPS domain pointing to the VPS
- A Twilio account and voice-enabled US/Canada number with outbound calling enabled for the destinations
- DeepSeek API key
- Deepgram API key with live streaming access
- ElevenLabs API key and voice ID
