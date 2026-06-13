const express = require('express');
const router = express.Router();
const model = require('../models/dataModel');
const { requireAuth, validateTemperature, validateSealNo, validateTimeout } = require('../middleware/validator');
const { AUDIT_ACTION } = require('../constants');

router.get('/statuses', (req, res) => {
  res.json({
    data: Object.entries(model.STATUS).map(([key, value]) => ({
      key,
      value,
      label: model.STATUS_LABELS[value]
    }))
  });
});

router.get('/configs', (req, res) => {
  res.json({ data: model.getConfigs() });
});

router.put('/configs', requireAuth, (req, res) => {
  if (req.role !== 'supervisor') {
    return res.status(403).json({
      error: { code: 'PERMISSION_DENIED', message: '只有主管可以修改配置' }
    });
  }
  const { key, value } = req.body || {};
  if (!key || value === undefined) {
    return res.status(400).json({
      error: { code: 'INVALID_PARAMS', message: '缺少 key 或 value' }
    });
  }
  const result = model.updateConfig(key, String(value));
  if (result.changes === 0) {
    return res.status(404).json({
      error: { code: 'CONFIG_NOT_FOUND', message: `配置项 ${key} 不存在` }
    });
  }
  res.json({ data: model.getConfigs() });
});

router.post('/batches/import', requireAuth, (req, res) => {
  const { batch_no, source_type, source_name, target_type, target_name, boxes } = req.body || {};

  if (!batch_no || !source_type || !source_name || !target_type || !target_name || !Array.isArray(boxes)) {
    return res.status(400).json({
      error: {
        code: 'INVALID_PARAMS',
        message: '参数不完整：需要 batch_no, source_type, source_name, target_type, target_name, boxes(数组)'
      }
    });
  }

  if (!['warehouse', 'store'].includes(source_type) || !['warehouse', 'store'].includes(target_type)) {
    return res.status(400).json({
      error: { code: 'INVALID_TYPE', message: 'source_type / target_type 只能是 warehouse 或 store' }
    });
  }

  if (boxes.length === 0) {
    return res.status(400).json({
      error: { code: 'EMPTY_BOXES', message: 'boxes 数组不能为空' }
    });
  }

  for (let i = 0; i < boxes.length; i++) {
    const box = boxes[i];
    if (!box.box_no) {
      return res.status(400).json({
        error: { code: 'MISSING_BOX_NO', message: `第 ${i + 1} 个箱子缺少 box_no` }
      });
    }
    const tempCheck = validateTemperature(box.temperature);
    if (!tempCheck.valid) {
      return res.status(400).json({
        error: { code: 'INVALID_TEMPERATURE', message: `箱号 ${box.box_no}：${tempCheck.error}` }
      });
    }
    const sealCheck = validateSealNo(box.seal_no);
    if (!sealCheck.valid) {
      return res.status(400).json({
        error: { code: 'INVALID_SEAL', message: `箱号 ${box.box_no}：${sealCheck.error}` }
      });
    }
  }

  const result = model.createBatch(
    { batch_no, source_type, source_name, target_type, target_name },
    boxes,
    req.operator
  );

  if (result.error) {
    return res.status(400).json({ error: result.error });
  }

  res.status(201).json({
    data: {
      ...result,
      status: model.STATUS.PENDING_OUTBOUND,
      status_label: model.STATUS_LABELS[model.STATUS.PENDING_OUTBOUND]
    }
  });
});

router.get('/batches', (req, res) => {
  const { batch_no, status, keyword } = req.query;
  const list = model.searchBatches({ batch_no, status, keyword }).map(b => ({
    ...b,
    status_label: model.STATUS_LABELS[b.status]
  }));
  res.json({ data: list, total: list.length });
});

router.get('/batches/:batch_no', (req, res) => {
  const data = model.getBatchByNo(req.params.batch_no);
  if (!data) {
    return res.status(404).json({
      error: { code: 'BATCH_NOT_FOUND', message: `批次 ${req.params.batch_no} 不存在` }
    });
  }
  data.status_label = model.STATUS_LABELS[data.status];
  data.boxes = (data.boxes || []).map(b => ({
    ...b,
    status_label: model.STATUS_LABELS[b.status]
  }));
  res.json({ data });
});

router.get('/boxes/:box_no', (req, res) => {
  const list = model.getBoxesByNo(req.params.box_no);
  if (list.length === 0) {
    return res.status(404).json({
      error: { code: 'BOX_NOT_FOUND', message: `箱号 ${req.params.box_no} 不存在` }
    });
  }
  const data = list.map(b => ({
    ...b,
    status_label: model.STATUS_LABELS[b.status]
  }));
  res.json({ data, total: data.length });
});

router.post('/batches/:batch_no/outbound', requireAuth, (req, res) => {
  const { batch_no } = req.params;
  const batch = model.getBatchByNo(batch_no);
  if (!batch) {
    return res.status(404).json({
      error: { code: 'BATCH_NOT_FOUND', message: `批次 ${batch_no} 不存在` }
    });
  }

  const result = model.updateBatchStatus(
    batch_no,
    model.STATUS.PENDING_SIGN,
    {
      outbound_operator: req.operator,
      outbound_time: new Date().toISOString()
    },
    {
      action: AUDIT_ACTION.OUTBOUND,
      operator: req.operator,
      operator_role: req.role,
      details: `由 ${req.operator} 执行出库`
    }
  );

  if (result.error) {
    return res.status(400).json({ error: result.error });
  }

  res.json({
    data: {
      ...result,
      status_label: model.STATUS_LABELS[result.new_status]
    }
  });
});

router.post('/batches/:batch_no/sign', requireAuth, (req, res) => {
  const { batch_no } = req.params;
  const { boxes_sign } = req.body || {};
  const batch = model.getBatchByNo(batch_no);

  if (!batch) {
    return res.status(404).json({
      error: { code: 'BATCH_NOT_FOUND', message: `批次 ${batch_no} 不存在` }
    });
  }

  if (batch.status !== model.STATUS.PENDING_SIGN) {
    return res.status(400).json({
      error: {
        code: 'INVALID_STATUS',
        message: `批次当前状态为 ${model.STATUS_LABELS[batch.status]}，不能签收（仅待签收状态可签收）`
      }
    });
  }

  if (batch.outbound_time) {
    const timeoutCheck = validateTimeout(batch.outbound_time);
    if (!timeoutCheck.valid) {
      return res.status(400).json({
        error: { code: 'TIMEOUT', message: timeoutCheck.error }
      });
    }
  }

  if (!Array.isArray(boxes_sign) || boxes_sign.length === 0) {
    return res.status(400).json({
      error: { code: 'INVALID_PARAMS', message: '缺少 boxes_sign 数组' }
    });
  }

  const signedBoxes = new Map();
  for (const s of boxes_sign) {
    if (!s.box_no) {
      return res.status(400).json({
        error: { code: 'MISSING_BOX_NO', message: '签收明细缺少 box_no' }
      });
    }
    if (signedBoxes.has(s.box_no)) {
      return res.status(400).json({
        error: { code: 'DUPLICATE_SIGN', message: `箱号 ${s.box_no} 重复签收` }
      });
    }
    signedBoxes.set(s.box_no, s);

    const tempCheck = validateTemperature(s.sign_temperature);
    if (!tempCheck.valid) {
      return res.status(400).json({
        error: { code: 'INVALID_TEMPERATURE', message: `箱号 ${s.box_no}：${tempCheck.error}` }
      });
    }
    const sealCheck = validateSealNo(s.sign_seal_no);
    if (!sealCheck.valid) {
      return res.status(400).json({
        error: { code: 'INVALID_SEAL', message: `箱号 ${s.box_no}：${sealCheck.error}` }
      });
    }
  }

  for (const box of batch.boxes) {
    if (box.status === model.STATUS.FROZEN) {
      return res.status(400).json({
        error: {
          code: 'BOX_FROZEN',
          message: `箱号 ${box.box_no} 处于异常冻结状态，需主管复核关闭后方可继续处理，当前批次不可签收`
        }
      });
    }
    if (box.status === model.STATUS.SIGNED) {
      return res.status(400).json({
        error: { code: 'DUPLICATE_SIGN', message: `箱号 ${box.box_no} 已签收，不可重复签收` }
      });
    }
    if (!signedBoxes.has(box.box_no)) {
      return res.status(400).json({
        error: { code: 'MISSING_BOX_SIGN', message: `箱号 ${box.box_no} 未在签收明细中` }
      });
    }
  }

  const db = require('../models/db');
  const tx = db.transaction(() => {
    for (const box of batch.boxes) {
      const s = signedBoxes.get(box.box_no);
      db.prepare(`
        UPDATE boxes SET
          status = ?,
          sign_operator = ?,
          sign_time = datetime('now', 'localtime'),
          sign_temperature = ?,
          sign_seal_no = ?,
          updated_at = datetime('now', 'localtime')
        WHERE id = ?
      `).run(model.STATUS.SIGNED, req.operator,
        s.sign_temperature !== undefined ? s.sign_temperature : null,
        s.sign_seal_no || null,
        box.id);

      model.addAuditLog({
        batch_no,
        box_no: box.box_no,
        action: AUDIT_ACTION.SIGN,
        old_status: box.status,
        new_status: model.STATUS.SIGNED,
        operator: req.operator,
        operator_role: req.role,
        details: `签收：温度 ${s.sign_temperature ?? 'N/A'}，封签 ${s.sign_seal_no ?? 'N/A'}`,
        evidence: null
      });
    }

    db.prepare(`
      UPDATE batches SET
        status = ?,
        sign_operator = ?,
        sign_time = datetime('now', 'localtime'),
        updated_at = datetime('now', 'localtime')
      WHERE batch_no = ?
    `).run(model.STATUS.SIGNED, req.operator, batch_no);

    model.addAuditLog({
      batch_no,
      box_no: null,
      action: 'SIGN',
      old_status: batch.status,
      new_status: model.STATUS.SIGNED,
      operator: req.operator,
      operator_role: req.role,
      details: `批次全部签收完成，共 ${batch.boxes.length} 箱`,
      evidence: null
    });
  });

  tx();

  res.json({
    data: {
      batch_no,
      new_status: model.STATUS.SIGNED,
      status_label: model.STATUS_LABELS[model.STATUS.SIGNED]
    }
  });
});

router.post('/batches/:batch_no/freeze', requireAuth, (req, res) => {
  const { batch_no } = req.params;
  const { reason, evidence, box_no } = req.body || {};

  if (!reason || !reason.trim()) {
    return res.status(400).json({
      error: { code: 'MISSING_REASON', message: '必须提供异常原因 reason' }
    });
  }

  let result;
  if (box_no) {
    result = model.freezeBox(batch_no, box_no, reason, evidence, req.operator, req.role);
  } else {
    result = model.freezeBatch(batch_no, reason, evidence, req.operator, req.role);
  }

  if (result.error) {
    return res.status(400).json({ error: result.error });
  }

  res.json({
    data: {
      ...result,
      status_label: model.STATUS_LABELS[model.STATUS.FROZEN]
    }
  });
});

router.post('/batches/:batch_no/review-close', requireAuth, (req, res) => {
  const { batch_no } = req.params;
  const { opinion, box_no } = req.body || {};

  const result = model.reviewClose(batch_no, opinion, req.operator, req.role, box_no);

  if (result.error) {
    return res.status(400).json({ error: result.error });
  }

  res.json({
    data: {
      ...result,
      status_label: model.STATUS_LABELS[model.STATUS.REVIEWED_CLOSED]
    }
  });
});

router.get('/audit-logs', (req, res) => {
  const { batch_no, box_no } = req.query;
  const list = model.getAuditLogs(batch_no, box_no);
  const data = list.map(l => ({
    ...l,
    old_status_label: l.old_status ? model.STATUS_LABELS[l.old_status] : null,
    new_status_label: l.new_status ? model.STATUS_LABELS[l.new_status] : null
  }));
  res.json({ data, total: data.length });
});

module.exports = router;
