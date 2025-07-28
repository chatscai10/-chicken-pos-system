import express from 'express';
import { body, param, query, validationResult } from 'express-validator';
import { PrismaClient } from '@prisma/client';
import { AuthenticatedRequest } from '../middleware/auth';
import { requireRoles } from '../middleware/auth';
import AppError from '../utils/AppError';
import logger from '../utils/logger';
import { io } from '../server';
import { OrderService } from '../services/orderService';

const router = express.Router();
const prisma = new PrismaClient();
const orderService = new OrderService();

/**
 * 創建新訂單
 * POST /api/orders
 */
router.post(
  '/',
  [
    body('storeId').isUUID().withMessage('店鋪ID格式無效'),
    body('branchId').optional().isUUID().withMessage('分店ID格式無效'),
    body('orderType').isIn(['DINE_IN', 'TAKEOUT', 'DELIVERY', 'UBER_EATS']).withMessage('訂單類型無效'),
    body('items').isArray({ min: 1 }).withMessage('訂單項目不能為空'),
    body('items.*.productId').isUUID().withMessage('商品ID格式無效'),
    body('items.*.variantId').optional().isUUID().withMessage('規格ID格式無效'),
    body('items.*.quantity').isInt({ min: 1 }).withMessage('數量必須大於0'),
    body('items.*.note').optional().isString().isLength({ max: 200 }).withMessage('備註不能超過200字符'),
    body('items.*.addons').optional().isArray().withMessage('加購項目必須是數組'),
    body('note').optional().isString().isLength({ max: 500 }).withMessage('訂單備註不能超過500字符'),
    body('couponCode').optional().isString().withMessage('優惠券代碼格式無效'),
  ],
  async (req: AuthenticatedRequest, res, next) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return next(new AppError('輸入數據無效', 400, errors.array()));
      }

      const { storeId, branchId, orderType, items, note, couponCode } = req.body;

      // 驗證店鋪權限
      const store = await prisma.store.findFirst({
        where: {
          id: storeId,
          tenantId: req.user!.tenantId,
          status: 'ACTIVE',
        },
      });

      if (!store) {
        return next(new AppError('店鋪不存在或已停用', 404));
      }

      // 驗證分店（如果提供）
      if (branchId) {
        const branch = await prisma.storeBranch.findFirst({
          where: {
            id: branchId,
            storeId,
          },
        });

        if (!branch) {
          return next(new AppError('分店不存在', 404));
        }
      }

      // 驗證商品和計算價格
      const validatedItems = await orderService.validateOrderItems(items, storeId);
      
      // 計算總金額
      const totalAmount = validatedItems.reduce((sum, item) => sum + item.totalPrice, 0);

      // 處理優惠券（如果有）
      let discountAmount = 0;
      let coupon = null;
      if (couponCode) {
        coupon = await orderService.validateCoupon(couponCode, storeId, totalAmount);
        discountAmount = orderService.calculateDiscount(coupon, totalAmount);
      }

      const finalAmount = totalAmount - discountAmount;

      // 生成訂單號碼
      const orderNumber = await orderService.generateOrderNumber(storeId);

      // 創建訂單
      const order = await prisma.order.create({
        data: {
          orderNumber,
          storeId,
          branchId,
          customerId: req.user!.id,
          orderType,
          status: 'PENDING',
          totalAmount,
          discountAmount,
          finalAmount,
          paymentStatus: 'PENDING',
          note,
          estimatedTime: orderService.calculateEstimatedTime(validatedItems),
          items: {
            create: validatedItems.map(item => ({
              productId: item.productId,
              variantId: item.variantId,
              quantity: item.quantity,
              unitPrice: item.unitPrice,
              totalPrice: item.totalPrice,
              note: item.note,
              addons: item.addons?.length ? {
                create: item.addons.map(addon => ({
                  addonId: addon.addonId,
                  quantity: addon.quantity,
                  price: addon.price,
                })),
              } : undefined,
            })),
          },
        },
        include: {
          items: {
            include: {
              product: {
                select: {
                  name: true,
                  image: true,
                },
              },
              variant: {
                select: {
                  name: true,
                },
              },
              addons: {
                include: {
                  addon: {
                    select: {
                      name: true,
                    },
                  },
                },
              },
            },
          },
          store: {
            select: {
              name: true,
              address: true,
              phone: true,
            },
          },
          branch: {
            select: {
              name: true,
              address: true,
            },
          },
        },
      });

      // 記錄訂單狀態歷史
      await prisma.orderStatusHistory.create({
        data: {
          orderId: order.id,
          status: 'PENDING',
          note: '訂單已創建',
        },
      });

      // 更新優惠券使用次數
      if (coupon) {
        await prisma.coupon.update({
          where: { id: coupon.id },
          data: { usedCount: { increment: 1 } },
        });
      }

      // 發送即時通知給店家
      io.to(`store:${storeId}`).emit('newOrder', {
        orderId: order.id,
        orderNumber: order.orderNumber,
        orderType: order.orderType,
        totalAmount: order.totalAmount,
        itemCount: order.items.length,
        customerName: req.user!.displayName,
      });

      logger.info(`新訂單創建: ${order.orderNumber} (顧客: ${req.user!.email})`);

      res.status(201).json({
        message: '訂單創建成功',
        data: { order },
      });
    } catch (error) {
      next(error);
    }
  }
);

/**
 * 獲取訂單列表
 * GET /api/orders
 */
router.get(
  '/',
  [
    query('storeId').optional().isUUID().withMessage('店鋪ID格式無效'),
    query('status').optional().isIn(['PENDING', 'CONFIRMED', 'PREPARING', 'READY', 'COMPLETED', 'CANCELLED']).withMessage('狀態值無效'),
    query('orderType').optional().isIn(['DINE_IN', 'TAKEOUT', 'DELIVERY', 'UBER_EATS']).withMessage('訂單類型無效'),
    query('paymentStatus').optional().isIn(['PENDING', 'COMPLETED', 'FAILED', 'REFUNDED']).withMessage('付款狀態無效'),
    query('page').optional().isInt({ min: 1 }).withMessage('頁碼必須是正整數'),
    query('limit').optional().isInt({ min: 1, max: 100 }).withMessage('每頁數量必須在1-100之間'),
    query('startDate').optional().isISO8601().withMessage('開始日期格式無效'),
    query('endDate').optional().isISO8601().withMessage('結束日期格式無效'),
  ],
  async (req: AuthenticatedRequest, res, next) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return next(new AppError('輸入數據無效', 400, errors.array()));
      }

      const {
        storeId,
        status,
        orderType,
        paymentStatus,
        page = '1',
        limit = '20',
        startDate,
        endDate,
      } = req.query;

      const pageNum = parseInt(page as string);
      const limitNum = parseInt(limit as string);
      const offset = (pageNum - 1) * limitNum;

      // 構建查詢條件
      const whereClause: any = {
        store: {
          tenantId: req.user!.tenantId,
        },
      };

      // 根據用戶角色添加權限過濾
      if (!req.user!.roles.some(role => ['TENANT_ADMIN', 'STORE_MANAGER', 'SUPER_ADMIN'].includes(role))) {
        // 一般用戶只能查看自己的訂單
        whereClause.customerId = req.user!.id;
      }

      if (storeId) {
        whereClause.storeId = storeId as string;
      }

      if (status) {
        whereClause.status = status as string;
      }

      if (orderType) {
        whereClause.orderType = orderType as string;
      }

      if (paymentStatus) {
        whereClause.paymentStatus = paymentStatus as string;
      }

      if (startDate || endDate) {
        whereClause.createdAt = {};
        if (startDate) {
          whereClause.createdAt.gte = new Date(startDate as string);
        }
        if (endDate) {
          whereClause.createdAt.lte = new Date(endDate as string);
        }
      }

      const [orders, total] = await Promise.all([
        prisma.order.findMany({
          where: whereClause,
          include: {
            items: {
              include: {
                product: {
                  select: {
                    name: true,
                    image: true,
                  },
                },
                variant: {
                  select: {
                    name: true,
                  },
                },
                addons: {
                  include: {
                    addon: {
                      select: {
                        name: true,
                      },
                    },
                  },
                },
              },
            },
            store: {
              select: {
                name: true,
                address: true,
              },
            },
            branch: {
              select: {
                name: true,
                address: true,  
              },
            },
            customer: {
              select: {
                displayName: true,
                email: true,
                phone: true,
              },
            },
            payments: {
              select: {
                method: true,
                status: true,
                paidAt: true,
              },
            },
          },
          skip: offset,
          take: limitNum,
          orderBy: { createdAt: 'desc' },
        }),
        prisma.order.count({ where: whereClause }),
      ]);

      res.json({
        message: '訂單列表獲取成功',
        data: {
          orders,
          pagination: {
            page: pageNum,
            limit: limitNum,
            total,
            totalPages: Math.ceil(total / limitNum),
          },
        },
      });
    } catch (error) {
      next(error);
    }
  }
);

/**
 * 獲取單個訂單詳細資訊
 * GET /api/orders/:id
 */
router.get(
  '/:id',
  [param('id').isUUID().withMessage('訂單ID格式無效')],
  async (req: AuthenticatedRequest, res, next) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return next(new AppError('輸入數據無效', 400, errors.array()));
      }

      const { id } = req.params;

      const whereClause: any = {
        id,
        store: {
          tenantId: req.user!.tenantId,
        },
      };

      // 一般用戶只能查看自己的訂單
      if (!req.user!.roles.some(role => ['TENANT_ADMIN', 'STORE_MANAGER', 'SUPER_ADMIN'].includes(role))) {
        whereClause.customerId = req.user!.id;
      }

      const order = await prisma.order.findFirst({
        where: whereClause,
        include: {
          items: {
            include: {
              product: {
                select: {
                  name: true,
                  image: true,
                  description: true,
                },
              },
              variant: {
                select: {
                  name: true,
                },
              },
              addons: {
                include: {
                  addon: {
                    select: {
                      name: true,
                    },
                  },
                },
              },
            },
          },
          store: {
            select: {
              name: true,
              address: true,
              phone: true,
            },
          },
          branch: {
            select: {
              name: true,
              address: true,
            },
          },
          customer: {
            select: {
              displayName: true,
              email: true,
              phone: true,
            },
          },
          payments: {
            select: {
              method: true,
              status: true,
              amount: true,
              paidAt: true,
              transactionId: true,
            },
          },
          statusHistory: {
            orderBy: { createdAt: 'desc' },
            select: {
              status: true,
              note: true,
              createdAt: true,
            },
          },
        },
      });

      if (!order) {
        return next(new AppError('訂單不存在', 404));
      }

      res.json({
        message: '訂單詳細資訊獲取成功',
        data: { order },
      });
    } catch (error) {
      next(error);
    }
  }
);

/**
 * 更新訂單狀態
 * PATCH /api/orders/:id/status
 */
router.patch(
  '/:id/status',
  requireRoles('TENANT_ADMIN', 'STORE_MANAGER', 'STAFF'),
  [
    param('id').isUUID().withMessage('訂單ID格式無效'),
    body('status').isIn(['CONFIRMED', 'PREPARING', 'READY', 'COMPLETED', 'CANCELLED']).withMessage('狀態值無效'),
    body('note').optional().isString().isLength({ max: 200 }).withMessage('備註不能超過200字符'),
  ],
  async (req: AuthenticatedRequest, res, next) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return next(new AppError('輸入數據無效', 400, errors.array()));
      }

      const { id } = req.params;
      const { status, note } = req.body;

      // 查找訂單
      const order = await prisma.order.findFirst({
        where: {
          id,
          store: {
            tenantId: req.user!.tenantId,
          },
        },
        include: {
          store: true,
          customer: {
            select: {
              displayName: true,
              email: true,
            },
          },
        },
      });

      if (!order) {
        return next(new AppError('訂單不存在', 404));
      }

      // 驗證狀態轉換合法性
      const isValidTransition = orderService.validateStatusTransition(order.status, status);
      if (!isValidTransition) {
        return next(new AppError(`無法從${order.status}轉換為${status}`, 400));
      }

      // 更新訂單狀態
      const updatedOrder = await prisma.order.update({
        where: { id },
        data: {
          status,
          updatedAt: new Date(),
        },
        include: {
          customer: {
            select: {
              displayName: true,
              email: true,
            },
          },
        },
      });

      // 記錄狀態變更歷史
      await prisma.orderStatusHistory.create({
        data: {
          orderId: id,
          status,
          note: note || `狀態更新為${status}`,
          createdBy: req.user!.id,
        },
      });

      // 發送即時通知
      const notificationData = {
        orderId: id,
        orderNumber: order.orderNumber,
        status,
        customerName: order.customer.displayName,
        storeName: order.store.name,
      };

      // 通知店家
      io.to(`store:${order.storeId}`).emit('orderStatusUpdate', notificationData);

      // 通知顧客
      io.to(`user:${order.customerId}`).emit('orderStatusUpdate', {
        ...notificationData,
        message: orderService.getStatusMessage(status),
      });

      // 如果訂單完成，發送感謝郵件等後續處理
      if (status === 'COMPLETED') {
        await orderService.handleOrderCompletion(order);
      }

      logger.info(`訂單狀態更新: ${order.orderNumber} -> ${status} (操作者: ${req.user!.email})`);

      res.json({
        message: '訂單狀態更新成功',
        data: {
          order: updatedOrder,
          previousStatus: order.status,
          newStatus: status,
        },
      });
    } catch (error) {
      next(error);
    }
  }
);

/**
 * 取消訂單
 * POST /api/orders/:id/cancel
 */
router.post(
  '/:id/cancel',
  [
    param('id').isUUID().withMessage('訂單ID格式無效'),
    body('reason').optional().isString().isLength({ max: 200 }).withMessage('取消原因不能超過200字符'),
  ],
  async (req: AuthenticatedRequest, res, next) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return next(new AppError('輸入數據無效', 400, errors.array()));
      }

      const { id } = req.params;
      const { reason } = req.body;

      // 查找訂單
      const order = await prisma.order.findFirst({
        where: {
          id,
          OR: [
            { customerId: req.user!.id }, // 顧客本人
            {
              store: {
                tenantId: req.user!.tenantId,
              },
            }, // 或店家員工
          ],
        },
        include: {
          payments: true,
        },
      });

      if (!order) {
        return next(new AppError('訂單不存在或無權限', 404));
      }

      // 檢查訂單是否可以取消
      if (!['PENDING', 'CONFIRMED', 'PREPARING'].includes(order.status)) {
        return next(new AppError('該訂單狀態不允許取消', 400));
      }

      // 如果已付款，需要處理退款
      const completedPayment = order.payments.find(p => p.status === 'COMPLETED');
      if (completedPayment) {
        // 這裡應該調用退款API
        logger.info(`訂單${order.orderNumber}需要退款處理`);
      }

      // 取消訂單
      await Promise.all([
        prisma.order.update({
          where: { id },
          data: {
            status: 'CANCELLED',
            updatedAt: new Date(),
          },
        }),
        prisma.orderStatusHistory.create({
          data: {
            orderId: id,
            status: 'CANCELLED',
            note: reason || '訂單已取消',
            createdBy: req.user!.id,
          },
        }),
      ]);

      // 發送通知
      io.to(`store:${order.storeId}`).emit('orderCancelled', {
        orderId: id,
        orderNumber: order.orderNumber,
        reason,
        cancelledBy: req.user!.displayName,
      });

      logger.info(`訂單取消: ${order.orderNumber} (操作者: ${req.user!.email})`);

      res.json({
        message: '訂單取消成功',
        data: {
          orderId: id,
          reason,
        },
      });
    } catch (error) {
      next(error);
    }
  }
);

/**
 * 即時訂單追蹤
 * GET /api/orders/track/:orderNumber
 */
router.get(
  '/track/:orderNumber',
  [param('orderNumber').isString().withMessage('訂單號碼格式無效')],
  async (req: AuthenticatedRequest, res, next) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return next(new AppError('輸入數據無效', 400, errors.array()));
      }

      const { orderNumber } = req.params;

      const order = await prisma.order.findFirst({
        where: {
          orderNumber,
          store: {
            tenantId: req.user!.tenantId,
          },
        },
        select: {
          id: true,
          orderNumber: true,
          status: true,
          paymentStatus: true,
          orderType: true,
          estimatedTime: true,
          createdAt: true,
          updatedAt: true,
          store: {
            select: {
              name: true,
              phone: true,
            },
          },
          statusHistory: {
            orderBy: { createdAt: 'asc' },
            select: {
              status: true,
              note: true,
              createdAt: true,
            },
          },
        },
      });

      if (!order) {
        return next(new AppError('訂單不存在', 404));
      }

      // 計算預估剩餘時間
      const estimatedRemainingTime = orderService.calculateRemainingTime(order);

      res.json({
        message: '訂單追蹤資訊獲取成功',
        data: {
          order: {
            ...order,
            estimatedRemainingTime,
            statusMessage: orderService.getStatusMessage(order.status),
          },
        },
      });
    } catch (error) {
      next(error);
    }
  }
);

/**
 * 批量更新訂單狀態
 * PATCH /api/orders/batch-status
 */
router.patch(
  '/batch-status',
  requireRoles('TENANT_ADMIN', 'STORE_MANAGER'),
  [
    body('orderIds').isArray({ min: 1 }).withMessage('訂單ID列表不能為空'),
    body('orderIds.*').isUUID().withMessage('訂單ID格式無效'),
    body('status').isIn(['CONFIRMED', 'PREPARING', 'READY', 'COMPLETED', 'CANCELLED']).withMessage('狀態值無效'),
    body('note').optional().isString().isLength({ max: 200 }).withMessage('備註不能超過200字符'),
  ],
  async (req: AuthenticatedRequest, res, next) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return next(new AppError('輸入數據無效', 400, errors.array()));
      }

      const { orderIds, status, note } = req.body;

      // 驗證所有訂單都屬於當前租戶
      const orders = await prisma.order.findMany({
        where: {
          id: { in: orderIds },
          store: {
            tenantId: req.user!.tenantId,
          },
        },
      });

      if (orders.length !== orderIds.length) {
        return next(new AppError('部分訂單不存在或無權限', 404));
      }

      // 批量更新
      const [updateResult] = await Promise.all([
        prisma.order.updateMany({
          where: {
            id: { in: orderIds },
          },
          data: {
            status,
            updatedAt: new Date(),
          },
        }),
        // 批量創建狀態歷史記錄  
        prisma.orderStatusHistory.createMany({
          data: orderIds.map(orderId => ({
            orderId,
            status,
            note: note || `批量更新狀態為${status}`,
            createdBy: req.user!.id,
          })),
        }),
      ]);

      logger.info(`批量更新訂單狀態: ${updateResult.count}個訂單更新為${status}`);

      res.json({
        message: `成功更新${updateResult.count}個訂單狀態`,
        data: { updatedCount: updateResult.count },
      });
    } catch (error) {
      next(error);
    }
  }
);

export default router;