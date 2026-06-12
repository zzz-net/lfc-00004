const model = require('../models/dataModel');

const VALID_ROLES = ['staff', 'supervisor'];

function requireAuth(req, res, next) {
  const operator = req.headers['x-operator'];
  const role = req.headers['x-role'];

  if (!operator) {
    return res.status(401).json({
      error: {
        code: 'MISSING_OPERATOR',
        message: '缺少操作人信息，请在请求头中设置 x-operator'
      }
    });
  }

  if (!role || !VALID_ROLES.includes(role)) {
    return res.status(401).json({
      error: {
        code: 'INVALID_ROLE',
        message: `缺少或无效的角色信息，请在请求头中设置 x-role 为 ${VALID_ROLES.join(' / ')}`
      }
    });
  }

  req.operator = operator;
  req.role = role;
  next();
}

function validateTemperature(value) {
  if (value === undefined || value === null || value === '') return { valid: true };
  const num = Number(value);
  if (Number.isNaN(num)) {
    return { valid: false, error: `温度值 "${value}" 格式不合法，必须是数字` };
  }
  const configs = model.getConfigs();
  const tempMin = parseFloat(configs.temp_min.value);
  const tempMax = parseFloat(configs.temp_max.value);
  if (num < tempMin || num > tempMax) {
    return {
      valid: false,
      error: `温度 ${num}°C 超出允许范围 [${tempMin}°C, ${tempMax}°C]`
    };
  }
  return { valid: true, value: num };
}

function validateSealNo(value) {
  if (!value) return { valid: true };
  const configs = model.getConfigs();
  const pattern = new RegExp(configs.seal_pattern.value);
  if (!pattern.test(value)) {
    return {
      valid: false,
      error: `封签号 "${value}" 格式不合法，需匹配正则：${configs.seal_pattern.value}`
    };
  }
  return { valid: true };
}

function validateTimeout(outboundTime) {
  if (!outboundTime) return { valid: true };
  const configs = model.getConfigs();
  const hours = parseFloat(configs.timeout_hours.value);
  const outbound = new Date(outboundTime).getTime();
  const now = Date.now();
  const diffHours = (now - outbound) / (1000 * 60 * 60);
  if (diffHours > hours) {
    return {
      valid: false,
      error: `已超时时长 ${diffHours.toFixed(2)} 小时，超过阈值 ${hours} 小时`
    };
  }
  return { valid: true };
}

module.exports = {
  requireAuth,
  validateTemperature,
  validateSealNo,
  validateTimeout
};
