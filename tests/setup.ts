import { PrismaClient } from '@prisma/client';
import * as dotenv from 'dotenv';

// 載入測試環境變數
dotenv.config({ path: '.env.test' });

const prisma = new PrismaClient();

// 全域測試設置
beforeAll(async () => {
  // 設置測試環境
  process.env.NODE_ENV = 'test';
});

afterAll(async () => {
  // 斷開資料庫連接
  await prisma.$disconnect();
});

// 每個測試前清理相關數據
beforeEach(async () => {
  // 這裡可以添加每個測試前的清理邏輯
});

afterEach(async () => {
  // 這裡可以添加每個測試後的清理邏輯
});

// 全域測試工具函數
global.testUtils = {
  prisma,
  
  // 生成測試JWT Token
  generateTestToken: (userId: string, tenantId: string) => {
    const jwt = require('jsonwebtoken');
    return jwt.sign(
      { userId, tenantId, email: 'test@example.com' },
      process.env.JWT_SECRET || 'test-secret',
      { expiresIn: '1h' }
    );
  },

  // 創建測試訂單
  createTestOrder: async (customerId: string, storeId: string) => {
    return await prisma.order.create({
      data: {
        orderNumber: `TEST${Date.now()}`,
        storeId,
        customerId,
        orderType: 'TAKEOUT',
        status: 'PENDING',
        totalAmount: 100,
        discountAmount: 0,
        finalAmount: 100,
        paymentStatus: 'PENDING',
        estimatedTime: 15,
      },
    });
  },

  // 清理測試數據
  cleanup: async () => {
    await prisma.orderItem.deleteMany();
    await prisma.order.deleteMany();
    await prisma.product.deleteMany();
    await prisma.category.deleteMany();
  },
};