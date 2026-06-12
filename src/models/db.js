const path = require('path');
const Database = require('better-sqlite3');

const DB_PATH = path.join(__dirname, '..', 'data', 'cold_chain.db');

const db = new Database(DB_PATH);

db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
  CREATE TABLE IF NOT EXISTS batches (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    batch_no TEXT UNIQUE NOT NULL,
    source_type TEXT NOT NULL CHECK (source_type IN ('warehouse', 'store')),
    source_name TEXT NOT NULL,
    target_type TEXT NOT NULL CHECK (target_type IN ('warehouse', 'store')),
    target_name TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'PENDING_OUTBOUND'
      CHECK (status IN ('PENDING_OUTBOUND', 'IN_TRANSIT', 'PENDING_SIGN', 'SIGNED', 'FROZEN', 'REVIEWED_CLOSED')),
    outbound_operator TEXT,
    outbound_time TEXT,
    sign_operator TEXT,
    sign_time TEXT,
    freeze_reason TEXT,
    freeze_operator TEXT,
    freeze_time TEXT,
    freeze_evidence TEXT,
    review_opinion TEXT,
    review_operator TEXT,
    review_time TEXT,
    created_by TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime'))
  );

  CREATE TABLE IF NOT EXISTS boxes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    box_no TEXT NOT NULL,
    batch_id INTEGER NOT NULL,
    temperature REAL,
    seal_no TEXT,
    product_name TEXT,
    weight REAL,
    status TEXT NOT NULL DEFAULT 'PENDING_OUTBOUND'
      CHECK (status IN ('PENDING_OUTBOUND', 'IN_TRANSIT', 'PENDING_SIGN', 'SIGNED', 'FROZEN', 'REVIEWED_CLOSED')),
    sign_operator TEXT,
    sign_time TEXT,
    sign_temperature REAL,
    sign_seal_no TEXT,
    freeze_reason TEXT,
    freeze_operator TEXT,
    freeze_time TEXT,
    freeze_evidence TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime')),
    FOREIGN KEY (batch_id) REFERENCES batches(id),
    UNIQUE (box_no, batch_id)
  );

  CREATE INDEX IF NOT EXISTS idx_boxes_box_no ON boxes(box_no);
  CREATE INDEX IF NOT EXISTS idx_boxes_batch_id ON boxes(batch_id);
  CREATE INDEX IF NOT EXISTS idx_batches_batch_no ON batches(batch_no);
  CREATE INDEX IF NOT EXISTS idx_batches_status ON batches(status);

  CREATE TABLE IF NOT EXISTS audit_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    batch_no TEXT NOT NULL,
    box_no TEXT,
    action TEXT NOT NULL,
    old_status TEXT,
    new_status TEXT,
    operator TEXT NOT NULL,
    operator_role TEXT NOT NULL,
    details TEXT,
    evidence TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime'))
  );

  CREATE INDEX IF NOT EXISTS idx_audit_batch_no ON audit_logs(batch_no);
  CREATE INDEX IF NOT EXISTS idx_audit_box_no ON audit_logs(box_no);

  CREATE TABLE IF NOT EXISTS configs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    key TEXT UNIQUE NOT NULL,
    value TEXT NOT NULL,
    description TEXT,
    updated_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime'))
  );
`);

const configData = [
  { key: 'temp_min', value: '-25', description: '最低温度阈值（摄氏度）' },
  { key: 'temp_max', value: '-10', description: '最高温度阈值（摄氏度）' },
  { key: 'timeout_hours', value: '24', description: '出库到签收超时时长（小时）' },
  { key: 'seal_pattern', value: '^SEAL\\d{6,12}$', description: '封签号正则表达式' }
];

const insertConfig = db.prepare(`
  INSERT OR IGNORE INTO configs (key, value, description) VALUES (?, ?, ?)
`);
const transaction = db.transaction(() => {
  for (const c of configData) {
    insertConfig.run(c.key, c.value, c.description);
  }
});
transaction();

module.exports = db;
