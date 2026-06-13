const db = require('./db');
const { BOX_STATUS: STATUS, BOX_STATUS_LABELS: STATUS_LABELS, AUDIT_ACTION } = require('../constants');

const STATUS_TRANSITIONS = {
  [STATUS.PENDING_OUTBOUND]: [STATUS.IN_TRANSIT, STATUS.PENDING_SIGN, STATUS.FROZEN],
  [STATUS.IN_TRANSIT]: [STATUS.PENDING_SIGN, STATUS.FROZEN],
  [STATUS.PENDING_SIGN]: [STATUS.SIGNED, STATUS.FROZEN],
  [STATUS.SIGNED]: [STATUS.REVIEWED_CLOSED],
  [STATUS.FROZEN]: [STATUS.REVIEWED_CLOSED, STATUS.PENDING_OUTBOUND, STATUS.IN_TRANSIT, STATUS.PENDING_SIGN, STATUS.SIGNED],
  [STATUS.REVIEWED_CLOSED]: []
};

function isValidStatusTransition(current, next) {
  const allowed = STATUS_TRANSITIONS[current] || [];
  return allowed.includes(next);
}

function getConfigs() {
  const rows = db.prepare('SELECT key, value, description FROM configs').all();
  const result = {};
  for (const r of rows) {
    result[r.key] = { value: r.value, description: r.description };
  }
  return result;
}

function updateConfig(key, value) {
  return db.prepare('UPDATE configs SET value = ?, updated_at = datetime("now", "localtime") WHERE key = ?').run(value, key);
}

function addAuditLog(entry) {
  return db.prepare(`
    INSERT INTO audit_logs (batch_no, box_no, action, old_status, new_status, operator, operator_role, details, evidence)
    VALUES (@batch_no, @box_no, @action, @old_status, @new_status, @operator, @operator_role, @details, @evidence)
  `).run(entry);
}

function getAuditLogs(batchNo, boxNo) {
  let sql = 'SELECT * FROM audit_logs WHERE 1=1';
  const params = [];
  if (batchNo) {
    sql += ' AND batch_no = ?';
    params.push(batchNo);
  }
  if (boxNo) {
    sql += ' AND box_no = ?';
    params.push(boxNo);
  }
  sql += ' ORDER BY id ASC';
  return db.prepare(sql).all(...params);
}

function getBatchByNo(batchNo) {
  const batch = db.prepare('SELECT * FROM batches WHERE batch_no = ?').get(batchNo);
  if (!batch) return null;
  const boxes = db.prepare('SELECT * FROM boxes WHERE batch_id = ? ORDER BY id').all(batch.id);
  return { ...batch, boxes };
}

function getBoxesByNo(boxNo) {
  return db.prepare(`
    SELECT b.*, ba.batch_no, ba.source_name, ba.target_name
    FROM boxes b
    JOIN batches ba ON b.batch_id = ba.id
    WHERE b.box_no = ?
    ORDER BY b.id DESC
  `).all(boxNo);
}

function searchBatches({ batch_no, status, keyword }) {
  let sql = 'SELECT * FROM batches WHERE 1=1';
  const params = [];
  if (batch_no) {
    sql += ' AND batch_no LIKE ?';
    params.push(`%${batch_no}%`);
  }
  if (status) {
    sql += ' AND status = ?';
    params.push(status);
  }
  if (keyword) {
    sql += ' AND (batch_no LIKE ? OR source_name LIKE ? OR target_name LIKE ?)';
    params.push(`%${keyword}%`, `%${keyword}%`, `%${keyword}%`);
  }
  sql += ' ORDER BY id DESC';
  return db.prepare(sql).all(...params);
}

function createBatch(batchData, boxes, operator) {
  const existing = db.prepare('SELECT id FROM batches WHERE batch_no = ?').get(batchData.batch_no);
  if (existing) {
    return { error: { code: 'DUPLICATE_BATCH', message: `批次号 ${batchData.batch_no} 已存在` } };
  }

  const insertBatch = db.prepare(`
    INSERT INTO batches (batch_no, source_type, source_name, target_type, target_name, status, created_by)
    VALUES (@batch_no, @source_type, @source_name, @target_type, @target_name, '${STATUS.PENDING_OUTBOUND}', @created_by)
  `);

  const insertBox = db.prepare(`
    INSERT INTO boxes (box_no, batch_id, temperature, seal_no, product_name, weight, status)
    VALUES (@box_no, @batch_id, @temperature, @seal_no, @product_name, @weight, '${STATUS.PENDING_OUTBOUND}')
  `);

  const existingBoxCheck = db.prepare('SELECT box_no FROM boxes WHERE box_no = ?');

  let batchId = null;

  const tx = db.transaction(() => {
    const result = insertBatch.run({ ...batchData, created_by: operator });
    batchId = result.lastInsertRowid;

    for (const box of boxes) {
      const dup = existingBoxCheck.get(box.box_no);
      if (dup) {
        throw { _duplicateBox: box.box_no };
      }
      insertBox.run({
        ...box,
        batch_id: batchId,
        temperature: box.temperature !== undefined ? box.temperature : null,
        seal_no: box.seal_no || null,
        product_name: box.product_name || null,
        weight: box.weight !== undefined ? box.weight : null
      });
    }

    addAuditLog({
      batch_no: batchData.batch_no,
      box_no: null,
      action: AUDIT_ACTION.IMPORT,
      old_status: null,
      new_status: STATUS.PENDING_OUTBOUND,
      operator,
      operator_role: 'staff',
      details: `导入箱单，共 ${boxes.length} 箱`,
      evidence: null
    });
  });

  try {
    tx();
  } catch (e) {
    if (e && e._duplicateBox) {
      return { error: { code: 'DUPLICATE_BOX', message: `箱号 ${e._duplicateBox} 已存在` } };
    }
    throw e;
  }

  return { batch_no: batchData.batch_no, batch_id: batchId, boxes_count: boxes.length };
}

function updateBatchStatus(batchNo, newStatus, updateData, auditEntry) {
  const batch = db.prepare('SELECT * FROM batches WHERE batch_no = ?').get(batchNo);
  if (!batch) {
    return { error: { code: 'BATCH_NOT_FOUND', message: `批次 ${batchNo} 不存在` } };
  }

  if (!isValidStatusTransition(batch.status, newStatus)) {
    return { error: {
      code: 'INVALID_STATUS_TRANSITION',
      message: `无法从 ${STATUS_LABELS[batch.status]} 流转到 ${STATUS_LABELS[newStatus]}`
    } };
  }

  const tx = db.transaction(() => {
    const fields = [];
    const params = [];
    for (const [k, v] of Object.entries(updateData)) {
      fields.push(`${k} = ?`);
      params.push(v);
    }
    fields.push("status = ?");
    params.push(newStatus);
    fields.push("updated_at = datetime('now', 'localtime')");
    params.push(batchNo);

    db.prepare(`UPDATE batches SET ${fields.join(', ')} WHERE batch_no = ?`).run(...params);
    db.prepare(`UPDATE boxes SET status = ?, updated_at = datetime('now', 'localtime') WHERE batch_id = ?`).run(newStatus, batch.id);

    addAuditLog({
      batch_no: batchNo,
      box_no: null,
      action: auditEntry.action,
      old_status: batch.status,
      new_status: newStatus,
      operator: auditEntry.operator,
      operator_role: auditEntry.operator_role,
      details: auditEntry.details || null,
      evidence: auditEntry.evidence || null
    });
  });

  tx();
  return { batch_no: batchNo, new_status: newStatus };
}

function freezeBox(batchNo, boxNo, reason, evidence, operator, operatorRole) {
  const batch = db.prepare('SELECT * FROM batches WHERE batch_no = ?').get(batchNo);
  if (!batch) {
    return { error: { code: 'BATCH_NOT_FOUND', message: `批次 ${batchNo} 不存在` } };
  }

  const box = db.prepare('SELECT * FROM boxes WHERE box_no = ? AND batch_id = ?').get(boxNo, batch.id);
  if (!box) {
    return { error: { code: 'BOX_NOT_FOUND', message: `箱号 ${boxNo} 在批次中不存在` } };
  }

  if (box.status === STATUS.FROZEN) {
    return { error: { code: 'ALREADY_FROZEN', message: `箱号 ${boxNo} 已处于异常冻结状态` } };
  }

  if (box.status === STATUS.REVIEWED_CLOSED) {
    return { error: { code: 'ALREADY_CLOSED', message: `箱号 ${boxNo} 已复核关闭，无法再冻结` } };
  }

  const tx = db.transaction(() => {
    db.prepare(`
      UPDATE boxes SET
        status = ?,
        freeze_reason = ?,
        freeze_operator = ?,
        freeze_time = datetime('now', 'localtime'),
        freeze_evidence = ?,
        updated_at = datetime('now', 'localtime')
      WHERE box_no = ? AND batch_id = ?
    `).run(STATUS.FROZEN, reason, operator, evidence, boxNo, batch.id);

    addAuditLog({
      batch_no: batchNo,
      box_no: boxNo,
      action: AUDIT_ACTION.FREEZE,
      old_status: box.status,
      new_status: STATUS.FROZEN,
      operator,
      operator_role: operatorRole,
      details: reason,
      evidence: evidence || null
    });
  });

  tx();
  return { batch_no: batchNo, box_no: boxNo, new_status: STATUS.FROZEN };
}

function freezeBatch(batchNo, reason, evidence, operator, operatorRole) {
  const batch = db.prepare('SELECT * FROM batches WHERE batch_no = ?').get(batchNo);
  if (!batch) {
    return { error: { code: 'BATCH_NOT_FOUND', message: `批次 ${batchNo} 不存在` } };
  }

  if (batch.status === STATUS.FROZEN) {
    return { error: { code: 'ALREADY_FROZEN', message: `批次 ${batchNo} 已处于异常冻结状态` } };
  }

  if (batch.status === STATUS.REVIEWED_CLOSED) {
    return { error: { code: 'ALREADY_CLOSED', message: `批次 ${batchNo} 已复核关闭，无法再冻结` } };
  }

  const tx = db.transaction(() => {
    db.prepare(`
      UPDATE batches SET
        status = ?,
        freeze_reason = ?,
        freeze_operator = ?,
        freeze_time = datetime('now', 'localtime'),
        freeze_evidence = ?,
        updated_at = datetime('now', 'localtime')
      WHERE batch_no = ?
    `).run(STATUS.FROZEN, reason, operator, evidence, batchNo);

    db.prepare(`
      UPDATE boxes SET
        status = ?,
        freeze_reason = ?,
        freeze_operator = ?,
        freeze_time = datetime('now', 'localtime'),
        freeze_evidence = ?,
        updated_at = datetime('now', 'localtime')
      WHERE batch_id = ? AND status != ?
    `).run(STATUS.FROZEN, reason, operator, evidence, batch.id, STATUS.REVIEWED_CLOSED);

    addAuditLog({
      batch_no: batchNo,
      box_no: null,
      action: AUDIT_ACTION.FREEZE,
      old_status: batch.status,
      new_status: STATUS.FROZEN,
      operator,
      operator_role: operatorRole,
      details: reason,
      evidence: evidence || null
    });
  });

  tx();
  return { batch_no: batchNo, new_status: STATUS.FROZEN };
}

function reviewClose(batchNo, opinion, operator, operatorRole, boxNo = null) {
  if (operatorRole !== 'supervisor') {
    return { error: { code: 'PERMISSION_DENIED', message: '只有主管角色可以执行复核关闭操作' } };
  }

  const batch = db.prepare('SELECT * FROM batches WHERE batch_no = ?').get(batchNo);
  if (!batch) {
    return { error: { code: 'BATCH_NOT_FOUND', message: `批次 ${batchNo} 不存在` } };
  }

  if (boxNo) {
    const box = db.prepare('SELECT * FROM boxes WHERE box_no = ? AND batch_id = ?').get(boxNo, batch.id);
    if (!box) {
      return { error: { code: 'BOX_NOT_FOUND', message: `箱号 ${boxNo} 在批次中不存在` } };
    }
    if (box.status !== STATUS.FROZEN) {
      return { error: { code: 'NOT_FROZEN', message: `箱号 ${boxNo} 未处于异常冻结状态，当前状态：${STATUS_LABELS[box.status]}` } };
    }

    const tx = db.transaction(() => {
      db.prepare(`
        UPDATE boxes SET
          status = ?,
          updated_at = datetime('now', 'localtime')
        WHERE box_no = ? AND batch_id = ?
      `).run(STATUS.REVIEWED_CLOSED, boxNo, batch.id);

      addAuditLog({
        batch_no: batchNo,
        box_no: boxNo,
        action: AUDIT_ACTION.REVIEW_CLOSE,
        old_status: box.status,
        new_status: STATUS.REVIEWED_CLOSED,
        operator,
        operator_role: operatorRole,
        details: opinion || null,
        evidence: null
      });
    });

    tx();
    return { batch_no: batchNo, box_no: boxNo, new_status: STATUS.REVIEWED_CLOSED, review_opinion: opinion };
  }

  if (batch.status !== STATUS.FROZEN) {
    return { error: { code: 'NOT_FROZEN', message: `批次 ${batchNo} 未处于异常冻结状态，当前状态：${STATUS_LABELS[batch.status]}` } };
  }

  const tx = db.transaction(() => {
    db.prepare(`
      UPDATE batches SET
        status = ?,
        review_opinion = ?,
        review_operator = ?,
        review_time = datetime('now', 'localtime'),
        updated_at = datetime('now', 'localtime')
      WHERE batch_no = ?
    `).run(STATUS.REVIEWED_CLOSED, opinion || null, operator, batchNo);

    db.prepare(`
      UPDATE boxes SET
        status = ?,
        updated_at = datetime('now', 'localtime')
      WHERE batch_id = ? AND status = ?
    `).run(STATUS.REVIEWED_CLOSED, batch.id, STATUS.FROZEN);

    addAuditLog({
      batch_no: batchNo,
      box_no: null,
      action: AUDIT_ACTION.REVIEW_CLOSE,
      old_status: batch.status,
      new_status: STATUS.REVIEWED_CLOSED,
      operator,
      operator_role: operatorRole,
      details: opinion || null,
      evidence: null
    });
  });

  tx();
  return { batch_no: batchNo, new_status: STATUS.REVIEWED_CLOSED, review_opinion: opinion };
}

module.exports = {
  STATUS,
  STATUS_LABELS,
  isValidStatusTransition,
  getConfigs,
  updateConfig,
  addAuditLog,
  getAuditLogs,
  getBatchByNo,
  getBoxesByNo,
  searchBatches,
  createBatch,
  updateBatchStatus,
  freezeBox,
  freezeBatch,
  reviewClose
};
