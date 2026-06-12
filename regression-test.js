const http = require('http');

const BASE = 'http://localhost:3000';
let step = 0;
let FAIL_COUNT = 0;

function request(method, path, headers = {}, body = null) {
  return new Promise((resolve, reject) => {
    const url = new URL(BASE + path);
    const opts = {
      method,
      hostname: url.hostname,
      port: url.port,
      path: url.pathname + url.search,
      headers: { 'Content-Type': 'application/json', ...headers }
    };
    const req = http.request(opts, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(data) }); }
        catch (e) { resolve({ status: res.statusCode, body: data }); }
      });
    });
    req.on('error', reject);
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

function assert(desc, condition, extra = '') {
  step++;
  const pass = !!condition;
  if (!pass) FAIL_COUNT++;
  console.log(`\n[Step ${String(step).padStart(2, '0')}] ${pass ? 'PASS' : 'FAIL'} - ${desc}`);
  if (extra) console.log('         ' + extra.slice(0, 500));
  return pass;
}

async function main() {
  console.log('===== 冷链签收接口回归测试 =====\n');
  const health = await request('GET', '/health');
  if (health.status !== 200) { console.error('服务未启动'); process.exit(1); }
  console.log('服务正常，开始测试...\n');

  // ============================================================
  // 链路 A：单箱冻结后尝试签收 → 必须失败（BOX_FROZEN 400）
  // 断言：1) 接口返回 BOX_FROZEN；2) 箱状态仍为 FROZEN；3) 冻结证据未丢失；
  //       4) 批次状态仍为 PENDING_SIGN；5) 审计日志没有 SIGN 动作
  // ============================================================
  console.log('--- 链路 A：冻结箱尝试签收必须失败 ---');

  const A1 = await request('POST', '/api/batches/import',
    { 'x-operator': 'Wang', 'x-role': 'staff' },
    {
      batch_no: 'REG_FROZEN_001',
      source_type: 'warehouse', source_name: 'CentralCold',
      target_type: 'store', target_name: 'TestStoreA',
      boxes: [
        { box_no: 'REG_BOX_A1', temperature: -18, seal_no: 'SEAL200001', product_name: 'A1', weight: 10 },
        { box_no: 'REG_BOX_A2', temperature: -19, seal_no: 'SEAL200002', product_name: 'A2', weight: 20 }
      ]
    }
  );
  assert('A1 导入批次 REG_FROZEN_001 成功', A1.status === 201, `HTTP ${A1.status} ${JSON.stringify(A1.body)}`);

  const A2 = await request('POST', '/api/batches/REG_FROZEN_001/outbound',
    { 'x-operator': 'Li', 'x-role': 'staff' }
  );
  assert('A2 出库成功（状态→待签收）', A2.status === 200 && A2.body.data.new_status === 'PENDING_SIGN',
    `HTTP ${A2.status} ${JSON.stringify(A2.body)}`);

  const A3 = await request('POST', '/api/batches/REG_FROZEN_001/freeze',
    { 'x-operator': 'Zhao', 'x-role': 'staff' },
    { box_no: 'REG_BOX_A1', reason: 'REGRESSION TEST: 封签破损', evidence: 'REGRESSION_EVIDENCE_12345' }
  );
  assert('A3 单箱冻结 REG_BOX_A1 成功', A3.status === 200 && A3.body.data.new_status === 'FROZEN',
    `HTTP ${A3.status} ${JSON.stringify(A3.body)}`);

  // 关键：尝试签收（应该失败）
  const A4 = await request('POST', '/api/batches/REG_FROZEN_001/sign',
    { 'x-operator': 'Liu', 'x-role': 'staff' },
    {
      boxes_sign: [
        { box_no: 'REG_BOX_A1', sign_temperature: -17, sign_seal_no: 'SEAL200001' },
        { box_no: 'REG_BOX_A2', sign_temperature: -18, sign_seal_no: 'SEAL200002' }
      ]
    }
  );
  assert('A4 尝试签收含冻结箱的批次 → 返回 400 BOX_FROZEN',
    A4.status === 400 && A4.body.error && A4.body.error.code === 'BOX_FROZEN',
    `HTTP ${A4.status} ${JSON.stringify(A4.body)}`);

  // 验证：查询 REG_BOX_A1 状态仍为 FROZEN，冻结证据还在
  const A5 = await request('GET', '/api/boxes/REG_BOX_A1');
  const boxA1 = A5.body.data && A5.body.data[0];
  assert('A5 查询 REG_BOX_A1 状态仍为 FROZEN（未被误签收污染）',
    boxA1 && boxA1.status === 'FROZEN',
    boxA1 ? `状态=${boxA1.status} 冻结原因=${boxA1.freeze_reason} 证据=${boxA1.freeze_evidence}` : JSON.stringify(A5.body));

  assert('A6 REG_BOX_A1 的冻结证据字段未被污染',
    boxA1 && boxA1.freeze_evidence === 'REGRESSION_EVIDENCE_12345',
    `freeze_evidence=${boxA1 ? boxA1.freeze_evidence : 'NULL'}`);

  assert('A7 REG_BOX_A1 没有 sign_operator（未被误签收）',
    boxA1 && boxA1.sign_operator === null,
    `sign_operator=${boxA1 ? boxA1.sign_operator : 'NULL'}`);

  // 验证：批次状态仍为 PENDING_SIGN（没被改成 SIGNED）
  const A8 = await request('GET', '/api/batches/REG_FROZEN_001');
  assert('A8 批次状态仍为 PENDING_SIGN',
    A8.body.data && A8.body.data.status === 'PENDING_SIGN',
    `batch.status=${A8.body.data && A8.body.data.status}`);

  // 验证：审计日志中没有 SIGN 动作（签收未发生）
  const A9 = await request('GET', '/api/audit-logs?batch_no=REG_FROZEN_001');
  const hasSignAction = A9.body.data && A9.body.data.some(l => l.action === 'SIGN');
  const hasFreezeAction = A9.body.data && A9.body.data.some(l => l.action === 'FREEZE' && l.box_no === 'REG_BOX_A1');
  assert('A9 审计日志：有 FREEZE 记录，且没有 SIGN 记录（无污染）',
    hasFreezeAction === true && hasSignAction === false,
    `日志动作列表：${(A9.body.data || []).map(l => l.action + (l.box_no ? ':' + l.box_no : '')).join(' → ')}`);

  // ============================================================
  // 链路 B：无冻结箱的正常批次 → 签收必须成功（既存流程不能被破坏）
  // ============================================================
  console.log('\n--- 链路 B：正常批次签收必须成功（回归：不能破坏既有正确流程） ---');

  const B1 = await request('POST', '/api/batches/import',
    { 'x-operator': 'Wang', 'x-role': 'staff' },
    {
      batch_no: 'REG_NORMAL_001',
      source_type: 'warehouse', source_name: 'CentralCold',
      target_type: 'store', target_name: 'TestStoreB',
      boxes: [
        { box_no: 'REG_BOX_B1', temperature: -20, seal_no: 'SEAL210001', product_name: 'B1', weight: 15 },
        { box_no: 'REG_BOX_B2', temperature: -21, seal_no: 'SEAL210002', product_name: 'B2', weight: 25 }
      ]
    }
  );
  assert('B1 导入正常批次 REG_NORMAL_001 成功', B1.status === 201, `HTTP ${B1.status}`);

  const B2 = await request('POST', '/api/batches/REG_NORMAL_001/outbound',
    { 'x-operator': 'Li', 'x-role': 'staff' }
  );
  assert('B2 出库成功', B2.status === 200, `HTTP ${B2.status}`);

  const B3 = await request('POST', '/api/batches/REG_NORMAL_001/sign',
    { 'x-operator': 'Liu', 'x-role': 'staff' },
    {
      boxes_sign: [
        { box_no: 'REG_BOX_B1', sign_temperature: -19, sign_seal_no: 'SEAL210001' },
        { box_no: 'REG_BOX_B2', sign_temperature: -20, sign_seal_no: 'SEAL210002' }
      ]
    }
  );
  assert('B3 正常批次签收成功（HTTP 200 + SIGNED）',
    B3.status === 200 && B3.body.data.new_status === 'SIGNED',
    `HTTP ${B3.status} ${JSON.stringify(B3.body)}`);

  const B4 = await request('GET', '/api/boxes/REG_BOX_B1');
  const boxB1 = B4.body.data && B4.body.data[0];
  assert('B4 REG_BOX_B1 状态变为 SIGNED 且签收人正确',
    boxB1 && boxB1.status === 'SIGNED' && boxB1.sign_operator === 'Liu',
    `status=${boxB1 && boxB1.status} sign_op=${boxB1 && boxB1.sign_operator}`);

  const B5 = await request('GET', '/api/batches/REG_NORMAL_001');
  assert('B5 批次状态为 SIGNED',
    B5.body.data && B5.body.data.status === 'SIGNED',
    `batch.status=${B5.body.data && B5.body.data.status}`);

  // ============================================================
  // 链路 C：已有错误防御不能被破坏（DUPLICATE_SIGN / MISSING_BOX_SIGN / INVALID_STATUS）
  // ============================================================
  console.log('\n--- 链路 C：既有错误防御回归验证 ---');

  const C1 = await request('POST', '/api/batches/REG_NORMAL_001/sign',
    { 'x-operator': 'Liu', 'x-role': 'staff' },
    { boxes_sign: [{ box_no: 'REG_BOX_B1', sign_temperature: -19, sign_seal_no: 'SEAL210001' }] }
  );
  assert('C1 对已签收批次再签收 → INVALID_STATUS / DUPLICATE_SIGN 错误（400）',
    C1.status === 400 && C1.body.error,
    `HTTP ${C1.status} err=${C1.body.error && C1.body.error.code}`);

  // 新批次，缺失签收明细
  await request('POST', '/api/batches/import',
    { 'x-operator': 'Wang', 'x-role': 'staff' },
    {
      batch_no: 'REG_MISS_001',
      source_type: 'warehouse', source_name: 'CentralCold',
      target_type: 'store', target_name: 'TestStoreC',
      boxes: [
        { box_no: 'REG_BOX_C1', temperature: -18, seal_no: 'SEAL220001', product_name: 'C1', weight: 10 },
        { box_no: 'REG_BOX_C2', temperature: -19, seal_no: 'SEAL220002', product_name: 'C2', weight: 20 }
      ]
    }
  );
  await request('POST', '/api/batches/REG_MISS_001/outbound', { 'x-operator': 'Li', 'x-role': 'staff' });

  const C2 = await request('POST', '/api/batches/REG_MISS_001/sign',
    { 'x-operator': 'Liu', 'x-role': 'staff' },
    { boxes_sign: [{ box_no: 'REG_BOX_C1', sign_temperature: -17, sign_seal_no: 'SEAL220001' }] }
  );
  assert('C2 只传部分箱明细 → MISSING_BOX_SIGN 错误（400）',
    C2.status === 400 && C2.body.error && C2.body.error.code === 'MISSING_BOX_SIGN',
    `HTTP ${C2.status} err=${C2.body.error && C2.body.error.code}`);

  // 未出库批次（PENDING_OUTBOUND）尝试签收 → INVALID_STATUS
  await request('POST', '/api/batches/import',
    { 'x-operator': 'Wang', 'x-role': 'staff' },
    {
      batch_no: 'REG_INVALID_001',
      source_type: 'warehouse', source_name: 'CentralCold',
      target_type: 'store', target_name: 'TestStoreD',
      boxes: [{ box_no: 'REG_BOX_D1', temperature: -18, seal_no: 'SEAL230001', product_name: 'D1', weight: 10 }]
    }
  );
  const C3 = await request('POST', '/api/batches/REG_INVALID_001/sign',
    { 'x-operator': 'Liu', 'x-role': 'staff' },
    { boxes_sign: [{ box_no: 'REG_BOX_D1', sign_temperature: -17, sign_seal_no: 'SEAL230001' }] }
  );
  assert('C3 待出库状态直接签收 → INVALID_STATUS 错误（400）',
    C3.status === 400 && C3.body.error && C3.body.error.code === 'INVALID_STATUS',
    `HTTP ${C3.status} err=${C3.body.error && C3.body.error.code}`);

  // ============================================================
  // 汇总
  // ============================================================
  console.log('\n===== 回归测试结果 =====');
  console.log(`  总步骤: ${step}`);
  console.log(`  通过:   ${step - FAIL_COUNT}`);
  console.log(`  失败:   ${FAIL_COUNT}`);
  if (FAIL_COUNT === 0) console.log('\n  ✅ 全部通过，冻结箱无法误签收，正常流程无回归问题');
  else console.log('\n  ❌ 存在失败项，请检查');
  process.exit(FAIL_COUNT === 0 ? 0 : 1);
}

main().catch(e => { console.error('测试异常:', e); process.exit(1); });
