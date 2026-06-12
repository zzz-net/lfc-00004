const http = require('http');

const BASE = 'http://localhost:3000';

function request(method, path, headers = {}, body = null) {
  return new Promise((resolve, reject) => {
    const url = new URL(BASE + path);
    const opts = {
      method,
      hostname: url.hostname,
      port: url.port,
      path: url.pathname + url.search,
      headers: {
        'Content-Type': 'application/json',
        ...headers
      }
    };
    const req = http.request(opts, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        try {
          resolve({ status: res.statusCode, body: JSON.parse(data) });
        } catch (e) {
          resolve({ status: res.statusCode, body: data });
        }
      });
    });
    req.on('error', reject);
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

let step = 0;
async function print(desc, method, path, headers, body, expectSuccess = true) {
  step++;
  console.log(`\n=== [${step}] ${desc} ===`);
  const res = await request(method, path, headers, body);
  const ok = expectSuccess ? (res.status >= 200 && res.status < 300) : (res.status >= 400);
  console.log('  HTTP', res.status, ok ? 'PASS' : 'FAIL');
  const s = JSON.stringify(res.body);
  console.log('  ' + s.slice(0, 700));
  return res;
}

async function main() {
  try {
    // ========== 基础 ==========
    await print('Health', 'GET', '/health');
    await print('查看配置', 'GET', '/api/configs');
    await print('状态列表', 'GET', '/api/statuses');

    // ========== 链路一：正常流程 ==========
    await print(
      '正常-Step1 导入 BATCH20260613001（2箱）',
      'POST', '/api/batches/import',
      { 'x-operator': 'Wang', 'x-role': 'staff' },
      {
        batch_no: 'BATCH20260613001',
        source_type: 'warehouse', source_name: 'CentralCold',
        target_type: 'store', target_name: 'ChaoyangStore',
        boxes: [
          { box_no: 'BOX001', temperature: -18, seal_no: 'SEAL000001', product_name: 'Beef', weight: 25.5 },
          { box_no: 'BOX002', temperature: -20, seal_no: 'SEAL000002', product_name: 'Pork', weight: 30.0 }
        ]
      }
    );

    await print('正常-Step2 查询详情（待出库）', 'GET', '/api/batches/BATCH20260613001');
    await print('正常-Step2.1 按箱号查 BOX001', 'GET', '/api/boxes/BOX001');

    await print(
      '正常-Step3 出库（待签收）',
      'POST', '/api/batches/BATCH20260613001/outbound',
      { 'x-operator': 'Li', 'x-role': 'staff' }
    );

    await print('正常-Step4 查询（待签收）', 'GET', '/api/batches/BATCH20260613001');

    await print(
      '正常-Step5 签收（已签收）',
      'POST', '/api/batches/BATCH20260613001/sign',
      { 'x-operator': 'Liu', 'x-role': 'staff' },
      {
        boxes_sign: [
          { box_no: 'BOX001', sign_temperature: -17, sign_seal_no: 'SEAL000001' },
          { box_no: 'BOX002', sign_temperature: -19, sign_seal_no: 'SEAL000002' }
        ]
      }
    );

    await print('正常-Step6 审计日志', 'GET', '/api/audit-logs?batch_no=BATCH20260613001');

    // ========== 链路二：异常流程 ==========
    await print(
      '异常-Step1 导入 BATCH20260613002',
      'POST', '/api/batches/import',
      { 'x-operator': 'Wang', 'x-role': 'staff' },
      {
        batch_no: 'BATCH20260613002',
        source_type: 'warehouse', source_name: 'CentralCold',
        target_type: 'store', target_name: 'HaidianStore',
        boxes: [
          { box_no: 'BOX003', temperature: -18, seal_no: 'SEAL000003', product_name: 'IceCream', weight: 12.8 },
          { box_no: 'BOX004', temperature: -22, seal_no: 'SEAL000004', product_name: 'Shrimp', weight: 18.0 }
        ]
      }
    );

    await print(
      '异常-Step2 出库',
      'POST', '/api/batches/BATCH20260613002/outbound',
      { 'x-operator': 'Li', 'x-role': 'staff' }
    );

    await print(
      '异常-Step3 整批冻结',
      'POST', '/api/batches/BATCH20260613002/freeze',
      { 'x-operator': 'Zhao', 'x-role': 'staff' },
      { reason: 'Cooling failure - temp up to 5C on arrival', evidence: 'thermo-photo + logger-screenshot' }
    );

    await print('异常-Step4 查询（FROZEN）', 'GET', '/api/batches/BATCH20260613002');

    await print(
      '异常-Step5 普通员工尝试关闭（应失败）',
      'POST', '/api/batches/BATCH20260613002/review-close',
      { 'x-operator': 'Zhao', 'x-role': 'staff' },
      { opinion: 'try close' },
      false
    );

    await print(
      '异常-Step6 主管复核关闭（成功）',
      'POST', '/api/batches/BATCH20260613002/review-close',
      { 'x-operator': 'SupervisorZhang', 'x-role': 'supervisor' },
      { opinion: 'Cooling failure confirmed; supplier re-delivery arranged; batch destroyed and closed' }
    );

    await print('异常-Step7 查询（已关闭含复核意见）', 'GET', '/api/batches/BATCH20260613002');
    await print('异常-Step8 审计日志', 'GET', '/api/audit-logs?batch_no=BATCH20260613002');

    // ========== 链路三：单箱冻结+单箱关闭 ==========
    await print(
      '单箱-Step1 导入 BATCH20260613003',
      'POST', '/api/batches/import',
      { 'x-operator': 'Wang', 'x-role': 'staff' },
      {
        batch_no: 'BATCH20260613003',
        source_type: 'warehouse', source_name: 'CentralCold',
        target_type: 'store', target_name: 'DongchengStore',
        boxes: [
          { box_no: 'BOX005', temperature: -18, seal_no: 'SEAL000005', product_name: 'Fish', weight: 20.0 },
          { box_no: 'BOX006', temperature: -19, seal_no: 'SEAL000006', product_name: 'Chicken', weight: 15.0 }
        ]
      }
    );

    await print(
      '单箱-Step2 出库',
      'POST', '/api/batches/BATCH20260613003/outbound',
      { 'x-operator': 'Li', 'x-role': 'staff' }
    );

    await print(
      '单箱-Step3 仅冻结 BOX005（封签破损）',
      'POST', '/api/batches/BATCH20260613003/freeze',
      { 'x-operator': 'Zhao', 'x-role': 'staff' },
      { box_no: 'BOX005', reason: 'Seal broken on BOX005', evidence: 'seal-photo' }
    );

    await print('单箱-Step4 查询（批次仍待签收，BOX005冻结，BOX006待签收）', 'GET', '/api/batches/BATCH20260613003');

    await print(
      '单箱-Step5 主管只关闭 BOX005 异常',
      'POST', '/api/batches/BATCH20260613003/review-close',
      { 'x-operator': 'SupervisorZhang', 'x-role': 'supervisor' },
      { box_no: 'BOX005', opinion: 'Seal broken case closed; BOX005 returned' }
    );

    await print('单箱-Step6 查询（BOX005关闭，BOX006仍待签收）', 'GET', '/api/batches/BATCH20260613003');

    // ========== 错误场景 ==========
    await print(
      'E1 重复箱号 BOX001（应失败）',
      'POST', '/api/batches/import',
      { 'x-operator': 'Wang', 'x-role': 'staff' },
      {
        batch_no: 'BATCH_DUP_BOX',
        source_type: 'warehouse', source_name: 'CentralCold',
        target_type: 'store', target_name: 'XichengStore',
        boxes: [ { box_no: 'BOX001', temperature: -18, seal_no: 'SEAL000001' } ]
      },
      false
    );

    await print(
      'E2 重复批次号（应失败）',
      'POST', '/api/batches/import',
      { 'x-operator': 'Wang', 'x-role': 'staff' },
      {
        batch_no: 'BATCH20260613001',
        source_type: 'warehouse', source_name: 'CentralCold',
        target_type: 'store', target_name: 'XichengStore',
        boxes: [ { box_no: 'BOX_NEW', temperature: -18, seal_no: 'SEAL999999' } ]
      },
      false
    );

    await print(
      'E3 对已签收批次再签收（应失败）',
      'POST', '/api/batches/BATCH20260613001/sign',
      { 'x-operator': 'Liu', 'x-role': 'staff' },
      { boxes_sign: [ { box_no: 'BOX001', sign_temperature: -17, sign_seal_no: 'SEAL000001' } ] },
      false
    );

    await print(
      'E4 温度格式中文（应失败）',
      'POST', '/api/batches/import',
      { 'x-operator': 'Wang', 'x-role': 'staff' },
      {
        batch_no: 'BATCH_BAD_TEMP',
        source_type: 'warehouse', source_name: 'CentralCold',
        target_type: 'store', target_name: 'DongchengStore',
        boxes: [ { box_no: 'BOX_BAD', temperature: 'lingxia18', seal_no: 'SEAL111111' } ]
      },
      false
    );

    await print(
      'E5 温度超阈值 5C（应失败）',
      'POST', '/api/batches/import',
      { 'x-operator': 'Wang', 'x-role': 'staff' },
      {
        batch_no: 'BATCH_OVER_TEMP',
        source_type: 'warehouse', source_name: 'CentralCold',
        target_type: 'store', target_name: 'DongchengStore',
        boxes: [ { box_no: 'BOX_OVER', temperature: 5, seal_no: 'SEAL222222' } ]
      },
      false
    );

    await print(
      'E6 封签格式 ABC123（应失败）',
      'POST', '/api/batches/import',
      { 'x-operator': 'Wang', 'x-role': 'staff' },
      {
        batch_no: 'BATCH_BAD_SEAL',
        source_type: 'warehouse', source_name: 'CentralCold',
        target_type: 'store', target_name: 'DongchengStore',
        boxes: [ { box_no: 'BOX_SEAL', temperature: -18, seal_no: 'ABC123' } ]
      },
      false
    );

    await print('E7 验证重复箱号的批次确实未创建', 'GET', '/api/batches/BATCH_DUP_BOX', {}, null, false);
    await print('E8 验证温度异常的批次确实未创建', 'GET', '/api/batches/BATCH_BAD_TEMP', {}, null, false);

    // ========== 持久化验证 ==========
    console.log('\n========== 持久化验证：当前批次汇总 ==========');
    const list = await request('GET', '/api/batches');
    console.log('批次数量:', list.body.total);
    for (const b of list.body.data) {
      console.log(`  ${b.batch_no}  status=${b.status}(${b.status_label})  ${b.source_name}→${b.target_name}`);
    }

    console.log('\n========== 所有测试步骤执行完毕 ==========');
  } catch (e) {
    console.error('脚本出错:', e);
  }
}

main();
