import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import compression from 'compression';
import rateLimit from 'express-rate-limit';
import { PrismaClient } from '@prisma/client';
import * as dotenv from 'dotenv';
import * as bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';

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
    message: '雞排店線上點餐系統 API - 測試版',
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
const authenticateToken = (req: any, res: any, next: any) => {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];

  if (!token) {
    return res.status(401).json({ error: '需要訪問令牌' });
  }

  jwt.verify(token, process.env.JWT_SECRET!, (err: any, user: any) => {
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
    
    // 檢查用戶是否已存在
    const existingUser = await prisma.user.findFirst({
      where: { email }
    });
    
    if (existingUser) {
      return res.status(400).json({ error: '用戶已存在' });
    }
    
    // 建立新用戶
    const hashedPassword = await bcrypt.hash(password, 12);
    const user = await prisma.user.create({
      data: {
        tenantId: 'test-tenant-id',
        email,
        password: hashedPassword,
        displayName,
        phone,
        status: 'ACTIVE'
      }
    });
    
    // 生成JWT
    const token = jwt.sign(
      { userId: user.id, email: user.email },
      process.env.JWT_SECRET!,
      { expiresIn: '24h' }
    );
    
    res.json({
      message: '註冊成功',
      user: {
        id: user.id,
        email: user.email,
        displayName: user.displayName
      },
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
    
    // 找到用戶
    const user = await prisma.user.findFirst({
      where: { email },
      include: {
        roles: {
          include: {
            role: true
          }
        }
      }
    });
    
    if (!user) {
      return res.status(401).json({ error: '用戶不存在' });
    }
    
    // 驗證密碼
    const isValidPassword = await bcrypt.compare(password, user.password);
    if (!isValidPassword) {
      return res.status(401).json({ error: '密碼錯誤' });
    }
    
    // 生成JWT
    const token = jwt.sign(
      { 
        userId: user.id, 
        email: user.email,
        tenantId: user.tenantId 
      },
      process.env.JWT_SECRET!,
      { expiresIn: '24h' }
    );
    
    res.json({
      message: '登入成功',
      user: {
        id: user.id,
        email: user.email,
        displayName: user.displayName,
        roles: user.roles.map(ur => ur.role.name)
      },
      token
    });
  } catch (error) {
    console.error('登入錯誤:', error);
    res.status(500).json({ error: '登入失敗' });
  }
});

// 簡化的店鋪路由
app.get('/api/stores', authenticateToken, async (req, res) => {
  try {
    const stores = await prisma.store.findMany({
      where: { tenantId: 'test-tenant-id' },
      include: {
        categories: {
          include: {
            products: {
              include: {
                variants: true,
                addons: true,
                inventory: true
              }
            }
          }
        }
      }
    });
    
    res.json({
      success: true,
      data: stores
    });
  } catch (error) {
    console.error('獲取店鋪錯誤:', error);
    res.status(500).json({ error: '獲取店鋪失敗' });
  }
});

// 簡化的商品路由
app.get('/api/products', authenticateToken, async (req, res) => {
  try {
    const products = await prisma.product.findMany({
      where: {
        store: { tenantId: 'test-tenant-id' }
      },
      include: {
        category: true,
        variants: true,
        addons: true,
        inventory: true
      }
    });
    
    res.json({
      success: true,
      data: products
    });
  } catch (error) {
    console.error('獲取商品錯誤:', error);
    res.status(500).json({ error: '獲取商品失敗' });
  }
});

// 簡化的訂單路由
app.post('/api/orders', authenticateToken, async (req: any, res) => {
  try {
    const { storeId, items, orderType = 'TAKEOUT' } = req.body;
    const userId = req.user.userId;
    
    // 計算總金額
    let totalAmount = 0;
    for (const item of items) {
      const product = await prisma.product.findUnique({
        where: { id: item.productId },
        include: { variants: true, addons: true }
      });
      
      if (!product) continue;
      
      let itemPrice = product.basePrice;
      
      // 加上規格價格
      if (item.variantId) {
        const variant = product.variants.find(v => v.id === item.variantId);
        if (variant) itemPrice += variant.price;
      }
      
      // 加上加購項目價格
      if (item.addons) {
        for (const addon of item.addons) {
          const addonData = product.addons.find(a => a.id === addon.addonId);
          if (addonData) itemPrice += addonData.price * addon.quantity;
        }
      }
      
      totalAmount += itemPrice * item.quantity;
    }
    
    // 生成訂單號
    const orderNumber = `ORD${Date.now()}`;
    
    // 建立訂單
    const order = await prisma.order.create({
      data: {
        orderNumber,
        storeId,
        customerId: userId,
        orderType,
        status: 'PENDING',
        totalAmount,
        discountAmount: 0,
        finalAmount: totalAmount,
        paymentStatus: 'PENDING'
      }
    });
    
    // 建立訂單項目
    for (const item of items) {
      const product = await prisma.product.findUnique({
        where: { id: item.productId }
      });
      
      if (!product) continue;
      
      let unitPrice = product.basePrice;
      
      const orderItem = await prisma.orderItem.create({
        data: {
          orderId: order.id,
          productId: item.productId,
          variantId: item.variantId || null,
          quantity: item.quantity,
          unitPrice,
          totalPrice: unitPrice * item.quantity,
          note: item.note || null
        }
      });
      
      // 建立加購項目
      if (item.addons) {
        for (const addon of item.addons) {
          await prisma.orderItemAddon.create({
            data: {
              orderItemId: orderItem.id,
              addonId: addon.addonId,
              quantity: addon.quantity,
              price: addon.price
            }
          });
        }
      }
    }
    
    res.json({
      success: true,
      message: '訂單建立成功',
      order: {
        id: order.id,
        orderNumber: order.orderNumber,
        totalAmount: order.totalAmount,
        status: order.status
      }
    });
  } catch (error) {
    console.error('建立訂單錯誤:', error);
    res.status(500).json({ error: '建立訂單失敗' });
  }
});

app.get('/api/orders', authenticateToken, async (req: any, res) => {
  try {
    const userId = req.user.userId;
    
    const orders = await prisma.order.findMany({
      where: { customerId: userId },
      include: {
        items: {
          include: {
            product: true,
            variant: true,
            addons: {
              include: {
                addon: true
              }
            }
          }
        },
        store: true
      },
      orderBy: { createdAt: 'desc' }
    });
    
    res.json({
      success: true,
      data: orders
    });
  } catch (error) {
    console.error('獲取訂單錯誤:', error);
    res.status(500).json({ error: '獲取訂單失敗' });
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
app.use((error: any, req: express.Request, res: express.Response, next: express.NextFunction) => {
  console.error('錯誤:', error);
  
  if (res.headersSent) {
    return next(error);
  }

  const statusCode = error.statusCode || 500;
  const message = error.message || '內部伺服器錯誤';

  res.status(statusCode).json({
    error: message,
    ...(process.env.NODE_ENV === 'development' && { stack: error.stack })
  });
});

// 啟動服務器
const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log(`🚀 測試服務器啟動在端口 ${PORT}`);
  console.log(`📱 API端點: http://localhost:${PORT}`);
  console.log(`🔗 健康檢查: http://localhost:${PORT}/health`);
  
  // 測試資料庫連接
  prisma.$connect()
    .then(() => console.log('✅ 資料庫連接成功'))
    .catch((error) => console.error('❌ 資料庫連接失敗:', error));
});

export default app;