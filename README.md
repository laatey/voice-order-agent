# Voice Order Agent

An AI phone agent for taking restaurant orders. It answers calls with Twilio Media Streams, transcribes conversations with Deepgram, manages the order with Claude, and can notify a restaurant through Hubtel SMS.

## What it does

- Answers inbound phone calls through a Twilio webhook
- Streams live caller audio over WebSockets
- Turns speech into text with Deepgram
- Uses Claude to guide a menu-aware ordering conversation
- Stores active calls and orders locally with SQLite
- Sends order notifications by SMS through Hubtel

## Stack

Node.js, Express, WebSockets, Twilio, Deepgram, Anthropic Claude, sql.js, and Hubtel.

## Run locally

```bash
npm install
copy .env.example .env
npm start
```

Set the values in `.env` for Twilio, Deepgram, Anthropic, and (optionally) Hubtel. Point your Twilio Voice webhook at `POST /webhook`; the app exposes `GET /health` for deployment checks.

## Configuration

The example environment file contains placeholders only. Add real credentials exclusively to `.env`, which is ignored by Git. Configure the restaurant name, greeting, phone number, and menu for your own deployment.

## License

[MIT](LICENSE)
