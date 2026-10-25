const Anthropic = require('@anthropic-ai/sdk');
const menu      = require('../data/menu.json');

let _anthropic = null;
function getClient() {
  if (!_anthropic) {
    if (!process.env.ANTHROPIC_API_KEY) throw new Error('[claude] ANTHROPIC_API_KEY is not set');
    _anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  }
  return _anthropic;
}

// ─── System Prompt ───────────────────────────────────────────────────────────

function buildSystemPrompt() {
  const menuText = JSON.stringify(menu, null, 2);
  return `You are a friendly, efficient AI order-taker for ${menu.business.name}. 
Your job is to take food orders over the phone in a natural, conversational way.

PERSONALITY:
- Warm and helpful but concise — this is a phone call, not a chat
- Speak naturally, as if you are a real person
- Use short sentences. Avoid long monologues.
- If the caller is unclear, ask one focused clarifying question

YOUR GOALS (in order):
1. Greet the caller warmly
2. Take their order — confirm each item clearly (name, size, quantity, price)
3. Suggest a relevant deal or upsell if natural (don't be pushy)
4. Ask delivery or pickup
5. If delivery: get their name, delivery address, and preferred payment method
6. If pickup: get their name
7. Confirm the full order and total before finalising
8. Call the save_order tool to save it
9. Tell them the estimated wait time and say goodbye

RULES:
- ONLY sell items on the menu. If asked for something not on the menu, apologise and suggest alternatives.
- Always confirm prices when adding items
- If caller wants to change/remove items, do so before confirming
- Keep responses SHORT — under 40 words ideally. You are on a phone call.
- Do not say "certainly", "absolutely", "of course", "sure thing". Just be natural.
- Do not read out the entire menu unprompted. Describe categories if asked.
- Currency is GHS (Ghana Cedis). Say "cedis" not "GHS".
- Delivery fee is ${menu.business.delivery_fee} cedis (free over ${menu.business.free_delivery_threshold} cedis)

CURRENT MENU (for your reference only — do not read this out verbatim):
${menuText}

When you are ready to finalise, call the save_order tool with the complete order details.
When you want to end the call, call the end_call tool.`;
}

// ─── Tool Definitions ────────────────────────────────────────────────────────

const tools = [
  {
    name: 'save_order',
    description: 'Save a confirmed order to the database. Call this ONLY after the caller has confirmed all items and details.',
    input_schema: {
      type: 'object',
      properties: {
        items: {
          type: 'array',
          description: 'Array of ordered items',
          items: {
            type: 'object',
            properties: {
              id:       { type: 'string', description: 'Menu item ID' },
              name:     { type: 'string', description: 'Item name as spoken by caller' },
              qty:      { type: 'number', description: 'Quantity' },
              price:    { type: 'number', description: 'Unit price in GHS' },
              subtotal: { type: 'number', description: 'qty × price' },
            },
            required: ['name', 'qty', 'price', 'subtotal'],
          },
        },
        order_type: { type: 'string', enum: ['delivery', 'pickup'] },
        name:       { type: 'string',  description: 'Customer name' },
        address:    { type: 'string',  description: 'Delivery address (if delivery)' },
        payment:    { type: 'string',  description: 'Payment method chosen by customer' },
        notes:      { type: 'string',  description: 'Any special instructions' },
        total:      { type: 'number',  description: 'Order total including delivery fee' },
      },
      required: ['items', 'order_type', 'name', 'total'],
    },
  },
  {
    name: 'end_call',
    description: 'Signal that the conversation is complete and the call should be ended.',
    input_schema: {
      type: 'object',
      properties: {
        reason: {
          type: 'string',
          enum: ['order_placed', 'no_order', 'caller_request'],
          description: 'Why the call is ending',
        },
      },
      required: ['reason'],
    },
  },
];

// ─── Main turn function ───────────────────────────────────────────────────────

/**
 * Send a user transcript to Claude and get a response.
 *
 * @param {object} session   — call session (we read/mutate conversationHistory)
 * @param {string} userText  — latest transcript from Deepgram
 * @returns {object} { say: string, toolCall: object|null }
 *   say      — text to speak to the caller
 *   toolCall — { name, input } if Claude invoked a tool, else null
 */
async function turn(session, userText) {
  // Add user message to history
  session.conversationHistory.push({ role: 'user', content: userText });

  const response = await getClient().messages.create({
    model:      'claude-haiku-4-5-20251001',
    max_tokens: 300,
    system:     buildSystemPrompt(),
    tools,
    messages:   session.conversationHistory,
  });

  // Build assistant message for history
  const assistantMsg = { role: 'assistant', content: response.content };
  session.conversationHistory.push(assistantMsg);

  // Extract text and tool calls from response
  let sayText  = '';
  let toolCall = null;

  for (const block of response.content) {
    if (block.type === 'text') {
      sayText += block.text;
    } else if (block.type === 'tool_use') {
      toolCall = { id: block.id, name: block.name, input: block.input };
    }
  }

  // If there was a tool call, we need to add a tool_result and do one more turn
  // to get Claude's spoken response after the tool
  if (toolCall) {
    // Caller hears the text BEFORE the tool result (if any was in this response)
    // We'll handle tool result → follow-up response in the caller
    return { say: sayText.trim(), toolCall };
  }

  return { say: sayText.trim(), toolCall: null };
}

/**
 * Send tool result back to Claude to get its verbal acknowledgement.
 * Used after save_order so Claude can say "Great, your order is confirmed!"
 */
async function sendToolResult(session, toolCallId, toolName, result) {
  session.conversationHistory.push({
    role: 'user',
    content: [{
      type: 'tool_result',
      tool_use_id: toolCallId,
      content: JSON.stringify(result),
    }],
  });

  const response = await getClient().messages.create({
    model:      'claude-haiku-4-5-20251001',
    max_tokens: 200,
    system:     buildSystemPrompt(),
    tools,
    messages:   session.conversationHistory,
  });

  session.conversationHistory.push({ role: 'assistant', content: response.content });

  const sayText = response.content
    .filter(b => b.type === 'text')
    .map(b => b.text)
    .join(' ')
    .trim();

  const nextTool = response.content.find(b => b.type === 'tool_use');

  return {
    say: sayText,
    toolCall: nextTool ? { id: nextTool.id, name: nextTool.name, input: nextTool.input } : null,
  };
}

/**
 * Generate the opening greeting for a new call.
 */
async function greet(session) {
  return turn(session, '__CALL_START__');
}

// Inject a synthetic user message to kick off the greeting
// (we use a sentinel that the system prompt knows to treat as call start)
const GREET_INJECTION = `[SYSTEM: A new customer has just called. Greet them warmly and ask what they'd like to order. Keep it to 2 sentences max.]`;

async function generateGreeting(session) {
  session.conversationHistory.push({ role: 'user', content: GREET_INJECTION });

  const response = await getClient().messages.create({
    model:      'claude-haiku-4-5-20251001',
    max_tokens: 100,
    system:     buildSystemPrompt(),
    tools,
    messages:   session.conversationHistory,
  });

  session.conversationHistory.push({ role: 'assistant', content: response.content });

  const sayText = response.content
    .filter(b => b.type === 'text')
    .map(b => b.text)
    .join(' ')
    .trim();

  return sayText;
}

module.exports = { turn, sendToolResult, generateGreeting };
