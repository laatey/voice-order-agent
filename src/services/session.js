/**
 * In-memory call session store.
 * Key: callControlId (Telnyx) or callSid (TeXML)
 *
 * Each session holds:
 *   - conversationHistory  → messages array sent to Claude
 *   - currentOrder         → items accumulating during call
 *   - isSpeaking           → true while TTS audio is being streamed to caller
 *   - wsConnection         → the Telnyx media-stream WebSocket for this call
 *   - deepgramConn         → live Deepgram STT connection
 *   - caller               → caller's phone number
 *   - stage                → greeting | taking_order | confirming | collecting_details | done
 */

const sessions = new Map();

function create(callId, callerNumber) {
  const session = {
    callId,
    caller: callerNumber,
    stage: 'greeting',
    conversationHistory: [],
    currentOrder: {
      items: [],
      order_type: 'delivery',
      name: null,
      address: null,
      payment: null,
      notes: null,
    },
    isSpeaking: false,
    isProcessingTurn: false,
    queuedTranscript: '',
    ttsAbortController: null,   // used to cancel in-flight TTS on barge-in
    wsConnection: null,
    deepgramConn: null,
    vadBuffer: [],              // recent RMS values for voice activity detection
    createdAt: Date.now(),
  };
  sessions.set(callId, session);
  return session;
}

function get(callId) {
  return sessions.get(callId) || null;
}

function destroy(callId) {
  sessions.delete(callId);
}

function all() {
  return [...sessions.values()];
}

module.exports = { create, get, destroy, all };
