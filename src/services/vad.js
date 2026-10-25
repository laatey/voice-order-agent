/**
 * Simple energy-based Voice Activity Detector.
 *
 * Twilio streams base64-encoded PCMU (G.711 mu-law) at 8kHz in 20ms chunks.
 * We decode each chunk to linear PCM, compute RMS, and require a few
 * consecutive speech frames before triggering barge-in.
 */

const ULAW_TABLE = (() => {
  const t = new Int16Array(256);
  for (let i = 0; i < 256; i++) {
    let u = ~i;
    const sign = u & 0x80;
    const exp = (u >> 4) & 0x07;
    let mantissa = u & 0x0f;
    mantissa = (mantissa << 3) | 0x84;
    let value = mantissa << (exp + 1);
    value -= 0x84;
    t[i] = sign ? -value : value;
  }
  return t;
})();

const WINDOW_SIZE = 8;       // frames to average, about 160ms
const SPEAK_THRESH = 1000;   // normal phone noise is often around 200-500 RMS
const SILENCE_THRESH = 600;
const BARGE_IN_FRAMES = 8;   // about 160ms of sustained speech

function decodeMulaw(buffer) {
  const out = new Int16Array(buffer.length);
  for (let i = 0; i < buffer.length; i++) {
    out[i] = ULAW_TABLE[buffer[i]];
  }
  return out;
}

function rms(pcm) {
  let sum = 0;
  for (let i = 0; i < pcm.length; i++) sum += pcm[i] * pcm[i];
  return Math.sqrt(sum / pcm.length);
}

function processChunk(session, base64Chunk) {
  const raw = Buffer.from(base64Chunk, 'base64');
  const pcm = decodeMulaw(raw);
  const energy = rms(pcm);

  session.vadBuffer = session.vadBuffer || [];
  session.vadBuffer.push(energy);
  if (session.vadBuffer.length > WINDOW_SIZE) session.vadBuffer.shift();

  const avgEnergy = session.vadBuffer.reduce((a, b) => a + b, 0) / session.vadBuffer.length;
  const frameIsSpeech = energy > SPEAK_THRESH;

  session.vadSpeechStreak = session.vadSpeechStreak || 0;
  if (frameIsSpeech) {
    session.vadSpeechStreak++;
  } else {
    session.vadSpeechStreak = 0;
  }

  return {
    isSpeech: session.vadSpeechStreak >= BARGE_IN_FRAMES,
    isSilence: avgEnergy < SILENCE_THRESH,
    energy: avgEnergy,
  };
}

module.exports = { processChunk, SPEAK_THRESH, SILENCE_THRESH };
