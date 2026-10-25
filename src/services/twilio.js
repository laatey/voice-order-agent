const https = require('https');
const qs    = require('querystring');

function request(method, path, body) {
  return new Promise((resolve, reject) => {
    const accountSid = process.env.TWILIO_ACCOUNT_SID;
    const authToken  = process.env.TWILIO_AUTH_TOKEN;
    const data       = body ? qs.stringify(body) : null;

    const options = {
      method,
      hostname: 'api.twilio.com',
      path,
      auth: `${accountSid}:${authToken}`,
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Accept':       'application/json',
        ...(data ? { 'Content-Length': Buffer.byteLength(data) } : {}),
      },
    };

    const req = https.request(options, (res) => {
      let raw = '';
      res.on('data', c => raw += c);
      res.on('end', () => {
        try { resolve(JSON.parse(raw)); }
        catch { resolve(raw); }
      });
    });

    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

/**
 * Hang up an active call via the Twilio REST API.
 */
async function hangup(callSid) {
  const accountSid = process.env.TWILIO_ACCOUNT_SID;
  return request(
    'POST',
    `/2010-04-01/Accounts/${accountSid}/Calls/${callSid}.json`,
    { Status: 'completed' }
  );
}

/**
 * Send an SMS message via Twilio.
 */
async function sendSms(to, message) {
  const accountSid = process.env.TWILIO_ACCOUNT_SID;
  return request(
    'POST',
    `/2010-04-01/Accounts/${accountSid}/Messages.json`,
    {
      From: process.env.TWILIO_FROM_NUMBER,
      To:   to,
      Body: message,
    }
  );
}

module.exports = { hangup, sendSms };
