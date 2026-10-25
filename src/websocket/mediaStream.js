/**
 * mediaStream.js
 *
 * Handles the Twilio bidirectional Media Streams WebSocket connection.
 *
 * Messages FROM Twilio:
 *   connected   — stream established
 *   start       — call metadata (streamSid, callSid, mediaFormat)
 *   media       — base64-encoded mulaw 8 kHz audio chunk (20 ms each)
 *   stop        — call ended / stream closed
 *
 * Messages TO Twilio (TTS audio):
 *   { event: 'media',  streamSid, media: { payload: '<base64 mulaw>' } }
 *   { event: 'clear',  streamSid }   ← flushes buffered audio (barge-in)
 *
 * Flow per audio chunk:
 *   1. Decode chunk, run VAD
 *   2. If caller speaking while AI is talking → barge-in, interrupt TTS
 *   3. Stream chunk to Deepgram STT
 *   4. On Deepgram final transcript → call Claude → speak response
 */

const session   = require('../services/session');
const deepgram  = require('../services/deepgram');
const claude    = require('../services/claude');
const tts       = require('../services/tts');
const vad       = require('../services/vad');
const orders    = require('../services/orders');
const twilioApi = require('../services/twilio');
const { sendSmsConfirmation } = require('./smsConfirm');
const menu      = require('../data/menu.json');

/**
 * Called by the WebSocket server for each new WS connection from Twilio.
 */
async function handleConnection(ws) {
  let sess = null;

  ws.on('message', async (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }

    switch (msg.event) {

      // ── connected ───────────────────────────────────────────────────────────
      case 'connected':
        console.log('[ws] media stream connected');
        break;

      // ── start ───────────────────────────────────────────────────────────────
      case 'start': {
        const { streamSid, callSid, mediaFormat } = msg.start;
        console.log(`[ws] stream start | callSid=${callSid} streamSid=${streamSid}`);
        if (mediaFormat) console.log('[ws] media format', JSON.stringify(mediaFormat));

        // Session was created in the webhook handler (where we have the caller number)
        sess = session.get(callSid);
        if (!sess) {
          console.warn(`[ws] no session for callSid=${callSid}, creating blank one`);
          sess = session.create(callSid, 'unknown');
        }

        sess.wsConnection  = ws;
        sess.streamSid     = streamSid;
        sess.callStartTime = Date.now();
        sess.mediaFrames   = 0;
        sess.deepgramFrames = 0;

        // Start listening before the greeting so early caller speech is not lost.
        sess.deepgramConn = deepgram.openConnection({
          onFinal:   (transcript) => handleFinalTranscript(sess, transcript),
          onInterim: (transcript) => {
            if (!sess._loggedFirstInterim) {
              sess._loggedFirstInterim = true;
              console.log(`[stt] interim: "${transcript}"`);
            }
          },
          onError:   (err) => console.error('[deepgram] error', err),
        });
        console.log('[ws] deepgram ready — listening for caller');
        sess.greetingDone = false;

        try {
          const greeting = await claude.generateGreeting(sess);
          if (sess.queuedTranscript) {
            console.log('[greeting] skipped playing greeting because user already spoke');
          } else {
            await tts.speak({ text: greeting, callWs: ws, session: sess });
          }
        } catch (err) {
          console.error('[greeting] error', err);
        }

        // Greeting finished — open Deepgram and start listening
        sess.greetingDone = true;
        console.log('[ws] greeting process complete');

        if (sess.queuedTranscript) {
          const queued = sess.queuedTranscript;
          sess.queuedTranscript = '';
          setImmediate(() => handleFinalTranscript(sess, queued));
        }
        break;
      }

      // ── media ────────────────────────────────────────────────────────────────
      case 'media': {
        if (!sess) return;

        const chunk = msg.media?.payload;
        if (!chunk) return;
        sess.mediaFrames = (sess.mediaFrames || 0) + 1;

        // Voice activity detection
        const { isSpeech, energy } = vad.processChunk(sess, chunk);

        if (sess.mediaFrames === 1) {
          const rawBytes = Buffer.byteLength(chunk, 'base64');
          console.log(`[ws] first media frame | track=${msg.media.track || 'unknown'} bytes=${rawBytes} energy=${Math.round(energy)}`);
        } else if (sess.mediaFrames % 250 === 0) {
          console.log(`[ws] media frames=${sess.mediaFrames} sentToDeepgram=${sess.deepgramFrames || 0} energy=${Math.round(energy)} speaking=${!!sess.isSpeaking}`);
        }

        if (sess.isSpeaking) {
          // Buffer the frame during VAD assessment
          sess.bargeInBuffer = sess.bargeInBuffer || [];
          sess.bargeInBuffer.push(Buffer.from(chunk, 'base64'));
          if (sess.bargeInBuffer.length > 12) { // Keep last ~240ms of audio
            sess.bargeInBuffer.shift();
          }

          // Barge-in: only trigger after BARGE_IN_FRAMES consecutive speech frames
          if (isSpeech) {
            console.log('[vad] barge-in detected, flushing audio buffer');
            tts.interrupt(sess);

            // Send the buffered audio frames to Deepgram so the start of the sentence is not cut off
            if (sess.deepgramConn && sess.bargeInBuffer.length > 0) {
              for (const buf of sess.bargeInBuffer) {
                sess.deepgramConn.send(buf);
                sess.deepgramFrames = (sess.deepgramFrames || 0) + 1;
              }
            }
            sess.bargeInBuffer = [];
          } else {
            // AI is speaking, caller silent — keep Deepgram alive so it doesn't timeout (max once per 10 seconds)
            if (sess.deepgramConn) {
              const now = Date.now();
              sess.lastDgKeepAlive = sess.lastDgKeepAlive || 0;
              if (now - sess.lastDgKeepAlive > 10000) {
                sess.deepgramConn.keepAlive();
                sess.lastDgKeepAlive = now;
              }
            }
            break;
          }
        } else {
          // If we are not speaking, clear any leftover barge-in buffer
          sess.bargeInBuffer = [];

          // Forward caller audio to Deepgram STT.
          if (sess.deepgramConn) {
            sess.deepgramConn.send(Buffer.from(chunk, 'base64'));
            sess.deepgramFrames = (sess.deepgramFrames || 0) + 1;
          }
        }
        break;
      }

      // ── stop ────────────────────────────────────────────────────────────────
      case 'stop': {
        console.log('[ws] stream stop');
        if (sess) await handleCallEnd(sess);
        break;
      }
    }
  });

  ws.on('close', async () => {
    if (sess) await handleCallEnd(sess);
  });

  ws.on('error', (err) => {
    console.error('[ws] error', err.message);
  });
}

// ─── Handle a final transcript from Deepgram ──────────────────────────────────

async function handleFinalTranscript(sess, transcript) {
  transcript = (transcript || '').trim();
  if (!transcript || sess.stage === 'done') return;

  if (!sess.greetingDone || sess.isSpeaking || sess.isProcessingTurn) {
    sess.queuedTranscript = [sess.queuedTranscript, transcript].filter(Boolean).join(' ');
    console.log(`[stt] queued while busy (greetingDone=${sess.greetingDone}): "${transcript}"`);
    if (sess.isSpeaking) {
      console.log('[vad] interrupting current speech');
      tts.interrupt(sess);
    }
    return;
  }

  sess.isProcessingTurn = true;

  try {
    let nextTranscript = transcript;

    while (nextTranscript && sess.stage !== 'done') {
      console.log(`[stt] final: "${nextTranscript}"`);

      const { say, toolCall } = await claude.turn(sess, nextTranscript);

      if (say) {
        console.log(`[ai] say: "${say}"`);
        await tts.speak({ text: say, callWs: sess.wsConnection, session: sess });
      }

      if (toolCall) {
        await handleToolCall(sess, toolCall);
      }

      nextTranscript = (sess.queuedTranscript || '').trim();
      sess.queuedTranscript = '';
    }

  } catch (err) {
    console.error('[claude] error', err);
    await tts.speak({
      text: "Sorry, I had a little trouble there. Could you repeat that?",
      callWs: sess.wsConnection,
      session: sess,
    });
  } finally {
    sess.isProcessingTurn = false;

    if (sess.queuedTranscript && sess.stage !== 'done') {
      const queued = sess.queuedTranscript;
      sess.queuedTranscript = '';
      setImmediate(() => handleFinalTranscript(sess, queued));
    }
  }
}

// ─── Handle Claude tool calls ─────────────────────────────────────────────────

async function handleToolCall(sess, toolCall) {
  console.log(`[tool] ${toolCall.name}`, JSON.stringify(toolCall.input));

  if (toolCall.name === 'save_order') {
    try {
      const { id, subtotal, delivery, total } = orders.saveOrder({
        callSid:   sess.callId,
        caller:    sess.caller,
        items:     toolCall.input.items,
        orderType: toolCall.input.order_type,
        name:      toolCall.input.name,
        address:   toolCall.input.address,
        payment:   toolCall.input.payment,
        notes:     toolCall.input.notes,
      });

      sess.stage = 'done';

      const { say, toolCall: next } = await claude.sendToolResult(
        sess, toolCall.id, 'save_order',
        { success: true, orderId: id, total, estimatedTime: menu.business.estimated_delivery }
      );

      if (say) {
        await tts.speak({ text: say, callWs: sess.wsConnection, session: sess });
      }

      await sendSmsConfirmation(sess.caller, { id, items: toolCall.input.items, total });

      if (next?.name === 'end_call') {
        await handleToolCall(sess, next);
      }

    } catch (err) {
      console.error('[save_order] error', err);
      await tts.speak({
        text: "I'm sorry, there was a problem saving your order. Please call back and we'll sort it out.",
        callWs: sess.wsConnection,
        session: sess,
      });
    }

  } else if (toolCall.name === 'end_call') {
    setTimeout(async () => {
      try {
        await twilioApi.hangup(sess.callId);
      } catch {}
    }, 2500);
  }
}

// ─── Call cleanup ─────────────────────────────────────────────────────────────

async function handleCallEnd(sess) {
  if (sess._ended) return;
  sess._ended = true;

  const durationSec = Math.round((Date.now() - (sess.callStartTime || Date.now())) / 1000);
  console.log(`[call] ended | caller=${sess.caller} duration=${durationSec}s`);
  console.log(`[call] audio stats | mediaFrames=${sess.mediaFrames || 0} sentToDeepgram=${sess.deepgramFrames || 0}`);

  if (sess.deepgramConn) {
    try { sess.deepgramConn.finish(); } catch {}
  }

  try {
    orders.saveCallLog({
      callSid:     sess.callId,
      caller:      sess.caller,
      durationSec,
      transcript:  JSON.stringify(sess.conversationHistory),
      outcome:     sess.stage === 'done' ? 'order_placed' : 'no_order',
    });
  } catch (err) {
    console.error('[call_log] error', err);
  }

  session.destroy(sess.callId);
}

module.exports = { handleConnection };
