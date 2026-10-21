const express = require('express');
const cors = require('cors');
const session = require('express-session');
const path = require('path');
const fs = require('fs');
const db = require('./database');

const app = express();
const PORT = process.env.PORT || 8080;
const IS_PRODUCTION = process.env.NODE_ENV === 'production';

// 北京时间工具函数（与前端保持一致）
function createBJDate(dateStr) {
    if (!dateStr) return null;
    const [year, month, day] = dateStr.split('-').map(Number);
    // 创建UTC时间表示北京时间 dateStr 00:00:00
    return new Date(Date.UTC(year, month - 1, day, -8, 0, 0));
}

function getBJToday() {
    const now = new Date();
    // 获取当前UTC时间，转换为北京时间
    const bjTime = new Date(now.getTime() + 8 * 60 * 60 * 1000);
    const year = bjTime.getUTCFullYear();
    const month = bjTime.getUTCMonth();
    const day = bjTime.getUTCDate();
    // 返回北京时间今天 00:00:00 的 UTC 时间
    return new Date(Date.UTC(year, month, day, -8, 0, 0));
}

// createBJDate/getBJToday 构造的是"北京零点"（UTC 为前一天 16:00），
// 格式化必须先加 8 小时偏移，否则返回的日期会比北京日期少一天。
function formatBJDate(date) {
    if (!date) return '';
    const bjTime = new Date(date.getTime() + 8 * 60 * 60 * 1000);
    const year = bjTime.getUTCFullYear();
    const month = String(bjTime.getUTCMonth() + 1).padStart(2, '0');
    const day = String(bjTime.getUTCDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
}
	
	
// 校验日期字符串是否为合法的 YYYY-MM-DD
function isValidDateStr(dateStr) {
    if (typeof dateStr !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) return false;
    const [y, m, d] = dateStr.split('-').map(Number);
    if (m < 1 || m > 12 || d < 1 || d > 31) return false;
    const dt = new Date(Date.UTC(y, m - 1, d));
    return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
}

// 将数据库/系统原生英文异常统一转换为中文提示
function toChineseError(error, fallback = '服务器内部错误，请稍后重试') {
  const msg = error && error.message ? String(error.message) : '';
  if (!msg) return fallback;
  if (/SQLITE_CONSTRAINT UNIQUE/i.test(msg)) return '数据已存在，请勿重复提交';
  if (/SQLITE_CONSTRAINT NOT NULL/i.test(msg)) return '缺少必要字段，请完整填写后重试';
  if (/SQLITE_CONSTRAINT FOREIGN KEY/i.test(msg)) return '关联数据不存在，请刷新后重试';
  if (/SQLITE_CONSTRAINT/i.test(msg)) return '数据不符合约束条件，请检查后重试';
  if (/SQLITE_BUSY|database is locked/i.test(msg)) return '系统繁忙，请稍后重试';
  if (/SQLITE_CORRUPT|database disk image/i.test(msg)) return '数据库异常，请联系管理员';
  if (/no such table/i.test(msg)) return '数据表缺失，请联系管理员';
  if (/Cannot read properties of (undefined|null)/i.test(msg)) return '提交的数据不完整，请重新操作';
  if (/Unexpected token|JSON/i.test(msg)) return '请求数据格式错误';
  if (/timeout|ETIMEDOUT|ECONNRESET/i.test(msg)) return '请求超时，请稍后重试';
  return fallback;
}

function calculateRemainingDaysBJ(productionDateStr, shelfLife) {
    const prodDate = createBJDate(productionDateStr);
    if (!prodDate) return 0;
    const expiryDate = new Date(prodDate);
    expiryDate.setUTCDate(prodDate.getUTCDate() + shelfLife);
    const today = getBJToday();
    const diffTime = expiryDate.getTime() - today.getTime();
    return Math.ceil(diffTime / (1000 * 60 * 60 * 24));
}

// 仅在非 Zeabur 环境下使用额外的安全中间件
if (!process.env.ZEABUR && IS_PRODUCTION) {
  try {
    const rateLimit = require('express-rate-limit');
    const helmet = require('helmet');
    app.use(helmet({
      contentSecurityPolicy: false,
    }));
    
    const limiter = rateLimit({
      windowMs: 15 * 60 * 1000,
      max: 200,
      message: { error: '请求过于频繁，请稍后再试' },
    });
    app.use('/api/', limiter);
  } catch (e) {
    console.log('⚠️ 安全中间件加载跳过');
  }
}

app.use(cors({ origin: true, credentials: true }));
app.use(express.json({ limit: '60mb' }));
app.use(express.urlencoded({ extended: true, limit: '60mb' }));

// 静态文件服务
app.use(express.static(path.join(__dirname, '.')));

// 会话配置 - 30天有效期
const sessionConfig = {
  secret: process.env.SESSION_SECRET || 'product-expiration-secret-key-v2',
  resave: false,
  saveUninitialized: false,
  cookie: {
    secure: IS_PRODUCTION && process.env.HTTPS === 'true',
    maxAge: 30 * 24 * 60 * 60 * 1000,
    httpOnly: true,
    sameSite: 'lax'
  },
  rolling: true,
  name: 'sessionId',
  proxy: true
};

app.use(session(sessionConfig));

// 请求日志中间件
app.use((req, res, next) => {
  if (!IS_PRODUCTION && req.url !== '/favicon.ico' && !req.url.startsWith('/api/auth/check')) {
    console.log(`📨 ${new Date().toISOString().slice(0, 19)} ${req.method} ${req.url}`);
  }
  next();
});

// 健康检查端点
app.get('/health', (req, res) => {
  res.status(200).json({ status: 'ok', timestamp: new Date().toISOString() });
});

app.get('/api/health', (req, res) => {
  res.status(200).json({ status: 'ok', timestamp: new Date().toISOString() });
});

// 获取客户端IP
const getClientIp = (req) => {
  return req.headers['x-forwarded-for']?.split(',')[0] || req.socket.remoteAddress || req.ip;
};

// 认证中间件
const authenticate = (req, res, next) => {
  if (!req.session.userId) {
    return res.status(401).json({ error: '未授权，请先登录' });
  }
  next();
};

const authenticateAdmin = async (req, res, next) => {
  if (!req.session.userId) {
    return res.status(401).json({ error: '未授权，请先登录' });
  }
  const user = await db.getUserById(req.session.userId);
  if (!user || user.role !== 'admin') {
    return res.status(403).json({ error: '需要管理员权限' });
  }
  next();
};

// ========== 认证相关API ==========
app.post('/api/auth/register', async (req, res) => {
  try {
    const { username, password, email, authCode } = req.body;
    
    if (!username || !password) {
      return res.status(400).json({ error: '用户名和密码不能为空' });
    }
    if (!authCode) {
      return res.status(400).json({ error: '请输入授权码' });
    }
    if (username.length < 3 || username.length > 20) {
      return res.status(400).json({ error: '用户名长度应在3-20字符之间' });
    }
    if (password.length < 6) {
      return res.status(400).json({ error: '密码长度不能少于6位' });
    }
    
    const result = await db.createUser(username, password, email || '', authCode);
    
    if (!result.success) {
      return res.status(409).json({ error: result.error });
    }
    
    res.json({ success: true, message: '注册成功', userId: result.id });
  } catch (error) {
    console.error('注册错误:', error);
    res.status(500).json({ error: '注册失败' });
  }
});

app.post('/api/auth/login', async (req, res) => {
  try {
    const { username, password } = req.body;
    if (!username || !password) {
      return res.status(400).json({ error: '用户名和密码不能为空' });
    }
    
    const result = await db.authenticateUser(username, password, getClientIp(req));
    
    if (!result.success) {
      return res.status(401).json({ error: result.error });
    }
    
    req.session.userId = result.user.id;
    req.session.username = result.user.username;
    req.session.role = result.user.role;
    req.session.loginTime = new Date();
    
    let expiryWarning = null;
    if (result.user.valid_until) {
      const validUntil = new Date(result.user.valid_until);
      const daysRemaining = Math.ceil((validUntil - new Date()) / (1000 * 60 * 60 * 24));
      if (daysRemaining <= 30 && daysRemaining > 0) {
        expiryWarning = `您的账号将在 ${daysRemaining} 天后过期，请联系管理员续期`;
      } else if (daysRemaining <= 0) {
        expiryWarning = `您的账号已过期，请联系管理员续期`;
      }
    }
    
    res.json({ 
      success: true, 
      message: '登录成功',
      user: { ...result.user, expiryWarning }
    });
  } catch (error) {
    console.error('登录错误:', error);
    res.status(500).json({ error: '登录失败' });
  }
});

app.post('/api/auth/logout', (req, res) => {
  req.session.destroy((err) => {
    res.json({ success: true, message: '已登出' });
  });
});

app.post('/api/auth/extend', authenticate, (req, res) => {
  req.session.touch();
  res.json({ success: true, message: '会话已延长' });
});

app.get('/api/auth/check', async (req, res) => {
  res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Expires', '0');
  
  // Express 4 不会自动捕获 async handler 抛出的异常。若此处不兜底，任何异常都会
  // 导致请求返回非 JSON，前端 checkAuth 的 response.json() 抛错，进而误判为未登录
  // 并隐藏整个主界面（含导航菜单）。故用 try/catch 保证始终返回结构合法的 JSON。
  try {
  if (req.session.userId) {
    const user = await db.getUserById(req.session.userId);
    if (!user) {
      req.session.destroy();
      return res.json({ isLoggedIn: false });
    }
    let expiryWarning = null;
    if (user && user.valid_until) {
      const validUntil = new Date(user.valid_until);
      const daysRemaining = Math.ceil((validUntil - new Date()) / (1000 * 60 * 60 * 24));
      if (daysRemaining <= 30 && daysRemaining > 0) {
        expiryWarning = `您的账号将在 ${daysRemaining} 天后过期`;
      } else if (daysRemaining <= 0) {
        expiryWarning = `您的账号已过期，请联系管理员续期`;
      }
    }
    res.json({ 
      isLoggedIn: true, 
      user: { 
        id: req.session.userId, 
        username: req.session.username, 
        role: req.session.role, 
        expiryWarning 
      },
      loginTime: req.session.loginTime
    });
  } else {
    res.json({ isLoggedIn: false });
  }
  } catch (error) {
    console.error('鉴权检查错误:', error);
    res.status(200).json({ isLoggedIn: false, error: toChineseError(error, '登录状态校验失败，请重新登录') });
  }
});

// ========== 管理员API ==========
app.get('/api/admin/users', authenticateAdmin, async (req, res) => {
  try {
    const users = await db.getAllUsers();
    res.json(users);
  } catch (error) {
    console.error('获取用户列表错误:', error);
    res.status(500).json({ error: toChineseError(error) });
  }
});

app.post('/api/admin/users/:userId/reset-password', authenticateAdmin, async (req, res) => {
  try {
    const { userId } = req.params;
    const { newPassword } = req.body;
    
    if (!newPassword || newPassword.length < 6) {
      return res.status(400).json({ error: '新密码长度不能少于6位' });
    }
    
    const user = await db.getUserById(userId);
    if (!user) {
      return res.status(404).json({ error: '用户不存在' });
    }
    
    await db.resetUserPassword(userId, newPassword);
    await db.addAdminLog(req.session.userId, req.session.username, 'reset_password', user.username, `重置密码`, getClientIp(req));
    
    res.json({ success: true, message: `已重置用户 ${user.username} 的密码` });
  } catch (error) {
    console.error('重置密码错误:', error);
    res.status(500).json({ error: toChineseError(error) });
  }
});

app.post('/api/admin/users/:userId/validity', authenticateAdmin, async (req, res) => {
  try {
    const { userId } = req.params;
    const { validUntil } = req.body;
    
    if (!validUntil) {
      return res.status(400).json({ error: '请指定有效期' });
    }
    
    const user = await db.getUserById(userId);
    if (!user) {
      return res.status(404).json({ error: '用户不存在' });
    }
    
    await db.updateUserValidity(userId, validUntil);
    await db.addAdminLog(req.session.userId, req.session.username, 'update_validity', user.username, `更新有效期至 ${validUntil}`, getClientIp(req));
    
    res.json({ success: true, message: `已更新用户 ${user.username} 的有效期` });
  } catch (error) {
    console.error('更新有效期错误:', error);
    res.status(500).json({ error: toChineseError(error) });
  }
});

app.delete('/api/admin/users/:userId', authenticateAdmin, async (req, res) => {
  try {
    const { userId } = req.params;
    
    if (parseInt(userId) === req.session.userId) {
      return res.status(400).json({ error: '不能删除自己的账户' });
    }
    
    const user = await db.getUserById(userId);
    if (!user) {
      return res.status(404).json({ error: '用户不存在' });
    }
    
    if (user.role === 'admin') {
      return res.status(403).json({ error: '不能删除管理员账户' });
    }
    
    await db.deleteUser(userId);
    await db.addAdminLog(req.session.userId, req.session.username, 'delete_user', user.username, `删除用户`, getClientIp(req));
    
    res.json({ success: true, message: `已删除用户 ${user.username}` });
  } catch (error) {
    console.error('删除用户错误:', error);
    res.status(500).json({ error: toChineseError(error) });
  }
});

// ========== 授权码管理API ==========
app.get('/api/admin/auth-codes', authenticateAdmin, async (req, res) => {
  try {
    const codes = await db.getAllAuthCodes();
    res.json(codes);
  } catch (error) {
    console.error('获取授权码列表错误:', error);
    res.status(500).json({ error: toChineseError(error) });
  }
});

app.post('/api/admin/auth-codes', authenticateAdmin, async (req, res) => {
  try {
    const { validUntil } = req.body;
    if (!validUntil) {
      return res.status(400).json({ error: '请指定有效期' });
    }
    
    const code = await db.createAuthCode(req.session.userId, validUntil);
    await db.addAdminLog(req.session.userId, req.session.username, 'create_auth_code', null, `创建授权码: ${code} 有效期至 ${validUntil}`, getClientIp(req));
    
    res.json({ success: true, code, validUntil });
  } catch (error) {
    console.error('生成授权码错误:', error);
    res.status(500).json({ error: toChineseError(error) });
  }
});

app.put('/api/admin/auth-codes/:codeId', authenticateAdmin, async (req, res) => {
  try {
    const { codeId } = req.params;
    const { validUntil, status } = req.body;
    
    await db.updateAuthCode(codeId, validUntil, status);
    await db.addAdminLog(req.session.userId, req.session.username, 'update_auth_code', null, `更新授权码ID: ${codeId}`, getClientIp(req));
    
    res.json({ success: true });
  } catch (error) {
    console.error('更新授权码错误:', error);
    res.status(500).json({ error: toChineseError(error) });
  }
});

app.delete('/api/admin/auth-codes/:codeId', authenticateAdmin, async (req, res) => {
  try {
    const { codeId } = req.params;
    await db.deleteAuthCode(codeId);
    res.json({ success: true });
  } catch (error) {
    console.error('删除授权码错误:', error);
    res.status(500).json({ error: toChineseError(error) });
  }
});

// 验证用户密码
app.post('/api/user/verify-password', authenticate, async (req, res) => {
  try {
    const { password } = req.body;
    
    if (!password) {
      return res.status(400).json({ error: '请输入密码' });
    }
    
    const user = await new Promise((resolve, reject) => {
      db.db.get('SELECT * FROM users WHERE id = ?', [req.session.userId], (err, row) => {
        if (err) reject(err);
        else resolve(row);
      });
    });
    
    if (!user) {
      return res.status(404).json({ error: '用户不存在' });
    }
    
    const bcrypt = require('bcryptjs');
    const isValid = bcrypt.compareSync(password, user.password);
    
    if (!isValid) {
      return res.status(401).json({ valid: false, error: '密码错误' });
    }
    
    res.json({ valid: true });
  } catch (error) {
    console.error('密码验证错误:', error);
    res.status(500).json({ error: toChineseError(error) });
  }
});

// 用户修改自己的密码
app.post('/api/user/change-password', authenticate, async (req, res) => {
  try {
    const { oldPassword, newPassword } = req.body;
    
    if (!oldPassword || !newPassword) {
      return res.status(400).json({ error: '请填写完整信息' });
    }
    if (newPassword.length < 6) {
      return res.status(400).json({ error: '新密码长度至少6位' });
    }
    
    const user = await new Promise((resolve, reject) => {
      db.db.get('SELECT * FROM users WHERE id = ?', [req.session.userId], (err, row) => {
        if (err) reject(err);
        else resolve(row);
      });
    });
    
    if (!user) {
      return res.status(404).json({ error: '用户不存在' });
    }
    
    const bcrypt = require('bcryptjs');
    const isValid = bcrypt.compareSync(oldPassword, user.password);
    if (!isValid) {
      return res.status(401).json({ error: '当前密码错误' });
    }
    
    const hashedPassword = bcrypt.hashSync(newPassword, 10);
    await db.run('UPDATE users SET password = ? WHERE id = ?', [hashedPassword, req.session.userId]);
    
    res.json({ success: true, message: '密码修改成功，请重新登录' });
  } catch (error) {
    console.error('修改密码错误:', error);
    res.status(500).json({ error: toChineseError(error) });
  }
});

// ========== 导入导出API ==========
const MAX_IMPORT_PRODUCTS = 5000;
const MAX_IMPORT_RECORDS = 20000;
const MAX_IMPORT_IMAGES = 2000;

// 图片API端点
app.get('/api/images/:sku', authenticate, async (req, res) => {
  try {
    const { sku } = req.params;
    const image = await db.get('SELECT * FROM product_images WHERE sku = ?', [sku]);
    if (image && image.image_data) {
      res.json({
        image_data: image.image_data,
        image_mime: image.image_mime
      });
    } else {
      // 图片不存在时返回空数据，避免触发前端错误弹窗
      res.json({
        image_data: null,
        image_mime: null
      });
    }
  } catch (error) {
    console.error('获取图片错误:', error);
    res.status(500).json({ error: toChineseError(error) });
  }
});

// 图片上传端点
app.put('/api/images/:sku', authenticate, async (req, res) => {
  try {
    const { sku } = req.params;
    const { image_data, image_mime } = req.body;
    
    if (!image_data || !image_mime) {
      return res.status(400).json({ error: '图片数据不能为空' });
    }

    // 权限检查
    if (req.session.role !== 'admin') {
      // 普通用户：检查SKU是否已存在于自己的商品库中
      const existingProduct = await db.get('SELECT id FROM products WHERE user_id = ? AND sku = ?', [req.session.userId, sku]);
      if (existingProduct) {
        return res.status(403).json({ error: '该SKU已存在商品，无法上传图片' });
      }
    }

    // 插入或更新图片（全局共享）
    await db.run(
      'INSERT OR REPLACE INTO product_images (sku, image_data, image_mime) VALUES (?, ?, ?)',
      [sku, image_data, image_mime]
    );

    res.json({ success: true, message: '图片上传成功' });
  } catch (error) {
    console.error('图片上传错误:', error);
    res.status(500).json({ error: toChineseError(error) });
  }
});

// 图片删除端点
app.delete('/api/images/:sku', authenticate, async (req, res) => {
  try {
    const { sku } = req.params;

    // 权限检查
    if (req.session.role !== 'admin') {
      // 普通用户：检查SKU是否已存在于自己的商品库中
      const existingProduct = await db.get('SELECT id FROM products WHERE user_id = ? AND sku = ?', [req.session.userId, sku]);
      if (existingProduct) {
        return res.status(403).json({ error: '该SKU已存在商品，无法删除图片' });
      }
    }

    // 删除图片（全局删除）
    // 幂等处理：该 SKU 本就无图片时（changes === 0）也返回成功，
    // 避免前端在编辑"无图片商品"时因 404 触发报错弹窗。
    await db.run('DELETE FROM product_images WHERE sku = ?', [sku]);

    res.json({ success: true, message: '图片删除成功' });
  } catch (error) {
    console.error('图片删除错误:', error);
    res.status(500).json({ error: toChineseError(error) });
  }
});

app.get('/api/export', authenticate, async (req, res) => {
  try {
    const data = await db.exportUserProducts(req.session.userId);
    res.setHeader('Content-Type', 'application/json');
    // 对中文用户名进行编码
    const encodedUsername = encodeURIComponent(req.session.username);
    res.setHeader('Content-Disposition', `attachment; filename=export_${encodedUsername}_${new Date().toISOString().split('T')[0]}.json`);
    res.json(data);
  } catch (error) {
    console.error('导出错误:', error);
    res.status(500).json({ error: toChineseError(error) });
  }
});

app.post('/api/import', authenticate, async (req, res) => {
  try {
    const { products, records, images = [] } = req.body;
    if (!products && !records && !(images && images.length)) {
      return res.status(400).json({ error: '没有可导入的数据' });
    }
    
    if (products && products.length > MAX_IMPORT_PRODUCTS) {
      return res.status(400).json({ error: `单次导入商品不能超过${MAX_IMPORT_PRODUCTS}个` });
    }
    if (records && records.length > MAX_IMPORT_RECORDS) {
      return res.status(400).json({ error: `单次导入库存记录不能超过${MAX_IMPORT_RECORDS}条` });
    }
    if (images && images.length > MAX_IMPORT_IMAGES) {
      return res.status(400).json({ error: `单次导入图片不能超过${MAX_IMPORT_IMAGES}张` });
    }
    
    if (products) {
      for (const product of products) {
        if (!product.sku || !product.name || !product.shelf_life || !product.reminder_days) {
          return res.status(400).json({ error: '导入数据格式错误：商品缺少必要字段' });
        }
        if (product.sku.length !== 5) {
          return res.status(400).json({ error: `SKU "${product.sku}" 必须为5位编码` });
        }
        if (product.shelf_life <= 0) {
          return res.status(400).json({ error: `商品 "${product.name}" 的保质期必须大于0` });
        }
        if (product.reminder_days > product.shelf_life) {
          return res.status(400).json({ error: `商品 "${product.name}" 的临期提醒天数不能大于保质期天数` });
        }
      }
    }
    
    const results = await db.importUserProducts(req.session.userId, products || [], records || [], images || []);
    await db.addAdminLog(req.session.userId, req.session.username, 'import_data', null, `导入数据: 商品${results.productsAdded}个, 库存${results.recordsAdded}条, 图片${results.imagesAdded}张`, getClientIp(req));
    
    res.json({ success: true, results });
  } catch (error) {
    console.error('导入错误:', error);
    res.status(500).json({ error: toChineseError(error) });
  }
});

app.get('/api/admin/logs', authenticateAdmin, async (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit) || 200, 500);
    const logs = await db.getAdminLogs(limit);
    res.json(logs);
  } catch (error) {
    console.error('获取日志错误:', error);
    res.status(500).json({ error: toChineseError(error) });
  }
});

// ========== 商品数据库API ==========
app.get('/api/products', authenticate, async (req, res) => {
  try {
    const products = await db.getAllProducts(req.session.userId);
    res.json(products);
  } catch (error) {
    console.error('获取商品列表错误:', error);
    res.status(500).json({ error: toChineseError(error) });
  }
});

app.get('/api/products/global/:sku', authenticate, async (req, res) => {
  try {
    const product = await db.getProductBySkuGlobal(req.params.sku);
    res.json(product || null);
  } catch (error) {
    console.error('获取全局商品错误:', error);
    res.status(500).json({ error: toChineseError(error) });
  }
});

app.get('/api/products/:sku', authenticate, async (req, res) => {
  try {
    const product = await db.getProductBySku(req.session.userId, req.params.sku);
    res.json(product || null);
  } catch (error) {
    console.error('获取商品错误:', error);
    res.status(500).json({ error: toChineseError(error) });
  }
});

app.post('/api/products', authenticate, async (req, res) => {
  try {
    const product = req.body;
    if (!product.sku || !product.name || !product.shelf_life || !product.reminder_days || !product.location) {
      return res.status(400).json({ error: '缺少必要字段' });
    }
    if (product.sku.length !== 5) {
      return res.status(400).json({ error: 'SKU必须为5位编码' });
    }
    if (product.shelf_life <= 0) {
      return res.status(400).json({ error: '保质期天数必须大于0' });
    }
    if (product.reminder_days < 0) {
      return res.status(400).json({ error: '临期提醒天数不能为负数' });
    }
    if (product.reminder_days > product.shelf_life) {
      return res.status(400).json({ error: '临期提醒天数不能大于保质期天数' });
    }
    
    const result = await db.addProduct(req.session.userId, product);
    res.json({ success: true, id: result.id, message: '商品已成功添加到数据库' });
  } catch (error) {
    if (error.code === 'SQLITE_CONSTRAINT') {
      return res.status(409).json({ error: `SKU "${req.body.sku}" 已存在` });
    }
    console.error('添加商品错误:', error);
    res.status(500).json({ error: toChineseError(error) });
  }
});

app.put('/api/products/:sku', authenticate, async (req, res) => {
  try {
    const product = req.body;
    // 原实现用 parseInt 比较，遇到 undefined 会得到 NaN，
    // 而 NaN > NaN 为 false，导致校验被整体跳过并把 NULL 写入 NOT NULL 字段。
    const missing = [];
    if (!product.name) missing.push('商品名称');
    if (product.shelf_life === undefined || product.shelf_life === null || product.shelf_life === '') missing.push('保质期天数');
    if (product.reminder_days === undefined || product.reminder_days === null || product.reminder_days === '') missing.push('临期提醒天数');
    if (!product.location) missing.push('库位');
    if (missing.length > 0) {
      return res.status(400).json({ error: `缺少必要字段：${missing.join('、')}` });
    }
    const shelfLifeNum = Number(product.shelf_life);
    const reminderNum = Number(product.reminder_days);
    if (!Number.isInteger(shelfLifeNum) || shelfLifeNum <= 0) {
      return res.status(400).json({ error: '保质期天数必须为大于0的整数' });
    }
    if (!Number.isInteger(reminderNum) || reminderNum < 0) {
      return res.status(400).json({ error: '临期提醒天数必须为不小于0的整数' });
    }
    if (reminderNum > shelfLifeNum) {
      return res.status(400).json({ error: '临期提醒天数不能大于保质期天数' });
    }
    const existing = await db.getProductBySku(req.session.userId, req.params.sku);
    if (!existing) {
      return res.status(404).json({ error: `SKU "${req.params.sku}" 不存在，无法更新` });
    }
    await db.updateProduct(req.session.userId, req.params.sku, product);
    res.json({ success: true });
  } catch (error) {
    console.error('更新商品错误:', error);
    res.status(500).json({ error: toChineseError(error) });
  }
});

app.delete('/api/products/:sku', authenticate, async (req, res) => {
  try {
    await db.deleteProduct(req.session.userId, req.params.sku);
    res.json({ success: true });
  } catch (error) {
    console.error('删除商品错误:', error);
    res.status(500).json({ error: toChineseError(error) });
  }
});

app.post('/api/images/:sku', authenticate, async (req, res) => {
  try {
    const { imageData, imageMime } = req.body;
    if (imageData && imageData.length > 7 * 1024 * 1024) {
      return res.status(400).json({ error: '图片过大，请压缩后上传' });
    }
    await db.saveProductImage(req.params.sku, imageData, imageMime);
    res.json({ success: true });
  } catch (error) {
    console.error('保存图片错误:', error);
    res.status(500).json({ error: toChineseError(error) });
  }
});

// ========== 库存记录API ==========
app.get('/api/records', authenticate, async (req, res) => {
  try {
    const records = await db.getAllProductRecords(req.session.userId);
    res.json(records);
  } catch (error) {
    console.error('获取库存记录错误:', error);
    res.status(500).json({ error: toChineseError(error) });
  }
});

app.get('/api/records/by-sku/:sku', authenticate, async (req, res) => {
  try {
    const records = await db.getRecordsBySku(req.session.userId, req.params.sku);
    res.json(records);
  } catch (error) {
    console.error('获取SKU记录错误:', error);
    res.status(500).json({ error: toChineseError(error) });
  }
});

app.get('/api/records/expiring', authenticate, async (req, res) => {
  try {
    const records = await db.getExpiringProducts(req.session.userId);
    const recordsWithDays = records.map(record => ({
      ...record,
      remaining_days: calculateRemainingDaysBJ(record.production_date, record.shelf_life)
    }));
    res.json(recordsWithDays);
  } catch (error) {
    console.error('获取临期商品错误:', error);
    res.status(500).json({ error: toChineseError(error) });
  }
});

app.post('/api/records', authenticate, async (req, res) => {
  try {
    const record = req.body;
    // 逐项校验并明确指出缺失字段，避免笼统的"缺少必要字段"
    const missing = [];
    if (!record.sku) missing.push('SKU编码');
    if (!record.name) missing.push('商品名称');
    if (!record.production_date) missing.push('生产日期');
    if (record.shelf_life === undefined || record.shelf_life === null || record.shelf_life === '') missing.push('保质期天数');
    if (record.reminder_days === undefined || record.reminder_days === null || record.reminder_days === '') missing.push('临期提醒天数');
    if (!record.location) missing.push('库位');
    if (missing.length > 0) {
      return res.status(400).json({ error: `缺少必要字段：${missing.join('、')}` });
    }
    if (String(record.sku).length !== 5) {
      return res.status(400).json({ error: 'SKU必须为5位编码' });
    }
    if (!isValidDateStr(String(record.production_date))) {
      return res.status(400).json({ error: '生产日期格式不正确，应为 YYYY-MM-DD' });
    }
    const shelfLifeNum = Number(record.shelf_life);
    const reminderNum = Number(record.reminder_days);
    if (!Number.isInteger(shelfLifeNum) || shelfLifeNum <= 0) {
      return res.status(400).json({ error: '保质期天数必须为大于0的整数' });
    }
    if (!Number.isInteger(reminderNum) || reminderNum < 0) {
      return res.status(400).json({ error: '临期提醒天数必须为不小于0的整数' });
    }
    if (reminderNum > shelfLifeNum) {
      return res.status(400).json({ error: '临期提醒天数不能大于保质期天数' });
    }
    if (createBJDate(String(record.production_date)) > getBJToday()) {
      return res.status(400).json({ error: '生产日期不能是未来日期' });
    }
    
    const result = await db.addProductRecord(req.session.userId, record);
    res.json({ success: true, id: result.id });
  } catch (error) {
    if (error.code === 'SQLITE_CONSTRAINT') {
      return res.status(409).json({ error: '相同SKU和生产日期的记录已存在' });
    }
    console.error('添加库存记录错误:', error);
    res.status(500).json({ error: toChineseError(error) });
  }
});

app.delete('/api/records/:sku/:productionDate', authenticate, async (req, res) => {
  try {
    await db.deleteProductRecord(req.session.userId, req.params.sku, req.params.productionDate);
    res.json({ success: true });
  } catch (error) {
    console.error('删除库存记录错误:', error);
    res.status(500).json({ error: toChineseError(error) });
  }
});

app.post('/api/reset', authenticate, async (req, res) => {
  try {
    const result = await db.resetUserData(req.session.userId);
    res.json({ success: true, message: result.message });
  } catch (error) {
    console.error('重置数据错误:', error);
    res.status(500).json({ error: toChineseError(error) });
  }
});

app.post('/api/clean-expired', authenticate, async (req, res) => {
  try {
    const result = await db.cleanExpiredRecords(req.session.userId);
    res.json({ success: true, message: '已清理过期记录', changes: result.changes });
  } catch (error) {
    console.error('清理过期记录错误:', error);
    res.status(500).json({ error: toChineseError(error) });
  }
});

// ========== 静态文件服务 - 必须放在最后 ==========
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

app.use(express.static(path.join(__dirname, '.')));

app.use((req, res) => {
  if (!req.path.startsWith('/api/')) {
    res.sendFile(path.join(__dirname, 'index.html'));
  } else {
    res.status(404).json({ error: `接口不存在：${req.method} ${req.path}` });
  }
});

app.use((err, req, res, next) => {
  console.error('服务器错误:', err);
  res.status(500).json({ error: '服务器内部错误' });
});

process.on('SIGINT', async () => {
  console.log('\n🛑 正在关闭服务器...');
  await db.close();
  process.exit(0);
});

process.on('SIGTERM', async () => {
  console.log('\n🛑 收到终止信号，正在关闭...');
  await db.close();
  process.exit(0);
});

const server = app.listen(PORT, '0.0.0.0', () => {
  console.log(`🚀 服务器运行在端口 ${PORT}`);
  console.log(`📱 访问地址: http://localhost:${PORT}`);
  console.log(`🔐 管理员: admin / admin123`);
  console.log(`🌍 环境: ${IS_PRODUCTION ? '生产' : '开发'}`);
});

module.exports = app;
