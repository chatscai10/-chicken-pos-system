const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const compression = require('compression');
const rateLimit = require('express-rate-limit');
const { PrismaClient } = require('@prisma/client');
const dotenv = require('dotenv');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');

// 載入環境變數
dotenv.config();

const app = express();
const prisma = new PrismaClient();

// 基本中間件
app.use(helmet());
app.use(cors());
app.use(compression());
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

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
    environment: process.env.NODE_ENV 
  });
});

// 根路由
app.get('/', (req, res) => {
  res.json({
    message: '雞排店線上點餐系統 API - 雲端版',
    version: '1.0.0',
    environment: process.env.NODE_ENV,
    endpoints: {
      health: '/health',
      login: '/api/auth/login',
      register: '/api/auth/register',
      stores: '/api/stores',
      products: '/api/products',
      orders: '/api/orders'
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

  jwt.verify(token, process.env.JWT_SECRET || 'default_secret', (err, user) => {
    if (err) {
      return res.status(403).json({ error: '無效的令牌' });
    }
    req.user = user;
    next();
  });
};

// 簡化的認證路由
app.post('/api/auth/register', async (req, res) => {
  try {
    const { email, password, displayName, phone } = req.body;
    
    // 建立新用戶 (簡化版，不檢查重複)
    const hashedPassword = await bcrypt.hash(password, 12);
    const user = {
      id: 'user-' + Date.now(),
      email,
      displayName,
      phone
    };
    
    // 生成JWT
    const token = jwt.sign(
      { userId: user.id, email: user.email },
      process.env.JWT_SECRET || 'default_secret',
      { expiresIn: '24h' }
    );
    
    res.json({
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
    
    // 簡化登入驗證
    if (email && password) {
      const user = {
        id: 'user-' + Date.now(),
        email,
        displayName: '測試用戶'
      };
      
      // 生成JWT
      const token = jwt.sign(
        { userId: user.id, email: user.email },
        process.env.JWT_SECRET || 'default_secret',
        { expiresIn: '24h' }
      );
      
      res.json({
        message: '登入成功',
        user,
        token
      });
    } else {
      res.status(401).json({ error: '請提供郵箱和密碼' });
    }
  } catch (error) {
    console.error('登入錯誤:', error);
    res.status(500).json({ error: '登入失敗' });
  }
});

// 測試數據端點
app.get('/api/stores', authenticateToken, async (req, res) => {
  try {
    const stores = [
      {
        id: 'store-1',
        name: '信義店雞排專賣',
        address: '台北市信義區信義路五段123號',
        phone: '02-2345-6789',
        status: 'ACTIVE'
      }
    ];
    
    res.json({
      success: true,
      data: stores
    });
  } catch (error) {
    console.error('獲取店鋪錯誤:', error);
    res.status(500).json({ error: '獲取店鋪失敗' });
  }
});

app.get('/api/products', authenticateToken, async (req, res) => {
  try {
    const products = [
      {
        id: 'prod-1',
        name: '經典雞排',
        price: 60,
        description: '酥脆外皮，嫩滑雞肉'
      },
      {
        id: 'prod-2', 
        name: '辣味雞排',
        price: 65,
        description: '特調辣椒粉，香辣帶勁'
      }
    ];
    
    res.json({
      success: true,
      data: products
    });
  } catch (error) {
    console.error('獲取商品錯誤:', error);
    res.status(500).json({ error: '獲取商品失敗' });
  }
});

// 404錯誤處理
app.use('*', (req, res) => {
  res.status(404).json({
    error: 'Resource not found',
    path: req.originalUrl,
  });
});

// 全域錯誤處理
app.use((error, req, res, next) => {
  console.error('錯誤:', error);
  
  if (res.headersSent) {
    return next(error);
  }

  const statusCode = error.statusCode || 500;
  const message = error.message || '內部伺服器錯誤';

  res.status(statusCode).json({
    error: message
  });
});

// 啟動服務器
const PORT = process.env.PORT || 10000;

app.listen(PORT, () => {
  console.log(`🚀 雞排POS系統已啟動在端口 ${PORT}`);
  console.log(`📱 健康檢查: http://localhost:${PORT}/health`);
  console.log('✅ 系統準備就緒');
});

module.exports = app;