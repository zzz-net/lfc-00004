const express = require('express');
const router = express.Router();
const model = require('../models/inventoryCheckModel');
const { requireAuth } = require('../middleware/validator');

router.post('/inventory-checks', requireAuth, (req, res) => {
  const { check_no, location } = req.body || {};

  if (!check_no || !location) {
    return res.status(400).json({
      error: { code: 'INVALID_PARAMS', message: '参数不完整：需要 check_no, location' }
    });
  }

  const result = model.createCheck(check_no, location, req.operator);

  if (result.error) {
    return res.status(400).json({ error: result.error });
  }

  res.status(201).json({
    data: {
      ...result,
      status_label: model.CHECK_STATUS_LABELS[result.status]
    }
  });
});

router.get('/inventory-checks', (req, res) => {
  const { location, status } = req.query;
  const list = model.listChecks({ location, status }).map(c => ({
    ...c,
    status_label: model.CHECK_STATUS_LABELS[c.status]
  }));
  res.json({ data: list, total: list.length });
});

router.get('/inventory-checks/:check_no', (req, res) => {
  const data = model.getCheckByNo(req.params.check_no);
  if (!data) {
    return res.status(404).json({
      error: { code: 'CHECK_NOT_FOUND', message: `盘点单 ${req.params.check_no} 不存在` }
    });
  }
  data.status_label = model.CHECK_STATUS_LABELS[data.status];
  data.items = (data.items || []).map(i => ({ ...i }));
  data.diffs = (data.diffs || []).map(d => ({
    ...d,
    diff_type_label: model.DIFF_TYPE_LABELS[d.diff_type]
  }));
  data.confirmations = (data.confirmations || []).map(c => ({ ...c }));
  res.json({ data });
});

router.post('/inventory-checks/:check_no/items', requireAuth, (req, res) => {
  const { check_no } = req.params;
  const { items, mode } = req.body || {};

  if (!Array.isArray(items) || items.length === 0) {
    return res.status(400).json({
      error: { code: 'INVALID_PARAMS', message: '缺少 items 数组或数组为空' }
    });
  }

  if (mode && !['append', 'overwrite'].includes(mode)) {
    return res.status(400).json({
      error: { code: 'INVALID_PARAMS', message: 'mode 只能是 append 或 overwrite' }
    });
  }

  const result = model.addCheckItems(check_no, items, req.operator, mode || 'append');

  if (result.error) {
    const statusCode = result.error.code === 'CHECK_NOT_FOUND' ? 404
      : result.error.code === 'BOX_FROZEN' ? 400
      : result.error.code === 'BOX_CLOSED' ? 400
      : 400;
    return res.status(statusCode).json({ error: result.error });
  }

  res.json({ data: result });
});

router.post('/inventory-checks/:check_no/submit', requireAuth, (req, res) => {
  const { check_no } = req.params;

  const result = model.submitCheck(check_no, req.operator, req.role);

  if (result.error) {
    const statusCode = result.error.code === 'CHECK_NOT_FOUND' ? 404
      : result.error.code === 'CHECK_ALREADY_SUBMITTED' ? 409
      : result.error.code === 'CHECK_ALREADY_CONFIRMED' ? 409
      : 400;
    return res.status(statusCode).json({ error: result.error });
  }

  res.json({
    data: {
      ...result,
      status_label: model.CHECK_STATUS_LABELS[result.new_status],
      diffs: result.diffs.map(d => ({
        ...d,
        diff_type_label: model.DIFF_TYPE_LABELS[d.diff_type]
      }))
    }
  });
});

router.post('/inventory-checks/:check_no/confirm', requireAuth, (req, res) => {
  const { check_no } = req.params;
  const { opinion } = req.body || {};

  const result = model.confirmCheck(check_no, req.operator, req.role, opinion);

  if (result.error) {
    const statusCode = result.error.code === 'PERMISSION_DENIED' ? 403
      : result.error.code === 'CHECK_NOT_FOUND' ? 404
      : result.error.code === 'CHECK_ALREADY_CONFIRMED' ? 409
      : 400;
    return res.status(statusCode).json({ error: result.error });
  }

  res.json({
    data: {
      ...result,
      status_label: model.CHECK_STATUS_LABELS[result.new_status]
    }
  });
});

router.get('/inventory-checks/:check_no/diffs', (req, res) => {
  const result = model.getCheckDiffs(req.params.check_no);

  if (result.error) {
    return res.status(404).json({ error: result.error });
  }

  res.json({
    data: {
      ...result,
      diffs: result.diffs.map(d => ({
        ...d,
        diff_type_label: model.DIFF_TYPE_LABELS[d.diff_type]
      })),
      grouped: Object.fromEntries(
        Object.entries(result.grouped).map(([k, v]) => [
          k,
          v.map(d => ({ ...d, diff_type_label: model.DIFF_TYPE_LABELS[d.diff_type] }))
        ])
      )
    }
  });
});

module.exports = router;
