const express = require('express');
const router = express.Router();
const model = require('../models/inventoryCheckModel');
const service = require('../services/inventoryCheckService');
const { requireAuth } = require('../middleware/validator');
const {
  CHECK_STATUS_LABELS,
  DIFF_TYPE_LABELS,
  httpStatusFor
} = require('../constants');

function formatDiff(d) {
  return { ...d, diff_type_label: DIFF_TYPE_LABELS[d.diff_type] };
}

function formatCheck(data) {
  data.status_label = CHECK_STATUS_LABELS[data.status];
  data.items = (data.items || []).map(i => ({ ...i }));
  data.diffs = (data.diffs || []).map(formatDiff);
  data.confirmations = (data.confirmations || []).map(c => ({ ...c }));
  return data;
}

function sendError(res, error) {
  return res.status(httpStatusFor(error.code)).json({ error });
}

function sendResult(res, statusCode, result) {
  if (result.error) return sendError(res, result.error);
  return res.status(statusCode).json({ data: result });
}

router.post('/inventory-checks', requireAuth, (req, res) => {
  const { check_no, location } = req.body || {};

  if (!check_no || !location) {
    return res.status(400).json({
      error: { code: 'INVALID_PARAMS', message: '参数不完整：需要 check_no, location' }
    });
  }

  const result = service.createCheck(check_no, location, req.operator);
  if (result.error) return sendError(res, result.error);

  res.status(201).json({
    data: { ...result, status_label: CHECK_STATUS_LABELS[result.status] }
  });
});

router.get('/inventory-checks', (req, res) => {
  const { location, status } = req.query;
  const list = model.listChecks({ location, status }).map(c => ({
    ...c,
    status_label: CHECK_STATUS_LABELS[c.status]
  }));
  res.json({ data: list, total: list.length });
});

router.get('/inventory-checks/:check_no', (req, res) => {
  const data = model.getFullCheck(req.params.check_no);
  if (!data) {
    return sendError(res, { code: 'CHECK_NOT_FOUND', message: `盘点单 ${req.params.check_no} 不存在` });
  }
  res.json({ data: formatCheck(data) });
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

  const result = service.addCheckItems(check_no, items, req.operator, mode || 'append');
  sendResult(res, 200, result);
});

router.post('/inventory-checks/:check_no/submit', requireAuth, (req, res) => {
  const { check_no } = req.params;
  const result = service.submitCheck(check_no, req.operator, req.role);

  if (result.error) return sendError(res, result.error);

  res.json({
    data: {
      ...result,
      status_label: CHECK_STATUS_LABELS[result.new_status],
      diffs: result.diffs.map(formatDiff)
    }
  });
});

router.post('/inventory-checks/:check_no/confirm', requireAuth, (req, res) => {
  const { check_no } = req.params;
  const { opinion } = req.body || {};

  const result = service.confirmCheck(check_no, req.operator, req.role, opinion);
  if (result.error) return sendError(res, result.error);

  res.json({
    data: { ...result, status_label: CHECK_STATUS_LABELS[result.new_status] }
  });
});

router.get('/inventory-checks/:check_no/diffs', (req, res) => {
  const result = service.getCheckDiffs(req.params.check_no);

  if (result.error) return sendError(res, result.error);

  res.json({
    data: {
      ...result,
      diffs: result.diffs.map(formatDiff),
      grouped: Object.fromEntries(
        Object.entries(result.grouped).map(([k, v]) => [k, v.map(formatDiff)])
      )
    }
  });
});

module.exports = router;
