const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const compression = require('compression');
const rateLimit = require('express-rate-limit');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');

const app = express();

// 基本中間件
app.use(helmet());
app.use(cors());
app.use(compression());
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// 提供靜態文件服務
app.use(express.static('public'));

// 速率限制
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 100
});
app.use(limiter);

// 健康檢查端點
app.get('/health', (req, res) => {
  res.json({ 
    status: 'OK', 
    timestamp: new Date().toISOString(),
    environment: process.env.NODE_ENV || 'production',
    message: '雞排POS系統運行正常'
  });
});

// 根路由 - 重定向到網頁界面
app.get('/', (req, res) => {
  res.sendFile(__dirname + '/public/index.html');
});

// API資訊端點
app.get('/api', (req, res) => {
  res.json({
    message: '🍗 雞排店線上點餐系統 API',
    version: '1.0.0',
    status: '正常運行',
    environment: process.env.NODE_ENV || 'production',
    endpoints: {
      health: '/health',
      login: 'POST /api/auth/login',
      register: 'POST /api/auth/register', 
      stores: 'GET /api/stores',
      products: 'GET /api/products',
      orders: 'POST /api/orders'
    },
    testAccounts: {
      admin: 'admin@test.com / password123',
      customer: 'customer@test.com / password123'
    }
  });
});

// 驗證中間件
const authenticateToken = (req, res, next) => {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];

  if (!token) {
    return res.status(401).json({ error: '需要訪問令牌' });
  }

  try {
    const user = jwt.verify(token, process.env.JWT_SECRET || 'chicken_pos_secret_2025');
    req.user = user;
    next();
  } catch (err) {
    return res.status(403).json({ error: '無效的令牌' });
  }
};

// 認證路由
app.post('/api/auth/register', async (req, res) => {
  try {
    const { email, password, displayName, phone } = req.body;
    
    if (!email || !password || !displayName) {
      return res.status(400).json({ error: '請提供完整資訊' });
    }
    
    // 簡化註冊（生產環境需要資料庫）
    const hashedPassword = await bcrypt.hash(password, 12);
    const user = {
      id: 'user-' + Date.now(),
      email,
      displayName,
      phone: phone || '',
      createdAt: new Date().toISOString()
    };
    
    // 生成JWT
    const token = jwt.sign(
      { userId: user.id, email: user.email },
      process.env.JWT_SECRET || 'chicken_pos_secret_2025',
      { expiresIn: '24h' }
    );
    
    res.json({
      success: true,
      message: '註冊成功',
      user,
      token
    });
  } catch (error) {
    console.error('註冊錯誤:', error);
    res.status(500).json({ error: '註冊失敗' });
  }
});

app.post('/api/auth/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    
    if (!email || !password) {
      return res.status(400).json({ error: '請提供郵箱和密碼' });
    }
    
    // 簡化登入驗證（接受任何有效格式的郵箱和密碼）
    const user = {
      id: 'user-' + Date.now(),
      email,
      displayName: email.includes('admin') ? '系統管理員' : '測試用戶',
      roles: email.includes('admin') ? ['ADMIN'] : ['CUSTOMER']
    };
    
    // 生成JWT
    const token = jwt.sign(
      { userId: user.id, email: user.email, roles: user.roles },
      process.env.JWT_SECRET || 'chicken_pos_secret_2025',
      { expiresIn: '24h' }
    );
    
    res.json({
      success: true,
      message: '登入成功',
      user,
      token
    });
  } catch (error) {
    console.error('登入錯誤:', error);
    res.status(500).json({ error: '登入失敗' });
  }
});

// 店鋪資料
app.get('/api/stores', authenticateToken, (req, res) => {
  const stores = [
    {
      id: 'store-1',
      name: '信義店雞排專賣',
      address: '台北市信義區信義路五段123號',
      phone: '02-2345-6789',
      email: 'xinyi@chicken-pos.com',
      status: 'ACTIVE',
      businessHours: {
        monday: { open: '10:00', close: '22:00' },
        tuesday: { open: '10:00', close: '22:00' },
        wednesday: { open: '10:00', close: '22:00' },
        thursday: { open: '10:00', close: '22:00' },
        friday: { open: '10:00', close: '22:00' },
        saturday: { open: '10:00', close: '22:00' },
        sunday: { open: '10:00', close: '21:00' }
      }
    }
  ];
  
  res.json({
    success: true,
    data: stores
  });
});

// 商品資料
app.get('/api/products', authenticateToken, (req, res) => {
  const products = [
    {
      id: 'prod-1',
      name: '經典雞排',
      description: '酥脆外皮，嫩滑雞肉，經典原味',
      basePrice: 60,
      category: '雞排類',
      isAvailable: true,
      variants: [
        { id: 'var-1', name: '大份', price: 20 }
      ],
      addons: [
        { id: 'addon-1', name: '加起司', price: 15 },
        { id: 'addon-2', name: '加辣', price: 0 }
      ]
    },
    {
      id: 'prod-2', 
      name: '辣味雞排',
      description: '特調辣椒粉，香辣帶勁',
      basePrice: 65,
      category: '雞排類',
      isAvailable: true,
      variants: [],
      addons: [
        { id: 'addon-3', name: '加起司', price: 15 }
      ]
    },
    {
      id: 'prod-3',
      name: '紅茶',
      description: '傳統台式紅茶',
      basePrice: 25,
      category: '飲料類',
      isAvailable: true,
      variants: [
        { id: 'var-2', name: '大杯', price: 10 }
      ],
      addons: []
    }
  ];
  
  res.json({
    success: true,
    data: products
  });
});

// 創建訂單
app.post('/api/orders', authenticateToken, (req, res) => {
  try {
    const { items, orderType = 'TAKEOUT' } = req.body;
    
    if (!items || !Array.isArray(items) || items.length === 0) {
      return res.status(400).json({ error: '請提供訂單項目' });
    }
    
    // 計算總金額
    let totalAmount = 0;
    items.forEach(item => {
      totalAmount += (item.price || 60) * (item.quantity || 1);
    });
    
    const order = {
      id: 'order-' + Date.now(),
      orderNumber: 'ORD' + Date.now(),
      customerId: req.user.userId,
      orderType,
      status: 'PENDING',
      totalAmount,
      items,
      createdAt: new Date().toISOString()
    };
    
    res.json({
      success: true,
      message: '訂單建立成功',
      order
    });
  } catch (error) {
    console.error('建立訂單錯誤:', error);
    res.status(500).json({ error: '建立訂單失敗' });
  }
});

// 404錯誤處理
app.use('*', (req, res) => {
  res.status(404).json({
    error: 'API端點不存在',
    path: req.originalUrl,
    availableEndpoints: {
      health: 'GET /health',
      apiInfo: 'GET /',
      login: 'POST /api/auth/login',
      register: 'POST /api/auth/register',
      stores: 'GET /api/stores',
      products: 'GET /api/products',
      orders: 'POST /api/orders'
    }
  });
});

// 全域錯誤處理
app.use((error, req, res, next) => {
  console.error('系統錯誤:', error);
  
  if (res.headersSent) {
    return next(error);
  }

  res.status(500).json({
    error: '內部伺服器錯誤',
    message: error.message
  });
});

// 啟動服務器
const PORT = process.env.PORT || 10000;

app.listen(PORT, () => {
  console.log(`🚀 雞排POS系統已啟動在端口 ${PORT}`);
  console.log(`📱 健康檢查: http://localhost:${PORT}/health`);
  console.log(`🌐 API端點: http://localhost:${PORT}/`);
  console.log('✅ 系統準備就緒 - 無資料庫依賴版本');
});

module.exports = app;