-- Orders table
CREATE TABLE IF NOT EXISTS orders (
  id          TEXT PRIMARY KEY,
  call_sid    TEXT NOT NULL,
  caller      TEXT NOT NULL,           -- phone number that called
  status      TEXT NOT NULL DEFAULT 'pending',  -- pending | confirmed | cancelled
  items       TEXT NOT NULL,           -- JSON array
  subtotal    REAL NOT NULL DEFAULT 0,
  delivery    REAL NOT NULL DEFAULT 0,
  total       REAL NOT NULL DEFAULT 0,
  order_type  TEXT NOT NULL DEFAULT 'delivery', -- delivery | pickup
  name        TEXT,
  address     TEXT,
  payment     TEXT,
  notes       TEXT,
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Call logs table
CREATE TABLE IF NOT EXISTS call_logs (
  id            TEXT PRIMARY KEY,
  call_sid      TEXT NOT NULL,
  caller        TEXT NOT NULL,
  duration_sec  INTEGER DEFAULT 0,
  order_id      TEXT,
  transcript    TEXT,   -- full JSON conversation history
  outcome       TEXT,   -- order_placed | no_order | error | hung_up
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_orders_caller    ON orders(caller);
CREATE INDEX IF NOT EXISTS idx_orders_status    ON orders(status);
CREATE INDEX IF NOT EXISTS idx_orders_created   ON orders(created_at);
CREATE INDEX IF NOT EXISTS idx_call_logs_caller ON call_logs(caller);
