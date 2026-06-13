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
  console.log('===== 冷链箱库存盘点模块回归测试 =====\n');
  const health = await request('GET', '/health');
  if (health.status !== 200) { console.error('服务未启动'); process.exit(1); }
  console.log('服务正常，开始测试...\n');

  // ============================================================
  // 链路 A：正常盘点流程 — 创建→追加明细→提交→查询差异→主管确认
  // ============================================================
  console.log('--- 链路 A：正常盘点全流程 ---');

  const A0 = await request('POST', '/api/batches/import',
    { 'x-operator': 'Wang', 'x-role': 'staff' },
    {
      batch_no: 'CHK_BATCH_A',
      source_type: 'warehouse', source_name: 'WhA',
      target_type: 'store', target_name: 'StoreA',
      boxes: [
        { box_no: 'CHK_A_BOX01', temperature: -18, seal_no: 'SEAL500001', product_name: 'Beef', weight: 10 },
        { box_no: 'CHK_A_BOX02', temperature: -20, seal_no: 'SEAL500002', product_name: 'Pork', weight: 20 },
        { box_no: 'CHK_A_BOX03', temperature: -15, seal_no: 'SEAL500003', product_name: 'Fish', weight: 15 }
      ]
    }
  );
  assert('A0 导入批次 CHK_BATCH_A 成功', A0.status === 201, `HTTP ${A0.status} ${JSON.stringify(A0.body)}`);

  const A1 = await request('POST', '/api/inventory-checks',
    { 'x-operator': 'Li', 'x-role': 'staff' },
    { check_no: 'CHK_A_001', location: 'WhA' }
  );
  assert('A1 创建盘点单 CHK_A_001 成功（DRAFT）', A1.status === 201 && A1.body.data.status === 'DRAFT',
    `HTTP ${A1.status} ${JSON.stringify(A1.body)}`);

  const A2 = await request('POST', '/api/inventory-checks/CHK_A_001/items',
    { 'x-operator': 'Li', 'x-role': 'staff' },
    { items: [{ box_no: 'CHK_A_BOX01' }, { box_no: 'CHK_A_BOX02' }] }
  );
  assert('A2 追加扫描明细 2 箱成功', A2.status === 200 && A2.body.data.total === 2,
    `HTTP ${A2.status} total=${A2.body.data && A2.body.data.total}`);

  const A3 = await request('POST', '/api/inventory-checks/CHK_A_001/items',
    { 'x-operator': 'Li', 'x-role': 'staff' },
    { items: [{ box_no: 'CHK_A_BOX03' }] }
  );
  assert('A3 再追加 1 箱（共 3 箱）成功', A3.status === 200 && A3.body.data.total === 3,
    `HTTP ${A3.status} total=${A3.body.data && A3.body.data.total}`);

  const A4 = await request('POST', '/api/inventory-checks/CHK_A_001/submit',
    { 'x-operator': 'Li', 'x-role': 'staff' }
  );
  assert('A4 提交盘点成功（SUBMITTED）', A4.status === 200 && A4.body.data.new_status === 'SUBMITTED',
    `HTTP ${A4.status} ${JSON.stringify(A4.body)}`);

  assert('A4.1 提交后差异为 0（全部箱都扫到了）',
    A4.body.data.diffs_count === 0,
    `diffs_count=${A4.body.data && A4.body.data.diffs_count}`);

  const A5 = await request('GET', '/api/inventory-checks/CHK_A_001');
  assert('A5 查询盘点详情成功', A5.status === 200 && A5.body.data.status === 'SUBMITTED',
    `HTTP ${A5.status} status=${A5.body.data && A5.body.data.status}`);
  assert('A5.1 明细有 3 条', A5.body.data.items && A5.body.data.items.length === 3,
    `items.length=${A5.body.data && A5.body.data.items && A5.body.data.items.length}`);

  const A6 = await request('POST', '/api/inventory-checks/CHK_A_001/confirm',
    { 'x-operator': 'SupervisorZhang', 'x-role': 'supervisor' },
    { opinion: '盘点无误，确认' }
  );
  assert('A6 主管确认差异处理成功（CONFIRMED）', A6.status === 200 && A6.body.data.new_status === 'CONFIRMED',
    `HTTP ${A6.status} ${JSON.stringify(A6.body)}`);

  const A7 = await request('GET', '/api/inventory-checks/CHK_A_001');
  assert('A7 盘点单状态为 CONFIRMED，含确认记录',
    A7.body.data.status === 'CONFIRMED' && A7.body.data.confirmations && A7.body.data.confirmations.length === 1,
    `status=${A7.body.data && A7.body.data.status} confirmations=${A7.body.data && A7.body.data.confirmations && A7.body.data.confirmations.length}`);

  // ============================================================
  // 链路 B：发现差异 — 漏扫 + 多扫 + 库位不一致
  // ============================================================
  console.log('\n--- 链路 B：发现差异（漏扫+多扫+库位不一致） ---');

  const B0 = await request('POST', '/api/batches/import',
    { 'x-operator': 'Wang', 'x-role': 'staff' },
    {
      batch_no: 'CHK_BATCH_B',
      source_type: 'warehouse', source_name: 'WhB',
      target_type: 'store', target_name: 'StoreB',
      boxes: [
        { box_no: 'CHK_B_BOX01', temperature: -18, seal_no: 'SEAL501001', product_name: 'A', weight: 10 },
        { box_no: 'CHK_B_BOX02', temperature: -19, seal_no: 'SEAL501002', product_name: 'B', weight: 20 },
        { box_no: 'CHK_B_BOX03', temperature: -20, seal_no: 'SEAL501003', product_name: 'C', weight: 30 }
      ]
    }
  );
  assert('B0 导入批次 CHK_BATCH_B 成功', B0.status === 201, `HTTP ${B0.status}`);

  const B0b = await request('POST', '/api/batches/import',
    { 'x-operator': 'Wang', 'x-role': 'staff' },
    {
      batch_no: 'CHK_BATCH_B2',
      source_type: 'warehouse', source_name: 'WhOther',
      target_type: 'store', target_name: 'StoreOther',
      boxes: [
        { box_no: 'CHK_B_BOX04', temperature: -18, seal_no: 'SEAL501004', product_name: 'D', weight: 10 }
      ]
    }
  );
  assert('B0b 导入批次 CHK_BATCH_B2（不同库位）成功', B0b.status === 201, `HTTP ${B0b.status}`);

  const B1 = await request('POST', '/api/inventory-checks',
    { 'x-operator': 'Li', 'x-role': 'staff' },
    { check_no: 'CHK_B_001', location: 'WhB' }
  );
  assert('B1 创建盘点单 CHK_B_001（库位 WhB）成功', B1.status === 201, `HTTP ${B1.status}`);

  const B2 = await request('POST', '/api/inventory-checks/CHK_B_001/items',
    { 'x-operator': 'Li', 'x-role': 'staff' },
    { items: [{ box_no: 'CHK_B_BOX01' }, { box_no: 'CHK_B_BOX04' }] }
  );
  assert('B2 扫描 CHK_B_BOX01（本库位）+ CHK_B_BOX04（其他库位）成功', B2.status === 200,
    `HTTP ${B2.status} ${JSON.stringify(B2.body)}`);

  const B3 = await request('POST', '/api/inventory-checks/CHK_B_001/submit',
    { 'x-operator': 'Li', 'x-role': 'staff' }
  );
  assert('B3 提交盘点成功', B3.status === 200, `HTTP ${B3.status} ${JSON.stringify(B3.body)}`);

  const diffsB = B3.body.data.diffs || [];
  const missingScan = diffsB.filter(d => d.diff_type === 'MISSING_SCAN');
  const locationMismatch = diffsB.filter(d => d.diff_type === 'LOCATION_MISMATCH');

  assert('B3.1 漏扫差异：CHK_B_BOX02、CHK_B_BOX03 未扫描',
    missingScan.length === 2 && missingScan.some(d => d.box_no === 'CHK_B_BOX02') && missingScan.some(d => d.box_no === 'CHK_B_BOX03'),
    `missingScan: ${JSON.stringify(missingScan.map(d => d.box_no))}`);

  assert('B3.2 库位不一致差异：CHK_B_BOX04 属于其他库位',
    locationMismatch.length === 1 && locationMismatch[0].box_no === 'CHK_B_BOX04',
    `locationMismatch: ${JSON.stringify(locationMismatch.map(d => d.box_no))}`);

  assert('B3.3 漏扫差异带出关联批次和状态',
    missingScan.length > 0 && missingScan[0].batch_no === 'CHK_BATCH_B' && missingScan[0].expected_status,
    `batch_no=${missingScan.length > 0 && missingScan[0].batch_no} expected_status=${missingScan.length > 0 && missingScan[0].expected_status}`);

  assert('B3.4 库位不一致差异带出预期库位',
    locationMismatch.length > 0 && locationMismatch[0].expected_location === 'WhOther',
    `expected_location=${locationMismatch.length > 0 && locationMismatch[0].expected_location}`);

  const B4 = await request('GET', '/api/inventory-checks/CHK_B_001/diffs');
  assert('B4 差异查询接口正常', B4.status === 200, `HTTP ${B4.status}`);
  assert('B4.1 差异分组正确',
    B4.body.data.grouped.MISSING_SCAN && B4.body.data.grouped.MISSING_SCAN.length === 2 &&
    B4.body.data.grouped.LOCATION_MISMATCH && B4.body.data.grouped.LOCATION_MISMATCH.length === 1,
    `MISSING_SCAN=${B4.body.data.grouped.MISSING_SCAN && B4.body.data.grouped.MISSING_SCAN.length} LOCATION_MISMATCH=${B4.body.data.grouped.LOCATION_MISMATCH && B4.body.data.grouped.LOCATION_MISMATCH.length}`);

  // ============================================================
  // 链路 C：多扫差异（扫描系统不存在的箱号）
  // ============================================================
  console.log('\n--- 链路 C：多扫差异（扫描系统不存在的箱号） ---');

  const C1 = await request('POST', '/api/inventory-checks',
    { 'x-operator': 'Li', 'x-role': 'staff' },
    { check_no: 'CHK_C_001', location: 'WhA' }
  );
  assert('C1 创建盘点单 CHK_C_001 成功', C1.status === 201, `HTTP ${C1.status}`);

  const C2 = await request('POST', '/api/inventory-checks/CHK_C_001/items',
    { 'x-operator': 'Li', 'x-role': 'staff' },
    { items: [{ box_no: 'CHK_GHOST_BOX' }] }
  );
  assert('C2 扫描系统不存在的箱号 CHK_GHOST_BOX 成功', C2.status === 200,
    `HTTP ${C2.status}`);

  const C3 = await request('POST', '/api/inventory-checks/CHK_C_001/submit',
    { 'x-operator': 'Li', 'x-role': 'staff' }
  );
  assert('C3 提交盘点成功', C3.status === 200, `HTTP ${C3.status}`);

  const diffsC = C3.body.data.diffs || [];
  const extraScan = diffsC.filter(d => d.diff_type === 'EXTRA_SCAN');
  const missingScanC = diffsC.filter(d => d.diff_type === 'MISSING_SCAN');

  assert('C3.1 多扫差异：CHK_GHOST_BOX 不在系统中',
    extraScan.length === 1 && extraScan[0].box_no === 'CHK_GHOST_BOX',
    `extraScan: ${JSON.stringify(extraScan.map(d => d.box_no))}`);

  assert('C3.2 漏扫差异：CHK_A_BOX01/02/03 应在 WhA 但未扫描',
    missingScanC.length === 3,
    `missingScanC count: ${missingScanC.length}`);

  // ============================================================
  // 链路 D：权限拒绝 — 普通员工不能确认差异
  // ============================================================
  console.log('\n--- 链路 D：权限拒绝 ---');

  const D1 = await request('POST', '/api/inventory-checks/CHK_B_001/confirm',
    { 'x-operator': 'StaffZhao', 'x-role': 'staff' },
    { opinion: '尝试确认' }
  );
  assert('D1 普通员工确认差异 → 403 PERMISSION_DENIED',
    D1.status === 403 && D1.body.error && D1.body.error.code === 'PERMISSION_DENIED',
    `HTTP ${D1.status} ${JSON.stringify(D1.body)}`);

  // ============================================================
  // 链路 E：提交后禁止修改
  // ============================================================
  console.log('\n--- 链路 E：提交后禁止修改 ---');

  const E1 = await request('POST', '/api/inventory-checks/CHK_B_001/items',
    { 'x-operator': 'Li', 'x-role': 'staff' },
    { items: [{ box_no: 'CHK_B_BOX03' }] }
  );
  assert('E1 已提交盘点单追加明细 → 400 CHECK_NOT_DRAFT',
    E1.status === 400 && E1.body.error && E1.body.error.code === 'CHECK_NOT_DRAFT',
    `HTTP ${E1.status} err=${E1.body.error && E1.body.error.code}`);

  const E2 = await request('POST', '/api/inventory-checks/CHK_B_001/submit',
    { 'x-operator': 'Li', 'x-role': 'staff' }
  );
  assert('E2 重复提交盘点单 → 409 CHECK_ALREADY_SUBMITTED',
    E2.status === 409 && E2.body.error && E2.body.error.code === 'CHECK_ALREADY_SUBMITTED',
    `HTTP ${E2.status} err=${E2.body.error && E2.body.error.code}`);

  // ============================================================
  // 链路 F：冲突场景 — 重复箱号 / 冻结箱 / 关闭箱
  // ============================================================
  console.log('\n--- 链路 F：冲突场景 ---');

  const F0 = await request('POST', '/api/batches/import',
    { 'x-operator': 'Wang', 'x-role': 'staff' },
    {
      batch_no: 'CHK_BATCH_F',
      source_type: 'warehouse', source_name: 'WhF',
      target_type: 'store', target_name: 'StoreF',
      boxes: [
        { box_no: 'CHK_F_BOX01', temperature: -18, seal_no: 'SEAL502001', product_name: 'X', weight: 10 },
        { box_no: 'CHK_F_BOX02', temperature: -19, seal_no: 'SEAL502002', product_name: 'Y', weight: 20 }
      ]
    }
  );
  assert('F0 导入批次 CHK_BATCH_F 成功', F0.status === 201, `HTTP ${F0.status}`);

  await request('POST', '/api/batches/CHK_BATCH_F/outbound', { 'x-operator': 'Li', 'x-role': 'staff' });

  const F0b = await request('POST', '/api/batches/CHK_BATCH_F/freeze',
    { 'x-operator': 'Zhao', 'x-role': 'staff' },
    { box_no: 'CHK_F_BOX01', reason: '测试冻结', evidence: 'test' }
  );
  assert('F0b 冻结 CHK_F_BOX01 成功', F0b.status === 200, `HTTP ${F0b.status}`);

  const F1 = await request('POST', '/api/inventory-checks',
    { 'x-operator': 'Li', 'x-role': 'staff' },
    { check_no: 'CHK_F_001', location: 'WhF' }
  );
  assert('F1 创建盘点单 CHK_F_001 成功', F1.status === 201, `HTTP ${F1.status}`);

  const F2 = await request('POST', '/api/inventory-checks/CHK_F_001/items',
    { 'x-operator': 'Li', 'x-role': 'staff' },
    { items: [{ box_no: 'CHK_F_BOX02' }, { box_no: 'CHK_F_BOX02' }] }
  );
  assert('F2 请求内重复箱号 → 400 DUPLICATE_BOX_IN_REQUEST',
    F2.status === 400 && F2.body.error && F2.body.error.code === 'DUPLICATE_BOX_IN_REQUEST',
    `HTTP ${F2.status} err=${F2.body.error && F2.body.error.code}`);

  const F3 = await request('POST', '/api/inventory-checks/CHK_F_001/items',
    { 'x-operator': 'Li', 'x-role': 'staff' },
    { items: [{ box_no: 'CHK_F_BOX02' }] }
  );
  assert('F3 先追加 CHK_F_BOX02 成功', F3.status === 200, `HTTP ${F3.status}`);

  const F4 = await request('POST', '/api/inventory-checks/CHK_F_001/items',
    { 'x-operator': 'Li', 'x-role': 'staff' },
    { items: [{ box_no: 'CHK_F_BOX02' }] }
  );
  assert('F4 追加已存在的箱号 → 400 DUPLICATE_BOX_IN_CHECK',
    F4.status === 400 && F4.body.error && F4.body.error.code === 'DUPLICATE_BOX_IN_CHECK',
    `HTTP ${F4.status} err=${F4.body.error && F4.body.error.code}`);

  const F5 = await request('POST', '/api/inventory-checks/CHK_F_001/items',
    { 'x-operator': 'Li', 'x-role': 'staff' },
    { items: [{ box_no: 'CHK_F_BOX01' }] }
  );
  assert('F5 扫描冻结箱 → 400 BOX_FROZEN',
    F5.status === 400 && F5.body.error && F5.body.error.code === 'BOX_FROZEN',
    `HTTP ${F5.status} err=${F5.body.error && F5.body.error.code}`);

  await request('POST', '/api/batches/CHK_BATCH_F/freeze',
    { 'x-operator': 'Zhao', 'x-role': 'staff' },
    { box_no: 'CHK_F_BOX02', reason: '测试冻结2', evidence: 'test2' }
  );

  const F6 = await request('POST', '/api/inventory-checks/CHK_F_001/items',
    { 'x-operator': 'Li', 'x-role': 'staff' },
    { items: [{ box_no: 'CHK_F_BOX02' }] }
  );
  assert('F6 CHK_F_BOX02 已冻结，追加时报错 BOX_FROZEN（覆盖模式也应报错）',
    F6.status === 400,
    `HTTP ${F6.status} ${JSON.stringify(F6.body)}`);

  // 已关闭箱子
  await request('POST', '/api/batches/CHK_BATCH_F/freeze',
    { 'x-operator': 'Zhao', 'x-role': 'staff' },
    { reason: '整批冻结', evidence: 'test' }
  );
  await request('POST', '/api/batches/CHK_BATCH_F/review-close',
    { 'x-operator': 'SupervisorZhang', 'x-role': 'supervisor' },
    { opinion: '关闭测试' }
  );

  const F7 = await request('POST', '/api/inventory-checks',
    { 'x-operator': 'Li', 'x-role': 'staff' },
    { check_no: 'CHK_F_002', location: 'WhF'
    }
  );
  assert('F7 创建盘点单 CHK_F_002 成功', F7.status === 201, `HTTP ${F7.status}`);

  const F8 = await request('POST', '/api/inventory-checks/CHK_F_002/items',
    { 'x-operator': 'Li', 'x-role': 'staff' },
    { items: [{ box_no: 'CHK_F_BOX01' }] }
  );
  assert('F8 扫描已关闭箱 CHK_F_BOX01 → 400 BOX_CLOSED',
    F8.status === 400 && F8.body.error && F8.body.error.code === 'BOX_CLOSED',
    `HTTP ${F8.status} err=${F8.body.error && F8.body.error.code}`);

  // ============================================================
  // 链路 G：覆盖模式 + 盘点单列表查询
  // ============================================================
  console.log('\n--- 链路 G：覆盖模式 + 列表查询 ---');

  const G0 = await request('POST', '/api/batches/import',
    { 'x-operator': 'Wang', 'x-role': 'staff' },
    {
      batch_no: 'CHK_BATCH_G',
      source_type: 'warehouse', source_name: 'WhG',
      target_type: 'store', target_name: 'StoreG',
      boxes: [
        { box_no: 'CHK_G_BOX01', temperature: -18, seal_no: 'SEAL503001', product_name: 'G1', weight: 10 },
        { box_no: 'CHK_G_BOX02', temperature: -19, seal_no: 'SEAL503002', product_name: 'G2', weight: 20 }
      ]
    }
  );
  assert('G0 导入批次 CHK_BATCH_G 成功', G0.status === 201, `HTTP ${G0.status}`);

  const G1 = await request('POST', '/api/inventory-checks',
    { 'x-operator': 'Li', 'x-role': 'staff' },
    { check_no: 'CHK_G_001', location: 'WhG' }
  );
  assert('G1 创建盘点单成功', G1.status === 201, `HTTP ${G1.status}`);

  await request('POST', '/api/inventory-checks/CHK_G_001/items',
    { 'x-operator': 'Li', 'x-role': 'staff' },
    { items: [{ box_no: 'CHK_G_BOX01' }, { box_no: 'CHK_G_BOX02' }] }
  );

  const G2 = await request('POST', '/api/inventory-checks/CHK_G_001/items',
    { 'x-operator': 'Li', 'x-role': 'staff' },
    { mode: 'overwrite', items: [{ box_no: 'CHK_G_BOX01' }] }
  );
  assert('G2 覆盖模式：只剩 CHK_G_BOX01', G2.status === 200 && G2.body.data.total === 1,
    `HTTP ${G2.status} total=${G2.body.data && G2.body.data.total}`);

  const G3 = await request('GET', '/api/inventory-checks?location=WhG');
  assert('G3 按库位查询盘点单', G3.status === 200 && G3.body.data.length >= 1,
    `HTTP ${G3.status} total=${G3.body.data && G3.body.data.length}`);

  const G4 = await request('GET', '/api/inventory-checks?status=DRAFT');
  assert('G4 按状态查询盘点单（DRAFT）', G4.status === 200 && G4.body.data.length >= 1,
    `HTTP ${G4.status} total=${G4.body.data && G4.body.data.length}`);

  // ============================================================
  // 链路 H：重复盘点单号
  // ============================================================
  console.log('\n--- 链路 H：重复盘点单号 ---');

  const H1 = await request('POST', '/api/inventory-checks',
    { 'x-operator': 'Li', 'x-role': 'staff' },
    { check_no: 'CHK_A_001', location: 'WhA' }
  );
  assert('H1 重复盘点单号 → 400 DUPLICATE_CHECK_NO',
    H1.status === 400 && H1.body.error && H1.body.error.code === 'DUPLICATE_CHECK_NO',
    `HTTP ${H1.status} err=${H1.body.error && H1.body.error.code}`);

  // ============================================================
  // 链路 I：审计日志验证
  // ============================================================
  console.log('\n--- 链路 I：审计日志验证 ---');

  const I1 = await request('GET', '/api/audit-logs?batch_no=CHK_A_001');
  const checkActions = (I1.body.data || []).map(l => l.action);
  assert('I1 盘点单 CHK_A_001 审计日志含 CREATE/ADD_ITEMS/SUBMIT/CONFIRM',
    checkActions.includes('INVENTORY_CHECK_CREATE') &&
    checkActions.includes('INVENTORY_CHECK_ADD_ITEMS') &&
    checkActions.includes('INVENTORY_CHECK_SUBMIT') &&
    checkActions.includes('INVENTORY_CHECK_CONFIRM'),
    `actions: ${checkActions.join(', ')}`);

  // ============================================================
  // 链路 J：已确认的盘点单不能再确认
  // ============================================================
  console.log('\n--- 链路 J：已确认的盘点单不能再操作 ---');

  const J1 = await request('POST', '/api/inventory-checks/CHK_A_001/confirm',
    { 'x-operator': 'SupervisorZhang', 'x-role': 'supervisor' },
    { opinion: '再确认' }
  );
  assert('J1 已确认的盘点单再确认 → 409 CHECK_ALREADY_CONFIRMED',
    J1.status === 409 && J1.body.error && J1.body.error.code === 'CHECK_ALREADY_CONFIRMED',
    `HTTP ${J1.status} err=${J1.body.error && J1.body.error.code}`);

  // ============================================================
  // 链路 K：重启后数据持久化验证（不真正重启，验证数据在 DB 中）
  // ============================================================
  console.log('\n--- 链路 K：数据持久化验证 ---');

  const K1 = await request('GET', '/api/inventory-checks/CHK_A_001');
  assert('K1 盘点单 CHK_A_001 数据持久化（查询正常）',
    K1.status === 200 && K1.body.data.check_no === 'CHK_A_001' && K1.body.data.status === 'CONFIRMED',
    `HTTP ${K1.status} check_no=${K1.body.data && K1.body.data.check_no} status=${K1.body.data && K1.body.data.status}`);

  const K2 = await request('GET', '/api/inventory-checks/CHK_B_001');
  assert('K2 盘点单 CHK_B_001 差异数据持久化',
    K2.status === 200 && K2.body.data.diffs && K2.body.data.diffs.length > 0,
    `HTTP ${K2.status} diffs_length=${K2.body.data && K2.body.data.diffs && K2.body.data.diffs.length}`);

  const K3 = await request('GET', '/api/inventory-checks/CHK_A_001');
  assert('K3 确认记录持久化',
    K3.body.data.confirmations && K3.body.data.confirmations.length === 1 &&
    K3.body.data.confirmations[0].operator === 'SupervisorZhang',
    `confirmations: ${JSON.stringify(K3.body.data && K3.body.data.confirmations)}`);

  // ============================================================
  // 链路 L：空明细提交应报错
  // ============================================================
  console.log('\n--- 链路 L：空明细提交 ---');

  const L1 = await request('POST', '/api/inventory-checks',
    { 'x-operator': 'Li', 'x-role': 'staff' },
    { check_no: 'CHK_L_001', location: 'WhL' }
  );
  assert('L1 创建空盘点单成功', L1.status === 201, `HTTP ${L1.status}`);

  const L2 = await request('POST', '/api/inventory-checks/CHK_L_001/submit',
    { 'x-operator': 'Li', 'x-role': 'staff' }
  );
  assert('L2 空盘点单提交 → 400 EMPTY_CHECK_ITEMS',
    L2.status === 400 && L2.body.error && L2.body.error.code === 'EMPTY_CHECK_ITEMS',
    `HTTP ${L2.status} err=${L2.body.error && L2.body.error.code}`);

  // ============================================================
  // 链路 M：目标库位盘点（门店盘点已签收/待签收的箱）
  // ============================================================
  console.log('\n--- 链路 M：目标库位盘点 ---');

  const M0 = await request('POST', '/api/batches/import',
    { 'x-operator': 'Wang', 'x-role': 'staff' },
    {
      batch_no: 'CHK_BATCH_M',
      source_type: 'warehouse', source_name: 'WhM',
      target_type: 'store', target_name: 'StoreM',
      boxes: [
        { box_no: 'CHK_M_BOX01', temperature: -18, seal_no: 'SEAL504001', product_name: 'M1', weight: 10 },
        { box_no: 'CHK_M_BOX02', temperature: -19, seal_no: 'SEAL504002', product_name: 'M2', weight: 20 }
      ]
    }
  );
  assert('M0 导入批次 CHK_BATCH_M 成功', M0.status === 201, `HTTP ${M0.status}`);

  await request('POST', '/api/batches/CHK_BATCH_M/outbound', { 'x-operator': 'Li', 'x-role': 'staff' });

  const M1 = await request('POST', '/api/inventory-checks',
    { 'x-operator': 'Li', 'x-role': 'staff' },
    { check_no: 'CHK_M_001', location: 'StoreM' }
  );
  assert('M1 创建门店盘点单（StoreM）成功', M1.status === 201, `HTTP ${M1.status}`);

  const M2 = await request('POST', '/api/inventory-checks/CHK_M_001/items',
    { 'x-operator': 'Li', 'x-role': 'staff' },
    { items: [{ box_no: 'CHK_M_BOX01' }] }
  );
  assert('M2 扫描 CHK_M_BOX01（仅扫 1 箱）', M2.status === 200, `HTTP ${M2.status}`);

  const M3 = await request('POST', '/api/inventory-checks/CHK_M_001/submit',
    { 'x-operator': 'Li', 'x-role': 'staff' }
  );
  assert('M3 提交门店盘点成功', M3.status === 200, `HTTP ${M3.status}`);

  const diffsM = M3.body.data.diffs || [];
  const missingM = diffsM.filter(d => d.diff_type === 'MISSING_SCAN');
  assert('M3.1 门店盘点漏扫：CHK_M_BOX02（PENDING_SIGN，应在 StoreM）',
    missingM.length === 1 && missingM[0].box_no === 'CHK_M_BOX02' && missingM[0].expected_status === 'PENDING_SIGN',
    `missingM: ${JSON.stringify(missingM)}`);

  // ============================================================
  // 汇总
  // ============================================================
  console.log('\n===== 盘点模块回归测试结果 =====');
  console.log(`  总步骤: ${step}`);
  console.log(`  通过:   ${step - FAIL_COUNT}`);
  console.log(`  失败:   ${FAIL_COUNT}`);
  if (FAIL_COUNT === 0) console.log('\n  ✅ 全部通过，盘点模块功能正常');
  else console.log('\n  ❌ 存在失败项，请检查');
  process.exit(FAIL_COUNT === 0 ? 0 : 1);
}

main().catch(e => { console.error('测试异常:', e); process.exit(1); });
