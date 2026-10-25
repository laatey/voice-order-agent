const { v4: uuid } = require('uuid');
const db           = require('../db');
const menu         = require('../data/menu.json');

function calcTotals(items, orderType) {
  const subtotal = items.reduce((sum, i) => sum + (i.subtotal ?? i.qty * i.price), 0);
  const delivery = orderType === 'delivery'
    ? (subtotal >= menu.business.free_delivery_threshold ? 0 : menu.business.delivery_fee)
    : 0;
  return { subtotal, delivery, total: subtotal + delivery };
}

function saveOrder({ callSid, caller, items, orderType, name, address, payment, notes }) {
  const { subtotal, delivery, total } = calcTotals(items, orderType);
  const id = uuid();

  db.run(
    `INSERT INTO orders
       (id, call_sid, caller, status, items, subtotal, delivery, total,
        order_type, name, address, payment, notes)
     VALUES (?,?,?,'confirmed',?,?,?,?,?,?,?,?,?)`,
    [id, callSid, caller, JSON.stringify(items),
     subtotal, delivery, total, orderType,
     name || null, address || null, payment || null, notes || null]
  );

  console.log(`[orders] saved ${id} — GHS ${total} for ${caller}`);
  return { id, subtotal, delivery, total };
}

function saveCallLog({ callSid, caller, durationSec, orderId, transcript, outcome }) {
  db.run(
    `INSERT INTO call_logs (id, call_sid, caller, duration_sec, order_id, transcript, outcome)
     VALUES (?,?,?,?,?,?,?)`,
    [uuid(), callSid, caller, durationSec || 0, orderId || null, transcript, outcome]
  );
}

function getRecentOrders(limit = 50) {
  return db.all(`SELECT * FROM orders ORDER BY created_at DESC LIMIT ?`, [limit])
    .map(r => ({ ...r, items: JSON.parse(r.items) }));
}

function getOrder(id) {
  const row = db.get(`SELECT * FROM orders WHERE id = ?`, [id]);
  if (!row) return null;
  return { ...row, items: JSON.parse(row.items) };
}

module.exports = { saveOrder, saveCallLog, getRecentOrders, getOrder, calcTotals };
