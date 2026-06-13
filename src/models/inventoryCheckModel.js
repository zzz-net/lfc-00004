const db = require('./db');
const { addAuditLog, STATUS } = require('./dataModel');

const CHECK_STATUS = {
  DRAFT: 'DRAFT',
  SUBMITTED: 'SUBMITTED',
  CONFIRMED: 'CONFIRMED'
};

const CHECK_STATUS_LABELS = {
  [CHECK_STATUS.DRAFT]: '草稿',
  [CHECK_STATUS.SUBMITTED]: '已提交',
  [CHECK_STATUS.CONFIRMED]: '已确认'
};

const DIFF_TYPE = {
  EXTRA_SCAN: 'EXTRA_SCAN',
  MISSING_SCAN: 'MISSING_SCAN',
  STATUS_MISMATCH: 'STATUS_MISMATCH',
  LOCATION_MISMATCH: 'LOCATION_MISMATCH'
};

const DIFF_TYPE_LABELS = {
  [DIFF_TYPE.EXTRA_SCAN]: '多扫',
  [DIFF_TYPE.MISSING_SCAN]: '漏扫',
  [DIFF_TYPE.STATUS_MISMATCH]: '状态不匹配',
  [DIFF_TYPE.LOCATION_MISMATCH]: '库位不一致'
};

function createCheck(checkNo, location, operator) {
  const existing = db.prepare('SELECT id FROM inventory_checks WHERE check_no = ?').get(checkNo);
  if (existing) {
    return { error: { code: 'DUPLICATE_CHECK_NO', message: `盘点单号 ${checkNo} 已存在` } };
  }

  const result = db.prepare(`
    INSERT INTO inventory_checks (check_no, location, status, created_by)
    VALUES (?, ?, '${CHECK_STATUS.DRAFT}', ?)
  `).run(checkNo, location, operator);

  addAuditLog({
    batch_no: checkNo,
    box_no: null,
    action: 'INVENTORY_CHECK_CREATE',
    old_status: null,
    new_status: CHECK_STATUS.DRAFT,
    operator,
    operator_role: 'staff',
    details: `创建盘点单，库位：${location}`,
    evidence: null
  });

  return { check_no: checkNo, id: result.lastInsertRowid, status: CHECK_STATUS.DRAFT };
}

function getCheckByNo(checkNo) {
  const check = db.prepare('SELECT * FROM inventory_checks WHERE check_no = ?').get(checkNo);
  if (!check) return null;
  const items = db.prepare('SELECT * FROM inventory_check_items WHERE check_id = ? ORDER BY id').all(check.id);
  const diffs = db.prepare('SELECT * FROM inventory_check_diffs WHERE check_id = ? ORDER BY id').all(check.id);
  const confirmations = db.prepare('SELECT * FROM inventory_check_confirmations WHERE check_id = ? ORDER BY id').all(check.id);
  return { ...check, items, diffs, confirmations };
}

function getCheckById(id) {
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

function addCheckItems(checkNo, items, operator, mode) {
  const check = db.prepare('SELECT * FROM inventory_checks WHERE check_no = ?').get(checkNo);
  if (!check) {
    return { error: { code: 'CHECK_NOT_FOUND', message: `盘点单 ${checkNo} 不存在` } };
  }

  if (check.status !== CHECK_STATUS.DRAFT) {
    return { error: { code: 'CHECK_NOT_DRAFT', message: `盘点单 ${checkNo} 当前状态为 ${CHECK_STATUS_LABELS[check.status]}，仅草稿状态可修改` } };
  }

  const seenInRequest = new Set();
  for (const item of items) {
    if (!item.box_no) {
      return { error: { code: 'MISSING_BOX_NO', message: '扫描明细中缺少 box_no' } };
    }
    if (seenInRequest.has(item.box_no)) {
      return { error: { code: 'DUPLICATE_BOX_IN_REQUEST', message: `请求中箱号 ${item.box_no} 重复` } };
    }
    seenInRequest.add(item.box_no);
  }

  const boxCheckStmt = db.prepare(`
    SELECT b.status, ba.batch_no
    FROM boxes b
    JOIN batches ba ON b.batch_id = ba.id
    WHERE b.box_no = ?
    ORDER BY b.id DESC LIMIT 1
  `);

  for (const item of items) {
    const systemBox = boxCheckStmt.get(item.box_no);
    if (systemBox) {
      if (systemBox.status === STATUS.REVIEWED_CLOSED) {
        return { error: { code: 'BOX_CLOSED', message: `箱号 ${item.box_no} 已复核关闭，不可盘点` } };
      }
      if (systemBox.status === STATUS.FROZEN) {
        return { error: { code: 'BOX_FROZEN', message: `箱号 ${item.box_no} 处于异常冻结状态，不可盘点` } };
      }
    }
  }

  const insertItem = db.prepare(`
    INSERT INTO inventory_check_items (check_id, box_no, operator)
    VALUES (?, ?, ?)
  `);

  const deleteItems = db.prepare('DELETE FROM inventory_check_items WHERE check_id = ?');
  const existingItemCheck = db.prepare('SELECT id FROM inventory_check_items WHERE check_id = ? AND box_no = ?');

  const tx = db.transaction(() => {
    if (mode === 'overwrite') {
      deleteItems.run(check.id);
    }

    for (const item of items) {
      if (mode === 'append') {
        const existing = existingItemCheck.get(check.id, item.box_no);
        if (existing) {
          throw { _duplicateBoxInCheck: item.box_no };
        }
      }
      insertItem.run(check.id, item.box_no, operator);
    }
  });

  try {
    tx();
  } catch (e) {
    if (e && e._duplicateBoxInCheck) {
      return { error: { code: 'DUPLICATE_BOX_IN_CHECK', message: `箱号 ${e._duplicateBoxInCheck} 在此盘点单中已存在` } };
    }
    throw e;
  }

  addAuditLog({
    batch_no: checkNo,
    box_no: null,
    action: 'INVENTORY_CHECK_ADD_ITEMS',
    old_status: check.status,
    new_status: check.status,
    operator,
    operator_role: 'staff',
    details: `${mode === 'overwrite' ? '覆盖' : '追加'}扫描明细，共 ${items.length} 箱`,
    evidence: null
  });

  const updatedItems = db.prepare('SELECT * FROM inventory_check_items WHERE check_id = ? ORDER BY id').all(check.id);
  return { check_no: checkNo, items: updatedItems, total: updatedItems.length };
}

function computeDiffs(checkId, location) {
  const items = db.prepare('SELECT * FROM inventory_check_items WHERE check_id = ? ORDER BY id').all(checkId);
  const scannedBoxNos = new Set(items.map(i => i.box_no));

  const expectedBoxes = db.prepare(`
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

  const diffs = [];

  for (const box of expectedBoxes) {
    if (!scannedBoxNos.has(box.box_no)) {
      diffs.push({
        check_id: checkId,
        box_no: box.box_no,
        diff_type: DIFF_TYPE.MISSING_SCAN,
        batch_no: box.batch_no,
        expected_status: box.status,
        actual_status: null,
        expected_location: location,
        actual_location: null,
        details: `箱号 ${box.box_no} 系统记录应在 ${location}（状态 ${box.status}），但未扫描到`
      });
    }
  }

  const systemBoxStmt = db.prepare(`
    SELECT b.box_no, b.status, ba.batch_no, ba.source_name, ba.target_name, ba.outbound_time
    FROM boxes b
    JOIN batches ba ON b.batch_id = ba.id
    WHERE b.box_no = ?
    ORDER BY b.id DESC LIMIT 1
  `);

  for (const item of items) {
    const systemBox = systemBoxStmt.get(item.box_no);

    if (!systemBox) {
      diffs.push({
        check_id: checkId,
        box_no: item.box_no,
        diff_type: DIFF_TYPE.EXTRA_SCAN,
        batch_no: null,
        expected_status: null,
        actual_status: null,
        expected_location: null,
        actual_location: location,
        details: `箱号 ${item.box_no} 不在系统中`
      });
      continue;
    }

    if (systemBox.status === STATUS.REVIEWED_CLOSED) {
      continue;
    }

    const involvesLocation = systemBox.source_name === location || systemBox.target_name === location;

    if (!involvesLocation) {
      let expectedLoc = systemBox.target_name;
      if (['PENDING_OUTBOUND', 'IN_TRANSIT'].includes(systemBox.status)) {
        expectedLoc = systemBox.source_name;
      }
      diffs.push({
        check_id: checkId,
        box_no: item.box_no,
        diff_type: DIFF_TYPE.LOCATION_MISMATCH,
        batch_no: systemBox.batch_no,
        expected_status: systemBox.status,
        actual_status: null,
        expected_location: expectedLoc,
        actual_location: location,
        details: `箱号 ${item.box_no} 系统记录应在 ${expectedLoc}（状态 ${systemBox.status}），实际扫描在 ${location}`
      });
      continue;
    }

    const expectedStatusesAtSource = [STATUS.PENDING_OUTBOUND, STATUS.IN_TRANSIT];
    const expectedStatusesAtTarget = [STATUS.PENDING_SIGN, STATUS.SIGNED];

    let isStatusMismatch = false;
    if (systemBox.source_name === location && systemBox.target_name !== location) {
      if (!expectedStatusesAtSource.includes(systemBox.status)) {
        isStatusMismatch = true;
      }
    }
    if (systemBox.target_name === location && systemBox.source_name !== location) {
      if (!expectedStatusesAtTarget.includes(systemBox.status)) {
        isStatusMismatch = true;
      }
    }

    if (isStatusMismatch) {
      diffs.push({
        check_id: checkId,
        box_no: item.box_no,
        diff_type: DIFF_TYPE.STATUS_MISMATCH,
        batch_no: systemBox.batch_no,
        expected_status: systemBox.status,
        actual_status: null,
        expected_location: location,
        actual_location: location,
        details: `箱号 ${item.box_no} 在 ${location} 但状态 ${systemBox.status} 异常`
      });
    }
  }

  return diffs;
}

function submitCheck(checkNo, operator, operatorRole) {
  const check = db.prepare('SELECT * FROM inventory_checks WHERE check_no = ?').get(checkNo);
  if (!check) {
    return { error: { code: 'CHECK_NOT_FOUND', message: `盘点单 ${checkNo} 不存在` } };
  }

  if (check.status === CHECK_STATUS.SUBMITTED) {
    return { error: { code: 'CHECK_ALREADY_SUBMITTED', message: `盘点单 ${checkNo} 已提交，不可重复提交` } };
  }

  if (check.status === CHECK_STATUS.CONFIRMED) {
    return { error: { code: 'CHECK_ALREADY_CONFIRMED', message: `盘点单 ${checkNo} 已确认，不可提交` } };
  }

  if (check.status !== CHECK_STATUS.DRAFT) {
    return { error: { code: 'INVALID_CHECK_STATUS', message: `盘点单 ${checkNo} 当前状态为 ${CHECK_STATUS_LABELS[check.status]}，仅草稿状态可提交` } };
  }

  const items = db.prepare('SELECT * FROM inventory_check_items WHERE check_id = ?').all(check.id);
  if (items.length === 0) {
    return { error: { code: 'EMPTY_CHECK_ITEMS', message: '盘点单没有扫描明细，无法提交' } };
  }

  const diffs = computeDiffs(check.id, check.location);

  const insertDiff = db.prepare(`
    INSERT INTO inventory_check_diffs (check_id, box_no, diff_type, batch_no, expected_status, actual_status, expected_location, actual_location, details)
    VALUES (@check_id, @box_no, @diff_type, @batch_no, @expected_status, @actual_status, @expected_location, @actual_location, @details)
  `);

  const tx = db.transaction(() => {
    db.prepare(`
      UPDATE inventory_checks SET
        status = ?,
        submitted_by = ?,
        submitted_at = datetime('now', 'localtime'),
        updated_at = datetime('now', 'localtime')
      WHERE check_no = ?
    `).run(CHECK_STATUS.SUBMITTED, operator, checkNo);

    db.prepare('DELETE FROM inventory_check_diffs WHERE check_id = ?').run(check.id);

    for (const diff of diffs) {
      insertDiff.run(diff);
    }

    addAuditLog({
      batch_no: checkNo,
      box_no: null,
      action: 'INVENTORY_CHECK_SUBMIT',
      old_status: CHECK_STATUS.DRAFT,
      new_status: CHECK_STATUS.SUBMITTED,
      operator,
      operator_role: operatorRole,
      details: `提交盘点单，共 ${items.length} 条扫描明细，${diffs.length} 条差异`,
      evidence: null
    });
  });

  tx();

  const updatedDiffs = db.prepare('SELECT * FROM inventory_check_diffs WHERE check_id = ? ORDER BY id').all(check.id);
  return {
    check_no: checkNo,
    new_status: CHECK_STATUS.SUBMITTED,
    diffs: updatedDiffs,
    diffs_count: updatedDiffs.length
  };
}

function confirmCheck(checkNo, operator, operatorRole, opinion) {
  if (operatorRole !== 'supervisor') {
    return { error: { code: 'PERMISSION_DENIED', message: '只有主管角色可以确认盘点差异处理' } };
  }

  const check = db.prepare('SELECT * FROM inventory_checks WHERE check_no = ?').get(checkNo);
  if (!check) {
    return { error: { code: 'CHECK_NOT_FOUND', message: `盘点单 ${checkNo} 不存在` } };
  }

  if (check.status === CHECK_STATUS.DRAFT) {
    return { error: { code: 'CHECK_NOT_SUBMITTED', message: `盘点单 ${checkNo} 尚未提交，无法确认` } };
  }

  if (check.status === CHECK_STATUS.CONFIRMED) {
    return { error: { code: 'CHECK_ALREADY_CONFIRMED', message: `盘点单 ${checkNo} 已确认，不可重复确认` } };
  }

  if (check.status !== CHECK_STATUS.SUBMITTED) {
    return { error: { code: 'INVALID_CHECK_STATUS', message: `盘点单 ${checkNo} 当前状态为 ${CHECK_STATUS_LABELS[check.status]}，仅已提交状态可确认` } };
  }

  const tx = db.transaction(() => {
    db.prepare(`
      UPDATE inventory_checks SET
        status = ?,
        confirmed_by = ?,
        confirmed_at = datetime('now', 'localtime'),
        updated_at = datetime('now', 'localtime')
      WHERE check_no = ?
    `).run(CHECK_STATUS.CONFIRMED, operator, checkNo);

    db.prepare(`
      INSERT INTO inventory_check_confirmations (check_id, operator, operator_role, opinion)
      VALUES (?, ?, ?, ?)
    `).run(check.id, operator, operatorRole, opinion || null);

    addAuditLog({
      batch_no: checkNo,
      box_no: null,
      action: 'INVENTORY_CHECK_CONFIRM',
      old_status: CHECK_STATUS.SUBMITTED,
      new_status: CHECK_STATUS.CONFIRMED,
      operator,
      operator_role: operatorRole,
      details: opinion || '主管确认差异处理',
      evidence: null
    });
  });

  tx();

  const confirmation = db.prepare('SELECT * FROM inventory_check_confirmations WHERE check_id = ? ORDER BY id DESC LIMIT 1').get(check.id);
  return {
    check_no: checkNo,
    new_status: CHECK_STATUS.CONFIRMED,
    confirmation
  };
}

function getCheckDiffs(checkNo) {
  const check = db.prepare('SELECT * FROM inventory_checks WHERE check_no = ?').get(checkNo);
  if (!check) {
    return { error: { code: 'CHECK_NOT_FOUND', message: `盘点单 ${checkNo} 不存在` } };
  }

  const diffs = db.prepare('SELECT * FROM inventory_check_diffs WHERE check_id = ? ORDER BY id').all(check.id);

  const grouped = {
    EXTRA_SCAN: [],
    MISSING_SCAN: [],
    STATUS_MISMATCH: [],
    LOCATION_MISMATCH: []
  };

  for (const d of diffs) {
    if (grouped[d.diff_type]) {
      grouped[d.diff_type].push(d);
    }
  }

  return {
    check_no: checkNo,
    status: check.status,
    location: check.location,
    total_diffs: diffs.length,
    diffs,
    grouped
  };
}

module.exports = {
  CHECK_STATUS,
  CHECK_STATUS_LABELS,
  DIFF_TYPE,
  DIFF_TYPE_LABELS,
  createCheck,
  getCheckByNo,
  listChecks,
  addCheckItems,
  submitCheck,
  confirmCheck,
  getCheckDiffs
};
