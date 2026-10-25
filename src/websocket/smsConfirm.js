const menu = require('../data/menu.json');

/**
 * Helper to format phone number to international +233 format for Ghana
 */
function formatGhanaPhone(phone) {
  if (!phone) return '';
  const clean = phone.replace(/\D/g, ''); // remove non-digits
  if (clean.startsWith('233')) return `+${clean}`;
  if (clean.startsWith('0')) return `+233${clean.slice(1)}`;
  return `+233${clean}`;
}

/**
 * Send an SMS order confirmation to the caller via Hubtel.
 */
async function sendSmsConfirmation(to, { id, items, total }) {
  const clientId = process.env.HUBTEL_CLIENT_ID;
  const clientSecret = process.env.HUBTEL_CLIENT_SECRET;
  const senderId = process.env.HUBTEL_SENDER_ID || menu.business.name.slice(0, 11);

  if (!clientId || !clientSecret) {
    console.warn('[sms] Hubtel credentials are not fully configured in environment variables.');
    return;
  }

  try {
    const formattedPhone = formatGhanaPhone(to);
    if (!formattedPhone) return;

    const itemLines = items
      .map(i => `  ${i.qty}x ${i.name} — GHS ${i.subtotal}`)
      .join('\n');

    const message =
      `${menu.business.name} — Order Confirmed!\n` +
      `Order #${id.slice(0, 8).toUpperCase()}\n\n` +
      `${itemLines}\n\n` +
      `Total: GHS ${total}\n` +
      `Est. time: ${menu.business.estimated_delivery}\n\n` +
      `Thank you for your order!`;

    const params = new URLSearchParams({
      clientid: clientId,
      clientsecret: clientSecret,
      from: senderId,
      to: formattedPhone,
      content: message
    });

    const response = await fetch(`https://smsc.hubtel.com/v1/messages/send?${params}`, {
      method: 'GET'
    });

    if (!response.ok) {
      throw new Error(`HTTP error ${response.status}`);
    }

    const data = await response.json();
    if (data.status === 0 || data.message === "Success") {
      console.log(`[sms] Hubtel SMS confirmation sent successfully to ${formattedPhone}`);
    } else {
      console.error(`[sms] Hubtel API error: ${data.message} (status: ${data.status})`);
    }
  } catch (err) {
    console.error('[sms] failed to send Hubtel confirmation', err.message);
  }
}

module.exports = { sendSmsConfirmation };
