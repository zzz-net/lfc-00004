const db = require('../models/db');
const model = require('../models/inventoryCheckModel');
const { addAuditLog } = require('../models/dataModel');
const {
  BOX_STATUS,
  CHECK_STATUS,
  CHECK_STATUS_LABELS,
  DIFF_TYPE,
  AUDIT_ACTION
} = require('../constants');

function createCheck(checkNo, location, operator) {
  const existing = model.findCheckByNo(checkNo);
  if (existing) {
    return { error: { code: 'DUPLICATE_CHECK_NO', message: `盘点单号 ${checkNo} 已存在` } };
  }

  const result = model.insertCheck(checkNo, location, operator);

  addAuditLog({
    batch_no: checkNo,
    box_no: null,
    action: AUDIT_ACTION.CHECK_CREATE,
    old_status: null,
    new_status: CHECK_STATUS.DRAFT,
    operator,
    operator_role: 'staff',
    details: `创建盘点单，库位：${location}`,
    evidence: null
  });

  return { check_no: checkNo, id: result.lastInsertRowid, status: CHECK_STATUS.DRAFT };
}

function addCheckItems(checkNo, items, operator, mode) {
  const check = model.findCheckByNo(checkNo);
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

  for (const item of items) {
    const systemBox = model.findSystemBox(item.box_no);
    if (systemBox) {
      if (systemBox.status === BOX_STATUS.REVIEWED_CLOSED) {
        return { error: { code: 'BOX_CLOSED', message: `箱号 ${item.box_no} 已复核关闭，不可盘点` } };
      }
      if (systemBox.status === BOX_STATUS.FROZEN) {
        return { error: { code: 'BOX_FROZEN', message: `箱号 ${item.box_no} 处于异常冻结状态，不可盘点` } };
      }
    }
  }

  const tx = db.transaction(() => {
    if (mode === 'overwrite') {
      model.deleteCheckItems(check.id);
    }

    for (const item of items) {
      if (mode === 'append') {
        const existing = model.findCheckItem(check.id, item.box_no);
        if (existing) {
          throw { _duplicateBoxInCheck: item.box_no };
        }
      }
      model.insertCheckItem(check.id, item.box_no, operator);
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
    action: AUDIT_ACTION.CHECK_ADD_ITEMS,
    old_status: check.status,
    new_status: check.status,
    operator,
    operator_role: 'staff',
    details: `${mode === 'overwrite' ? '覆盖' : '追加'}扫描明细，共 ${items.length} 箱`,
    evidence: null
  });

  const updatedItems = model.getCheckItems(check.id);
  return { check_no: checkNo, items: updatedItems, total: updatedItems.length };
}

function computeDiffs(checkId, location) {
  const items = model.getCheckItems(checkId);
  const scannedBoxNos = new Set(items.map(i => i.box_no));
  const expectedBoxes = model.findExpectedBoxesAtLocation(location);

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

  for (const item of items) {
    const systemBox = model.findSystemBox(item.box_no);

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

    if (systemBox.status === BOX_STATUS.REVIEWED_CLOSED) {
      continue;
    }

    const involvesLocation = systemBox.source_name === location || systemBox.target_name === location;

    if (!involvesLocation) {
      let expectedLoc = systemBox.target_name;
      if ([BOX_STATUS.PENDING_OUTBOUND, BOX_STATUS.IN_TRANSIT].includes(systemBox.status)) {
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

    const expectedStatusesAtSource = [BOX_STATUS.PENDING_OUTBOUND, BOX_STATUS.IN_TRANSIT];
    const expectedStatusesAtTarget = [BOX_STATUS.PENDING_SIGN, BOX_STATUS.SIGNED];

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
  const check = model.findCheckByNo(checkNo);
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

  const items = model.getCheckItems(check.id);
  if (items.length === 0) {
    return { error: { code: 'EMPTY_CHECK_ITEMS', message: '盘点单没有扫描明细，无法提交' } };
  }

  const diffs = computeDiffs(check.id, check.location);

  const tx = db.transaction(() => {
    model.updateCheckStatus(checkNo, {
      status: CHECK_STATUS.SUBMITTED,
      submitted_by: operator
    }, {
      submitted_at: "datetime('now','localtime')"
    });

    model.deleteCheckDiffs(check.id);

    for (const diff of diffs) {
      model.insertDiff(diff);
    }

    addAuditLog({
      batch_no: checkNo,
      box_no: null,
      action: AUDIT_ACTION.CHECK_SUBMIT,
      old_status: CHECK_STATUS.DRAFT,
      new_status: CHECK_STATUS.SUBMITTED,
      operator,
      operator_role: operatorRole,
      details: `提交盘点单，共 ${items.length} 条扫描明细，${diffs.length} 条差异`,
      evidence: null
    });
  });

  tx();

  const updatedDiffs = model.getCheckDiffs(check.id);
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

  const check = model.findCheckByNo(checkNo);
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
    model.updateCheckStatus(checkNo, {
      status: CHECK_STATUS.CONFIRMED,
      confirmed_by: operator
    }, {
      confirmed_at: "datetime('now','localtime')"
    });

    model.insertConfirmation(check.id, operator, operatorRole, opinion);

    addAuditLog({
      batch_no: checkNo,
      box_no: null,
      action: AUDIT_ACTION.CHECK_CONFIRM,
      old_status: CHECK_STATUS.SUBMITTED,
      new_status: CHECK_STATUS.CONFIRMED,
      operator,
      operator_role: operatorRole,
      details: opinion || '主管确认差异处理',
      evidence: null
    });
  });

  tx();

  const confirmation = model.getLatestConfirmation(check.id);
  return {
    check_no: checkNo,
    new_status: CHECK_STATUS.CONFIRMED,
    confirmation
  };
}

function getCheckDiffs(checkNo) {
  const check = model.findCheckByNo(checkNo);
  if (!check) {
    return { error: { code: 'CHECK_NOT_FOUND', message: `盘点单 ${checkNo} 不存在` } };
  }

  const diffs = model.getCheckDiffs(check.id);

  const grouped = {};
  for (const key of Object.values(DIFF_TYPE)) {
    grouped[key] = [];
  }
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
  createCheck,
  addCheckItems,
  submitCheck,
  confirmCheck,
  getCheckDiffs
};
