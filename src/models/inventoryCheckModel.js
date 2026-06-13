const db = require('./db');

function insertCheck(checkNo, location, operator) {
  return db.prepare(`
    INSERT INTO inventory_checks (check_no, location, status, created_by)
    VALUES (?, ?, 'DRAFT', ?)
  `).run(checkNo, location, operator);
}

function findCheckByNo(checkNo) {
  return db.prepare('SELECT * FROM inventory_checks WHERE check_no = ?').get(checkNo);
}

function findCheckById(id) {
  return db.prepare('SELECT * FROM inventory_checks WHERE id = ?').get(id);
}

function listChecks({ location, status }) {
  let sql = 'SELECT * FROM inventory_checks WHERE 1=1';
  const params = [];
  if (location) {
    sql += ' AND location = ?';
    params.push(location);
  }
  if (status) {
    sql += ' AND status = ?';
    params.push(status);
  }
  sql += ' ORDER BY id DESC';
  return db.prepare(sql).all(...params);
}

function getCheckItems(checkId) {
  return db.prepare('SELECT * FROM inventory_check_items WHERE check_id = ? ORDER BY id').all(checkId);
}

function deleteCheckItems(checkId) {
  return db.prepare('DELETE FROM inventory_check_items WHERE check_id = ?').run(checkId);
}

function insertCheckItem(checkId, boxNo, operator) {
  return db.prepare(`
    INSERT INTO inventory_check_items (check_id, box_no, operator)
    VALUES (?, ?, ?)
  `).run(checkId, boxNo, operator);
}

function findCheckItem(checkId, boxNo) {
  return db.prepare('SELECT id FROM inventory_check_items WHERE check_id = ? AND box_no = ?').get(checkId, boxNo);
}

function findSystemBox(boxNo) {
  return db.prepare(`
    SELECT b.status, b.box_no, ba.batch_no, ba.source_name, ba.target_name, ba.outbound_time
    FROM boxes b
    JOIN batches ba ON b.batch_id = ba.id
    WHERE b.box_no = ?
    ORDER BY b.id DESC LIMIT 1
  `).get(boxNo);
}

function findExpectedBoxesAtLocation(location) {
  return db.prepare(`
    SELECT b.box_no, b.status, ba.batch_no, ba.source_name, ba.target_name, ba.outbound_time
    FROM boxes b
    JOIN batches ba ON b.batch_id = ba.id
    WHERE b.status != 'REVIEWED_CLOSED'
    AND (
      (b.status IN ('PENDING_OUTBOUND', 'IN_TRANSIT') AND ba.source_name = ?)
      OR (b.status IN ('PENDING_SIGN', 'SIGNED') AND ba.target_name = ?)
      OR (b.status = 'FROZEN' AND (ba.source_name = ? OR ba.target_name = ?))
    )
  `).all(location, location, location, location);
}

function updateCheckStatus(checkNo, fields, rawFields) {
  const sets = [];
  const params = [];
  for (const [k, v] of Object.entries(fields)) {
    sets.push(`${k} = ?`);
    params.push(v);
  }
  if (rawFields) {
    for (const [k, v] of Object.entries(rawFields)) {
      sets.push(`${k} = ${v}`);
    }
  }
  sets.push("updated_at = datetime('now', 'localtime')");
  params.push(checkNo);
  return db.prepare(`UPDATE inventory_checks SET ${sets.join(', ')} WHERE check_no = ?`).run(...params);
}

function deleteCheckDiffs(checkId) {
  return db.prepare('DELETE FROM inventory_check_diffs WHERE check_id = ?').run(checkId);
}

function insertDiff(diff) {
  return db.prepare(`
    INSERT INTO inventory_check_diffs (check_id, box_no, diff_type, batch_no, expected_status, actual_status, expected_location, actual_location, details)
    VALUES (@check_id, @box_no, @diff_type, @batch_no, @expected_status, @actual_status, @expected_location, @actual_location, @details)
  `).run(diff);
}

function getCheckDiffs(checkId) {
  return db.prepare('SELECT * FROM inventory_check_diffs WHERE check_id = ? ORDER BY id').all(checkId);
}

function insertConfirmation(checkId, operator, operatorRole, opinion) {
  return db.prepare(`
    INSERT INTO inventory_check_confirmations (check_id, operator, operator_role, opinion)
    VALUES (?, ?, ?, ?)
  `).run(checkId, operator, operatorRole, opinion || null);
}

function getConfirmations(checkId) {
  return db.prepare('SELECT * FROM inventory_check_confirmations WHERE check_id = ? ORDER BY id').all(checkId);
}

function getLatestConfirmation(checkId) {
  return db.prepare('SELECT * FROM inventory_check_confirmations WHERE check_id = ? ORDER BY id DESC LIMIT 1').get(checkId);
}

function getFullCheck(checkNo) {
  const check = findCheckByNo(checkNo);
  if (!check) return null;
  return {
    ...check,
    items: getCheckItems(check.id),
    diffs: getCheckDiffs(check.id),
    confirmations: getConfirmations(check.id)
  };
}

module.exports = {
  insertCheck,
  findCheckByNo,
  findCheckById,
  listChecks,
  getCheckItems,
  deleteCheckItems,
  insertCheckItem,
  findCheckItem,
  findSystemBox,
  findExpectedBoxesAtLocation,
  updateCheckStatus,
  deleteCheckDiffs,
  insertDiff,
  getCheckDiffs,
  insertConfirmation,
  getConfirmations,
  getLatestConfirmation,
  getFullCheck
};
