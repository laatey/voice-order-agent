const { createClient, LiveTranscriptionEvents } = require('@deepgram/sdk');

let _dg = null;
function getDg() {
  if (!_dg) {
    if (!process.env.DEEPGRAM_API_KEY) throw new Error('[deepgram] DEEPGRAM_API_KEY is not set');
    _dg = createClient(process.env.DEEPGRAM_API_KEY);
  }
  return _dg;
}

/**
 * Open a Deepgram live transcription connection for one call.
 *
 * Returns a wrapper with:
 *   .send(buffer)  — forward raw mulaw audio bytes
 *   .finish()      — close cleanly
 *   .keepAlive()   — send keepalive so connection doesn't timeout during TTS
 *   .reopen()      — close current and open a fresh connection (used after barge-in)
 *
 * @param {object} options
 * @param {function} options.onFinal   — called with final transcript string
 * @param {function} options.onInterim — called with interim transcript string
 * @param {function} options.onError   — called on error
 */
function openConnection({ onFinal, onInterim, onError }) {
  let conn = null;
  let isOpen = false;
  let pendingAudio = [];
  let finalParts = [];
  let lastInterim = '';
  let interimTimer = null;

  function clearInterimTimer() {
    if (interimTimer) clearTimeout(interimTimer);
    interimTimer = null;
  }

  function flushFinal({ allowInterim = false } = {}) {
    const finalTranscript = finalParts.join(' ').replace(/\s+/g, ' ').trim();
    const transcript = finalTranscript || (allowInterim ? lastInterim.trim() : '');
    finalParts = [];
    lastInterim = '';
    clearInterimTimer();
    if (transcript) onFinal(transcript);
  }

  function rememberInterim(transcript) {
    lastInterim = transcript;
    clearInterimTimer();
    interimTimer = setTimeout(() => {
      flushFinal({ allowInterim: true });
    }, 1400);
  }

  function attach(c) {
    conn = c;
    isOpen = false;
    pendingAudio = [];
    finalParts = [];
    lastInterim = '';
    clearInterimTimer();

    conn.on(LiveTranscriptionEvents.Open, () => {
      isOpen = true;
      console.log('[deepgram] connection open');
      for (const buffer of pendingAudio) {
        try {
          conn.send(buffer);
        } catch (err) {
          console.error('[deepgram] send failed', err.message);
        }
      }
      pendingAudio = [];
    });

    conn.on(LiveTranscriptionEvents.Transcript, (data) => {
      const alt = data.channel?.alternatives?.[0];
      if (!alt || !alt.transcript) return;

      if (data.is_final) {
        finalParts.push(alt.transcript.trim());
        if (data.speech_final) flushFinal();
      } else {
        const transcript = alt.transcript.trim();
        rememberInterim(transcript);
        onInterim?.(transcript);
      }
    });

    conn.on(LiveTranscriptionEvents.Metadata, (data) => {
      console.log('[deepgram] metadata', JSON.stringify(data));
    });

    conn.on(LiveTranscriptionEvents.UtteranceEnd || 'UtteranceEnd', () => {
      flushFinal({ allowInterim: true });
    });

    conn.on(LiveTranscriptionEvents.SpeechStarted || 'SpeechStarted', () => {
      console.log('[deepgram] speech started');
    });

    conn.on(LiveTranscriptionEvents.Unhandled || 'Unhandled', (data) => {
      console.warn('[deepgram] unhandled', JSON.stringify(data));
    });

    conn.on(LiveTranscriptionEvents.Error, (err) => {
      console.error('[deepgram] error', err);
      onError?.(err);
    });

    conn.on(LiveTranscriptionEvents.Close, (event) => {
      isOpen = false;
      const details = event ? ` ${JSON.stringify({
        code: event.code,
        reason: event.reason,
        wasClean: event.wasClean,
      })}` : '';
      console.log(`[deepgram] connection closed${details}`);
    });
  }

  function createLive() {
    return getDg().listen.live({
      model:            'nova-3',
      language:         'en-US',
      encoding:         'mulaw',
      sample_rate:      8000,
      channels:         1,
      punctuate:        true,
      smart_format:     true,
      interim_results:  true,
      endpointing:      300,   // ms of silence → final transcript
      utterance_end_ms: '1000',
      vad_events:       true,
    });
  }

  attach(createLive());

  return {
    send(buffer) {
      if (conn) {
        if (!isOpen) {
          pendingAudio.push(buffer);
          if (pendingAudio.length > 250) pendingAudio.shift();
          return;
        }
        try {
          conn.send(buffer);
        } catch (err) {
          console.error('[deepgram] send failed', err.message);
        }
      }
    },

    finish() {
      if (conn) {
        flushFinal({ allowInterim: true });
        try { conn.finish(); } catch {}
        conn = null;
        isOpen = false;
      }
    },

    keepAlive() {
      if (conn) {
        try { conn.keepAlive(); } catch {}
      }
    },

    /** Close current connection and open a fresh one (call after barge-in). */
    reopen() {
      if (conn) {
        try { conn.finish(); } catch {}
        conn = null;
        isOpen = false;
      }
      attach(createLive());
      console.log('[deepgram] connection reopened after barge-in');
    },
  };
}

module.exports = { openConnection };
