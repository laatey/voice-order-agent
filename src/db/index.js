const initSqlJs = require('sql.js');
const fs        = require('fs');
const path      = require('path');

const DB_PATH   = process.env.DB_PATH || '/tmp/orders.db';
const SCHEMA    = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');

let db   = null;
let SQL  = null;

/**
 * sql.js keeps the DB in memory and we flush to disk on every write.
 * For Railway: mount a persistent volume at /data and set DB_PATH=/data/orders.db
 */
async function init() {
  SQL = await initSqlJs();

  if (fs.existsSync(DB_PATH)) {
    const filebuffer = fs.readFileSync(DB_PATH);
    db = new SQL.Database(filebuffer);
  } else {
    db = new SQL.Database();
  }

  db.run(SCHEMA);
  flush();
  console.log(`[db] sql.js ready at ${DB_PATH}`);
}

function flush() {
  if (!db) return;
  const data = db.export();
  fs.writeFileSync(DB_PATH, Buffer.from(data));
}

function getDb() {
  if (!db) throw new Error('[db] not initialised — await init() first');
  return db;
}

/**
 * Thin wrappers that match better-sqlite3's synchronous API
 * so the rest of the codebase doesn't change.
 */
function run(sql, params = []) {
  getDb().run(sql, params);
  flush();
}

function get(sql, params = []) {
  const stmt = getDb().prepare(sql);
  stmt.bind(params);
  if (stmt.step()) {
    const row = stmt.getAsObject();
    stmt.free();
    return row;
  }
  stmt.free();
  return null;
}

function all(sql, params = []) {
  const results = [];
  const stmt = getDb().prepare(sql);
  stmt.bind(params);
  while (stmt.step()) results.push(stmt.getAsObject());
  stmt.free();
  return results;
}

module.exports = { init, getDb, run, get, all, flush };
