const express = require('express');
const bodyParser = require('body-parser');
const routes = require('./routes');
const inventoryCheckRoutes = require('./routes/inventoryCheck');
const { STATUS_LABELS } = require('./models/dataModel');
const { CHECK_STATUS_LABELS, DIFF_TYPE_LABELS } = require('./models/inventoryCheckModel');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(bodyParser.json({ limit: '10mb' }));
app.use(bodyParser.urlencoded({ extended: true }));

app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Cache-Control', 'no-store');
  next();
});

app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    service: 'cold-chain-handover-api',
    timestamp: new Date().toISOString()
  });
});

app.use('/api', routes);
app.use('/api', inventoryCheckRoutes);

app.use((req, res) => {
  res.status(404).json({
    error: {
      code: 'NOT_FOUND',
      message: `接口不存在：${req.method} ${req.path}`
    }
  });
});

app.use((err, req, res, next) => {
  console.error('[SERVER ERROR]', err);
  res.status(500).json({
    error: {
      code: 'INTERNAL_ERROR',
      message: err.message || '服务器内部错误'
    }
  });
});

app.listen(PORT, () => {
  console.log('========================================');
  console.log('  冷链交接异常处理 API 服务已启动');
  console.log(`  监听端口: ${PORT}`);
  console.log(`  健康检查: http://localhost:${PORT}/health`);
  console.log(`  API 前缀:  http://localhost:${PORT}/api`);
  console.log('');
  console.log('  箱子状态流转:');
  Object.entries(STATUS_LABELS).forEach(([k, v]) => {
    console.log(`    - ${k}: ${v}`);
  });
  console.log('');
  console.log('  盘点单状态:');
  Object.entries(CHECK_STATUS_LABELS).forEach(([k, v]) => {
    console.log(`    - ${k}: ${v}`);
  });
  console.log('');
  console.log('  盘点差异类型:');
  Object.entries(DIFF_TYPE_LABELS).forEach(([k, v]) => {
    console.log(`    - ${k}: ${v}`);
  });
  console.log('');
  console.log('  请求头要求:');
  console.log('    x-operator: 操作人姓名（必填）');
  console.log('    x-role:     staff 或 supervisor（必填）');
  console.log('========================================');
});
