const express = require('express');
const router  = express.Router();
const session = require('../services/session');

/**
 * POST /webhook/voice
 *
 * Twilio calls this URL when an inbound call arrives.
 * We respond with TwiML that opens a bidirectional Media Stream to our WS server,
 * then Twilio connects and starts sending audio.
 *
 * The caller's number (From) is in the POST body — we create the session here
 * so the WebSocket handler can look it up by callSid.
 */
router.post('/voice', (req, res) => {
  const callSid = req.body.CallSid;
  const caller  = req.body.From;

  console.log(`[webhook] inbound call | callSid=${callSid} caller=${caller}`);

  // Create session so mediaStream.js can find it by callSid
  session.create(callSid, caller);

  const wsUrl = `${(process.env.PUBLIC_URL || '').replace(/^http/, 'ws')}/media-stream`;

  // TwiML: connect the call to our WebSocket media stream
  res.setHeader('Content-Type', 'text/xml');
  res.send(`<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Connect>
    <Stream url="${wsUrl}" />
  </Connect>
</Response>`);
});

/**
 * POST /webhook/status
 *
 * Optional: Twilio call status callbacks (completed, failed, etc.)
 */
router.post('/status', (req, res) => {
  const { CallSid, CallStatus } = req.body;
  console.log(`[webhook] status | callSid=${CallSid} status=${CallStatus}`);
  res.sendStatus(200);
});

/**
 * GET /webhook — health/validation check
 */
router.get('/', (_req, res) => res.sendStatus(200));

module.exports = router;
