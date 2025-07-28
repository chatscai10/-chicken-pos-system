import request from 'supertest';
import { app } from '../../src/server';

describe('Order Routes', () => {
  let authToken: string;
  let customerToken: string;

  beforeAll(async () => {
    // 獲取管理員Token
    authToken = global.testUtils.generateTestToken('test-admin-id', 'test-tenant-id');
    
    // 獲取顧客Token
    customerToken = global.testUtils.generateTestToken('test-customer-id', 'test-tenant-id');
  });

  afterEach(async () => {
    await global.testUtils.cleanup();
  });

  describe('POST /api/orders', () => {
    it('should create a new order successfully', async () => {
      const orderData = {
        storeId: 'test-store-id',
        orderType: 'TAKEOUT',
        items: [
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
        ],
        note: '測試訂單',
      };

      const response = await request(app)
        .post('/api/orders')
        .set('Authorization', `Bearer ${customerToken}`)
        .send(orderData)
        .expect(201);

      expect(response.body.message).toBe('訂單創建成功');
      expect(response.body.data.order.orderType).toBe('TAKEOUT');
      expect(response.body.data.order.items).toHaveLength(1);
      expect(response.body.data.order.status).toBe('PENDING');
    });

    it('should return error for invalid store', async () => {
      const orderData = {
        storeId: 'invalid-store-id',
        orderType: 'TAKEOUT',
        items: [
          {
            productId: 'test-product-id',
            quantity: 1,
          },
        ],
      };

      const response = await request(app)
        .post('/api/orders')
        .set('Authorization', `Bearer ${customerToken}`)
        .send(orderData)
        .expect(404);

      expect(response.body.message).toBe('店鋪不存在或已停用');
    });

    it('should return error for empty items', async () => {
      const orderData = {
        storeId: 'test-store-id',
        orderType: 'TAKEOUT',
        items: [],
      };

      const response = await request(app)
        .post('/api/orders')
        .set('Authorization', `Bearer ${customerToken}`)
        .send(orderData)
        .expect(400);

      expect(response.body.message).toBe('輸入數據無效');
    });

    it('should return error without authentication', async () => {
      const orderData = {
        storeId: 'test-store-id',
        orderType: 'TAKEOUT',
        items: [
          {
            productId: 'test-product-id',
            quantity: 1,
          },
        ],
      };

      const response = await request(app)
        .post('/api/orders')
        .send(orderData)
        .expect(401);

      expect(response.body.error).toBe('未提供認證令牌');
    });
  });

  describe('GET /api/orders', () => {
    beforeEach(async () => {
      // 創建測試訂單
      await global.testUtils.createTestOrder('test-customer-id', 'test-store-id');
    });

    it('should get orders list for customer', async () => {
      const response = await request(app)
        .get('/api/orders')
        .set('Authorization', `Bearer ${customerToken}`)
        .expect(200);

      expect(response.body.message).toBe('訂單列表獲取成功');
      expect(response.body.data.orders).toBeInstanceOf(Array);
      expect(response.body.data.pagination).toHaveProperty('total');
    });

    it('should get orders list for admin', async () => {
      const response = await request(app)
        .get('/api/orders')
        .set('Authorization', `Bearer ${authToken}`)
        .expect(200);

      expect(response.body.message).toBe('訂單列表獲取成功');
      expect(response.body.data.orders).toBeInstanceOf(Array);
    });

    it('should filter orders by status', async () => {
      const response = await request(app)
        .get('/api/orders?status=PENDING')
        .set('Authorization', `Bearer ${authToken}`)
        .expect(200);

      expect(response.body.data.orders).toBeInstanceOf(Array);
    });

    it('should support pagination', async () => {
      const response = await request(app)
        .get('/api/orders?page=1&limit=5')
        .set('Authorization', `Bearer ${authToken}`)
        .expect(200);

      expect(response.body.data.pagination.page).toBe(1);
      expect(response.body.data.pagination.limit).toBe(5);
    });
  });

  describe('GET /api/orders/:id', () => {
    let testOrder: any;

    beforeEach(async () => {
      testOrder = await global.testUtils.createTestOrder('test-customer-id', 'test-store-id');
    });

    it('should get order details for owner', async () => {
      const response = await request(app)
        .get(`/api/orders/${testOrder.id}`)
        .set('Authorization', `Bearer ${customerToken}`)
        .expect(200);

      expect(response.body.message).toBe('訂單詳細資訊獲取成功');
      expect(response.body.data.order.id).toBe(testOrder.id);
    });

    it('should get order details for admin', async () => {
      const response = await request(app)
        .get(`/api/orders/${testOrder.id}`)
        .set('Authorization', `Bearer ${authToken}`)
        .expect(200);

      expect(response.body.data.order.id).toBe(testOrder.id);
    });

    it('should return error for non-existent order', async () => {
      const response = await request(app)
        .get('/api/orders/non-existent-id')
        .set('Authorization', `Bearer ${customerToken}`)
        .expect(400);

      expect(response.body.message).toBe('輸入數據無效');
    });
  });

  describe('PATCH /api/orders/:id/status', () => {
    let testOrder: any;

    beforeEach(async () => {
      testOrder = await global.testUtils.createTestOrder('test-customer-id', 'test-store-id');
    });

    it('should update order status by admin', async () => {
      const response = await request(app)
        .patch(`/api/orders/${testOrder.id}/status`)
        .set('Authorization', `Bearer ${authToken}`)
        .send({
          status: 'CONFIRMED',
          note: '訂單已確認',
        })
        .expect(200);

      expect(response.body.message).toBe('訂單狀態更新成功');
      expect(response.body.data.newStatus).toBe('CONFIRMED');
    });

    it('should return error for invalid status transition', async () => {
      // 先更新為COMPLETED
      await global.testUtils.prisma.order.update({
        where: { id: testOrder.id },
        data: { status: 'COMPLETED' },
      });

      const response = await request(app)
        .patch(`/api/orders/${testOrder.id}/status`)
        .set('Authorization', `Bearer ${authToken}`)
        .send({
          status: 'PENDING',
        })
        .expect(400);

      expect(response.body.message).toContain('無法從COMPLETED轉換為PENDING');
    });

    it('should return error for customer trying to update status', async () => {
      const response = await request(app)
        .patch(`/api/orders/${testOrder.id}/status`)
        .set('Authorization', `Bearer ${customerToken}`)
        .send({
          status: 'CONFIRMED',
        })
        .expect(403);

      expect(response.body.error).toBe('權限不足');
    });
  });

  describe('POST /api/orders/:id/cancel', () => {
    let testOrder: any;

    beforeEach(async () => {
      testOrder = await global.testUtils.createTestOrder('test-customer-id', 'test-store-id');
    });

    it('should cancel order by customer', async () => {
      const response = await request(app)
        .post(`/api/orders/${testOrder.id}/cancel`)
        .set('Authorization', `Bearer ${customerToken}`)
        .send({
          reason: '改變主意了',
        })
        .expect(200);

      expect(response.body.message).toBe('訂單取消成功');
    });

    it('should cancel order by admin', async () => {
      const response = await request(app)
        .post(`/api/orders/${testOrder.id}/cancel`)
        .set('Authorization', `Bearer ${authToken}`)
        .send({
          reason: '商品缺貨',
        })
        .expect(200);

      expect(response.body.message).toBe('訂單取消成功');
    });

    it('should return error for already completed order', async () => {
      // 先更新為COMPLETED
      await global.testUtils.prisma.order.update({
        where: { id: testOrder.id },
        data: { status: 'COMPLETED' },
      });

      const response = await request(app)
        .post(`/api/orders/${testOrder.id}/cancel`)
        .set('Authorization', `Bearer ${customerToken}`)
        .send({
          reason: '測試取消',
        })
        .expect(400);

      expect(response.body.message).toBe('該訂單狀態不允許取消');
    });
  });

  describe('GET /api/orders/track/:orderNumber', () => {
    let testOrder: any;

    beforeEach(async () => {
      testOrder = await global.testUtils.createTestOrder('test-customer-id', 'test-store-id');
    });

    it('should track order by order number', async () => {
      const response = await request(app)
        .get(`/api/orders/track/${testOrder.orderNumber}`)
        .set('Authorization', `Bearer ${customerToken}`)
        .expect(200);

      expect(response.body.message).toBe('訂單追蹤資訊獲取成功');
      expect(response.body.data.order.orderNumber).toBe(testOrder.orderNumber);
      expect(response.body.data.order).toHaveProperty('statusMessage');
    });

    it('should return error for non-existent order number', async () => {
      const response = await request(app)
        .get('/api/orders/track/NON-EXISTENT')
        .set('Authorization', `Bearer ${customerToken}`)
        .expect(404);

      expect(response.body.message).toBe('訂單不存在');
    });
  });
});