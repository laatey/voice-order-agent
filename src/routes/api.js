const express  = require('express');
const router   = express.Router();
const orders   = require('../services/orders');
const session  = require('../services/session');
const menu     = require('../data/menu.json');

// GET /api/orders — recent orders
router.get('/orders', (req, res) => {
  const limit = parseInt(req.query.limit) || 50;
  res.json(orders.getRecentOrders(limit));
});

// GET /api/orders/:id
router.get('/orders/:id', (req, res) => {
  const order = orders.getOrder(req.params.id);
  if (!order) return res.status(404).json({ error: 'Not found' });
  res.json(order);
});

// GET /api/calls — active calls
router.get('/calls', (req, res) => {
  const active = session.all().map(s => ({
    callId:  s.callId,
    caller:  s.caller,
    stage:   s.stage,
    items:   s.currentOrder.items,
    since:   s.createdAt,
  }));
  res.json(active);
});

// GET /api/menu
router.get('/menu', (req, res) => {
  res.json(menu);
});

module.exports = router;
