/**
 * tts.js — Text-to-Speech via Deepgram REST API
 *
 * Generates mulaw 8 kHz audio (matching Twilio Media Streams format) and
 * streams it back to the caller's Twilio WebSocket in 160-byte chunks
 * (20 ms each at 8000 samples/sec, 8-bit mulaw).
 *
 * Twilio media OUT format:
 *   { event: 'media', streamSid: '<sid>', media: { payload: '<base64 mulaw>' } }
 *
 * Twilio clear (barge-in / interrupt buffered audio):
 *   { event: 'clear', streamSid: '<sid>' }
 */

const https     = require('https');
const WebSocket = require('ws');

const DEEPGRAM_TTS_HOST = 'api.deepgram.com';
const DEEPGRAM_TTS_PATH = '/v1/speak?model=aura-asteria-en&encoding=mulaw&sample_rate=8000&container=none';

const CHUNK_BYTES = 160; // 20 ms of mulaw at 8 kHz

/**
 * Fetch TTS audio from Deepgram as a Buffer of raw mulaw bytes.
 */
function fetchTtsAudio(text) {
  return new Promise((resolve, reject) => {
    const apiKey = process.env.DEEPGRAM_API_KEY;
    if (!apiKey) return reject(new Error('[tts] DEEPGRAM_API_KEY not set'));

    const body = JSON.stringify({ text });

    const options = {
      hostname: DEEPGRAM_TTS_HOST,
      path:     DEEPGRAM_TTS_PATH,
      method:   'POST',
      headers: {
        'Authorization': `Token ${apiKey}`,
        'Content-Type':  'application/json',
        'Content-Length': Buffer.byteLength(body),
      },
    };

    const chunks = [];
    const req = https.request(options, (res) => {
      if (res.statusCode !== 200) {
        let err = '';
        res.on('data', d => err += d);
        res.on('end', () => reject(new Error(`[tts] Deepgram ${res.statusCode}: ${err}`)));
        return;
      }
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve(Buffer.concat(chunks)));
    });

    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

/**
 * Convert text to speech and stream mulaw audio back to the caller
 * via their Twilio media-stream WebSocket.
 *
 * @param {object} params
 * @param {string}    params.text      — text to speak
 * @param {WebSocket} params.callWs    — Twilio media-stream WS for this call
 * @param {object}    params.session   — call session (for barge-in flag + streamSid)
 * @returns {Promise<void>}            — resolves when done or interrupted
 */
async function speak({ text, callWs, session }) {
  if (!text || !callWs || callWs.readyState !== WebSocket.OPEN) return;

  const controller = new AbortController();
  session.ttsAbortController = controller;
  session.isSpeaking = true;

  try {
    const audioBuffer = await fetchTtsAudio(text);

    // Walk through the buffer in 160-byte (20 ms) chunks
    for (let offset = 0; offset < audioBuffer.length; offset += CHUNK_BYTES) {
      if (controller.signal.aborted) break;
      if (callWs.readyState !== WebSocket.OPEN) break;

      const chunk   = audioBuffer.slice(offset, offset + CHUNK_BYTES);
      const payload = chunk.toString('base64');

      callWs.send(JSON.stringify({
        event:     'media',
        streamSid: session.streamSid,
        media:     { payload },
      }));

      // Pace the chunks so they approximate real-time audio playback
      await sleep(20);
    }
  } catch (err) {
    console.error('[tts] error generating speech:', err.message);
  } finally {
    session.isSpeaking = false;
    session.ttsAbortController = null;
  }
}

/**
 * Interrupt any in-progress TTS (barge-in from caller).
 * Also sends a Twilio 'clear' event to flush buffered audio on their side.
 */
function interrupt(session) {
  if (session.ttsAbortController) {
    session.ttsAbortController.abort();
  }

  // Tell Twilio to discard any audio it has buffered
  if (session.wsConnection && session.wsConnection.readyState === WebSocket.OPEN && session.streamSid) {
    try {
      session.wsConnection.send(JSON.stringify({
        event:     'clear',
        streamSid: session.streamSid,
      }));
    } catch {}
  }
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

module.exports = { speak, interrupt };
