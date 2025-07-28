import { OrderService } from '../../src/services/orderService';
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();
const orderService = new OrderService();

describe('OrderService', () => {
  afterEach(async () => {
    await global.testUtils.cleanup();
  });

  describe('validateOrderItems', () => {
    it('should validate order items successfully', async () => {
      const items = [
        {
          productId: 'test-product-id',
          quantity: 2,
          note: '不要辣',
          addons: [
            {
              addonId: 'test-addon-id',
              quantity: 1,
            },
          ],
        },
      ];

      const validatedItems = await orderService.validateOrderItems(items, 'test-store-id');

      expect(validatedItems).toHaveLength(1);
      expect(validatedItems[0].productId).toBe('test-product-id');
      expect(validatedItems[0].quantity).toBe(2);
      expect(validatedItems[0].totalPrice).toBeGreaterThan(0);
      expect(validatedItems[0].addons).toHaveLength(1);
    });

    it('should throw error for invalid product', async () => {
      const items = [
        {
          productId: 'invalid-product-id',
          quantity: 1,
        },
      ];

      await expect(
        orderService.validateOrderItems(items, 'test-store-id')
      ).rejects.toThrow('商品不存在或已下架');
    });

    it('should throw error for insufficient inventory', async () => {
      // 設置庫存為0
      await prisma.inventory.update({
        where: { productId: 'test-product-id' },
        data: { quantity: 0 },
      });

      const items = [
        {
          productId: 'test-product-id',
          quantity: 1,
        },
      ];

      await expect(
        orderService.validateOrderItems(items, 'test-store-id')
      ).rejects.toThrow('商品庫存不足');
    });
  });

  describe('generateOrderNumber', () => {
    it('should generate unique order number', async () => {
      const orderNumber1 = await orderService.generateOrderNumber('test-store-id');
      const orderNumber2 = await orderService.generateOrderNumber('test-store-id');

      expect(orderNumber1).toBeDefined();
      expect(orderNumber2).toBeDefined();
      expect(orderNumber1).not.toBe(orderNumber2);
      expect(orderNumber1).toMatch(/^\d{8}\d{4}$/); // YYYYMMDD + 4位序號
    });
  });

  describe('calculateEstimatedTime', () => {
    it('should calculate estimated time correctly', () => {
      const items = [
        {
          productId: 'test-product-id',
          variantId: undefined,
          quantity: 2,
          unitPrice: 60,
          totalPrice: 120,
          addons: [
            {
              addonId: 'test-addon-id',
              quantity: 1,
              price: 0,
            },
          ],
        },
      ];

      const estimatedTime = orderService.calculateEstimatedTime(items);

      expect(estimatedTime).toBeGreaterThan(0);
      expect(typeof estimatedTime).toBe('number');
    });

    it('should increase time for complex items', () => {
      const simpleItems = [
        {
          productId: 'test-product-id',
          quantity: 1,
          unitPrice: 60,
          totalPrice: 60,
        },
      ];

      const complexItems = [
        {
          productId: 'test-product-id',
          quantity: 1,
          unitPrice: 60,
          totalPrice: 60,
          addons: [
            {
              addonId: 'test-addon-id',
              quantity: 1,
              price: 0,
            },
          ],
        },
      ];

      const simpleTime = orderService.calculateEstimatedTime(simpleItems);
      const complexTime = orderService.calculateEstimatedTime(complexItems);

      expect(complexTime).toBeGreaterThan(simpleTime);
    });
  });

  describe('validateStatusTransition', () => {
    it('should allow valid status transitions', () => {
      expect(orderService.validateStatusTransition('PENDING', 'CONFIRMED')).toBe(true);
      expect(orderService.validateStatusTransition('CONFIRMED', 'PREPARING')).toBe(true);
      expect(orderService.validateStatusTransition('PREPARING', 'READY')).toBe(true);
      expect(orderService.validateStatusTransition('READY', 'COMPLETED')).toBe(true);
    });

    it('should reject invalid status transitions', () => {
      expect(orderService.validateStatusTransition('COMPLETED', 'PENDING')).toBe(false);
      expect(orderService.validateStatusTransition('CANCELLED', 'CONFIRMED')).toBe(false);
      expect(orderService.validateStatusTransition('PENDING', 'READY')).toBe(false);
    });

    it('should allow cancellation from valid states', () => {
      expect(orderService.validateStatusTransition('PENDING', 'CANCELLED')).toBe(true);
      expect(orderService.validateStatusTransition('CONFIRMED', 'CANCELLED')).toBe(true);
      expect(orderService.validateStatusTransition('PREPARING', 'CANCELLED')).toBe(true);
    });
  });

  describe('getStatusMessage', () => {
    it('should return correct status messages', () => {
      expect(orderService.getStatusMessage('PENDING')).toBe('訂單待確認');
      expect(orderService.getStatusMessage('CONFIRMED')).toBe('訂單已確認');
      expect(orderService.getStatusMessage('PREPARING')).toBe('製作中');
      expect(orderService.getStatusMessage('READY')).toBe('製作完成，請取餐');
      expect(orderService.getStatusMessage('COMPLETED')).toBe('訂單已完成');
      expect(orderService.getStatusMessage('CANCELLED')).toBe('訂單已取消');
    });

    it('should return default message for unknown status', () => {
      expect(orderService.getStatusMessage('UNKNOWN')).toBe('狀態未知');
    });
  });

  describe('calculateRemainingTime', () => {
    it('should calculate remaining time correctly', () => {
      const order = {
        estimatedTime: 30, // 30分鐘
        createdAt: new Date(Date.now() - 10 * 60 * 1000), // 10分鐘前創建
        status: 'PREPARING',
      };

      const remainingTime = orderService.calculateRemainingTime(order);

      expect(remainingTime).toBeGreaterThan(15); // 應該還剩20分鐘左右
      expect(remainingTime).toBeLessThan(25);
    });

    it('should return 0 for completed orders', () => {
      const order = {
        estimatedTime: 30,
        createdAt: new Date(),
        status: 'COMPLETED',
      };

      const remainingTime = orderService.calculateRemainingTime(order);

      expect(remainingTime).toBe(0);
    });

    it('should return 0 for overdue orders', () => {
      const order = {
        estimatedTime: 30,
        createdAt: new Date(Date.now() - 60 * 60 * 1000), // 1小時前創建
        status: 'PREPARING',
      };

      const remainingTime = orderService.calculateRemainingTime(order);

      expect(remainingTime).toBe(0);
    });
  });

  describe('handleOrderCompletion', () => {
    it('should handle order completion successfully', async () => {
      const order = {
        id: 'test-order-id',
        orderNumber: 'TEST001',
        customerId: 'test-customer-id',
        finalAmount: 100,
        items: [
          {
            productId: 'test-product-id',
            quantity: 2,
          },
        ],
      };

      // 這個方法主要是異步處理，不應該拋出錯誤
      await expect(
        orderService.handleOrderCompletion(order)
      ).resolves.not.toThrow();
    });
  });

  describe('getOrderStats', () => {
    beforeEach(async () => {
      // 創建一些測試訂單
      await global.testUtils.createTestOrder('test-customer-id', 'test-store-id');
      
      // 創建一個已完成的訂單
      await prisma.order.create({
        data: {
          orderNumber: `COMPLETED${Date.now()}`,
          storeId: 'test-store-id',
          customerId: 'test-customer-id',
          orderType: 'TAKEOUT',
          status: 'COMPLETED',
          totalAmount: 150,
          discountAmount: 0,
          finalAmount: 150,
          paymentStatus: 'COMPLETED',
        },
      });
    });

    it('should return order statistics', async () => {
      const stats = await orderService.getOrderStats('test-store-id', 'today');

      expect(stats).toHaveProperty('orderCount');
      expect(stats).toHaveProperty('revenue');
      expect(stats).toHaveProperty('avgOrderValue');
      expect(stats.orderCount).toBeGreaterThan(0);
    });

    it('should handle different time periods', async () => {
      const todayStats = await orderService.getOrderStats('test-store-id', 'today');
      const weekStats = await orderService.getOrderStats('test-store-id', 'week');
      const monthStats = await orderService.getOrderStats('test-store-id', 'month');

      expect(todayStats).toBeDefined();
      expect(weekStats).toBeDefined();
      expect(monthStats).toBeDefined();
    });
  });
});