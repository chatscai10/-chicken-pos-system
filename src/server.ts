import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import compression from 'compression';
import rateLimit from 'express-rate-limit';
import { PrismaClient } from '@prisma/client';
import * as dotenv from 'dotenv';
import http from 'http';
import { Server } from 'socket.io';

// 載入環境變數
dotenv.config();

// 引入路由
import authRoutes from './routes/auth';
import storeRoutes from './routes/stores';
import productRoutes from './routes/products';
import orderRoutes from './routes/orders';
import paymentRoutes from './routes/payments';
import posRoutes from './routes/pos';
import adminRoutes from './routes/admin';

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST", "PUT", "DELETE"]
  }
});

export { io };

const prisma = new PrismaClient();

// 基本中間件
app.use(helmet());
app.use(cors());
app.use(compression());
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// 速率限制
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15分鐘
  max: 100 // 限制每個IP最多100個請求
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

// API路由
app.use('/api/auth', authRoutes);
app.use('/api/stores', storeRoutes);
app.use('/api/products', productRoutes);
app.use('/api/orders', orderRoutes);
app.use('/api/payments', paymentRoutes);
app.use('/api/pos', posRoutes);
app.use('/api/admin', adminRoutes);

// 根路由
app.get('/', (req, res) => {
  res.json({
    message: '雞排店線上點餐系統 API',
    version: '1.0.0',
    environment: process.env.NODE_ENV,
    endpoints: {
      health: '/health',
      auth: '/api/auth',
      stores: '/api/stores',
      products: '/api/products',
      orders: '/api/orders',
      payments: '/api/payments',
      pos: '/api/pos',
      admin: '/api/admin'
    }
  });
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

// Socket.IO連接處理
io.on('connection', (socket) => {
  console.log(`用戶連接: ${socket.id}`);

  // 加入租戶房間
  socket.on('join-tenant', (tenantId: string) => {
    socket.join(`tenant:${tenantId}`);
    console.log(`用戶 ${socket.id} 加入租戶房間: ${tenantId}`);
  });

  // 加入店鋪房間
  socket.on('join-store', (storeId: string) => {
    socket.join(`store:${storeId}`);
    console.log(`用戶 ${socket.id} 加入店鋪房間: ${storeId}`);
  });

  socket.on('disconnect', () => {
    console.log(`用戶斷開連接: ${socket.id}`);
  });
});

// 啟動服務器
const PORT = process.env.PORT || 3000;

server.listen(PORT, () => {
  console.log(`🚀 服務器啟動在端口 ${PORT}`);
  console.log(`📱 API端點: http://localhost:${PORT}`);
  console.log(`🔗 健康檢查: http://localhost:${PORT}/health`);
  console.log(`📚 API文檔: http://localhost:${PORT}/`);
  
  // 測試資料庫連接
  prisma.$connect()
    .then(() => console.log('✅ 資料庫連接成功'))
    .catch((error) => console.error('❌ 資料庫連接失敗:', error));
});

// 優雅關閉處理
process.on('SIGTERM', async () => {
  console.log('收到SIGTERM信號，開始優雅關閉...');
  
  server.close(() => {
    console.log('HTTP服務器已關閉');
  });
  
  await prisma.$disconnect();
});

process.on('SIGINT', async () => {
  console.log('收到SIGINT信號，開始優雅關閉...');
  
  server.close(() => {
    console.log('HTTP服務器已關閉');
  });
  
  await prisma.$disconnect();
  process.exit(0);
});

export default app;