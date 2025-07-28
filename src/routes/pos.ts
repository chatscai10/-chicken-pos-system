import express from 'express';
import { body, param, query, validationResult } from 'express-validator';
import { PrismaClient } from '@prisma/client';
import { AuthenticatedRequest } from '../middleware/auth';
import { requireRoles } from '../middleware/auth';
import AppError from '../utils/AppError';
import logger from '../utils/logger';
import { OrderService } from '../services/orderService';
import { PrintService } from '../services/printService';
import { io } from '../server';

const router = express.Router();
const prisma = new PrismaClient();
const orderService = new OrderService();
const printService = new PrintService();

/**
 * 員工POS - 創建現場訂單
 * POST /api/pos/orders
 */
router.post(
  '/orders',
  requireRoles('TENANT_ADMIN', 'STORE_MANAGER', 'STAFF'),
  [
    body('storeId').isUUID().withMessage('店鋪ID格式無效'),
    body('customerId').optional().isUUID().withMessage('顧客ID格式無效'),
    body('customerPhone').optional().isMobilePhone('zh-TW').withMessage('請提供有效的台灣手機號碼'),
    body('customerName').optional().isString().withMessage('顧客姓名格式無效'),
    body('orderType').isIn(['DINE_IN', 'TAKEOUT']).withMessage('現場訂單類型無效'),
    body('items').isArray({ min: 1 }).withMessage('訂單項目不能為空'),
    body('paymentMethod').isIn(['CASH', 'CARD', 'LINE_PAY']).withMessage('付款方式無效'),
    body('tableNumber').optional().isString().withMessage('桌號格式無效'),
    body('note').optional().isString().isLength({ max: 500 }).withMessage('備註不能超過500字符'),
  ],
  async (req: AuthenticatedRequest, res, next) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return next(new AppError('輸入數據無效', 400, errors.array()));
      }

      const {
        storeId,
        customerId,
        customerPhone,
        customerName,
        orderType,
        items,
        paymentMethod,
        tableNumber,
        note,
      } = req.body;

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

      // 處理顧客資訊
      let customer = null;
      if (customerId) {
        customer = await prisma.user.findUnique({
          where: { id: customerId },
        });
      } else if (customerPhone) {
        // 查找或創建臨時顧客
        customer = await prisma.user.findFirst({
          where: {
            tenantId: req.user!.tenantId,
            phone: customerPhone,
          },
        });

        if (!customer) {
          // 創建臨時顧客
          customer = await prisma.user.create({
            data: {
              tenantId: req.user!.tenantId,
              email: `temp_${Date.now()}@temp.com`,
              displayName: customerName || '現場顧客',
              phone: customerPhone,
              status: 'ACTIVE',
            },
          });

          // 分配顧客角色
          const customerRole = await prisma.role.findFirst({
            where: { name: 'CUSTOMER' },
          });

          if (customerRole) {
            await prisma.userRole.create({
              data: {
                userId: customer.id,
                roleId: customerRole.id,
              },
            });
          }

          // 創建顧客資料
          await prisma.customerProfile.create({
            data: {
              userId: customer.id,
              loyaltyTier: 'BRONZE',
            },
          });
        }
      } else {
        // 創建匿名顧客
        customer = await prisma.user.create({
          data: {
            tenantId: req.user!.tenantId,
            email: `anonymous_${Date.now()}@temp.com`,
            displayName: '匿名顾客',
            status: 'ACTIVE',
          },
        });
      }

      // 驗證商品和計算價格
      const validatedItems = await orderService.validateOrderItems(items, storeId);
      const totalAmount = validatedItems.reduce((sum, item) => sum + item.totalPrice, 0);

      // 生成訂單號碼
      const orderNumber = await orderService.generateOrderNumber(storeId);

      // 創建訂單
      const order = await prisma.order.create({
        data: {
          orderNumber,
          storeId,
          customerId: customer.id,
          orderType,
          status: 'CONFIRMED', // POS訂單直接確認
          totalAmount,
          discountAmount: 0,
          finalAmount: totalAmount,
          paymentStatus: paymentMethod === 'CASH' ? 'COMPLETED' : 'PENDING',
          paymentMethod,
          note: tableNumber ? `桌號: ${tableNumber}${note ? ` | ${note}` : ''}` : note,
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
          customer: {
            select: {
              displayName: true,
              phone: true,
            },
          },
        },
      });

      // 創建付款記錄
      if (paymentMethod === 'CASH') {
        await prisma.payment.create({
          data: {
            orderId: order.id,
            amount: totalAmount,
            method: 'CASH',
            status: 'COMPLETED',
            paidAt: new Date(),
          },
        });
      }

      // 記錄訂單狀態歷史
      await prisma.orderStatusHistory.create({
        data: {
          orderId: order.id,
          status: 'CONFIRMED',
          note: `POS訂單創建 (員工: ${req.user!.displayName})`,
          createdBy: req.user!.id,
        },
      });

      // 自動打印
      await printService.autoPrintOrder(order.id);

      // 發送即時通知
      io.to(`store:${storeId}`).emit('posOrderCreated', {
        orderId: order.id,
        orderNumber: order.orderNumber,
        orderType: order.orderType,
        totalAmount: order.totalAmount,
        tableNumber,
        staff: req.user!.displayName,
      });

      logger.info(`POS訂單創建: ${order.orderNumber} (員工: ${req.user!.email})`);

      res.status(201).json({
        message: 'POS訂單創建成功',
        data: { order },
      });
    } catch (error) {
      next(error);
    }
  }
);

/**
 * 員工POS - 快速商品搜尋
 * GET /api/pos/products/search
 */
router.get(
  '/products/search',
  requireRoles('TENANT_ADMIN', 'STORE_MANAGER', 'STAFF'),
  [
    query('storeId').isUUID().withMessage('店鋪ID格式無效'),
    query('keyword').isString().isLength({ min: 1 }).withMessage('搜尋關鍵字不能為空'),
    query('limit').optional().isInt({ min: 1, max: 50 }).withMessage('查詢數量限制在1-50之間'),
  ],
  async (req: AuthenticatedRequest, res, next) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return next(new AppError('輸入數據無效', 400, errors.array()));
      }

      const { storeId, keyword, limit = '20' } = req.query;

      // 驗證店鋪權限
      const store = await prisma.store.findFirst({
        where: {
          id: storeId as string,
          tenantId: req.user!.tenantId,
        },
      });

      if (!store) {
        return next(new AppError('店鋪不存在或無權限', 404));
      }

      const products = await prisma.product.findMany({
        where: {
          storeId: storeId as string,
          isAvailable: true,
          OR: [
            { name: { contains: keyword as string } },
            { description: { contains: keyword as string } },
          ],
        },
        include: {
          category: {
            select: {
              name: true,
            },
          },
          variants: true,
          addons: true,
          inventory: {
            select: {
              quantity: true,
              minQuantity: true,
            },
          },
        },
        take: parseInt(limit as string),
        orderBy: { name: 'asc' },
      });

      res.json({
        message: '商品搜尋成功',
        data: { products },
      });
    } catch (error) {
      next(error);
    }
  }
);

/**
 * 員工POS - 今日營業統計
 * GET /api/pos/stats/today
 */
router.get(
  '/stats/today',
  requireRoles('TENANT_ADMIN', 'STORE_MANAGER', 'STAFF'),
  [query('storeId').isUUID().withMessage('店鋪ID格式無效')],
  async (req: AuthenticatedRequest, res, next) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return next(new AppError('輸入數據無效', 400, errors.array()));
      }

      const { storeId } = req.query;

      // 驗證店鋪權限
      const store = await prisma.store.findFirst({
        where: {
          id: storeId as string,
          tenantId: req.user!.tenantId,
        },
      });

      if (!store) {
        return next(new AppError('店鋪不存在或無權限', 404));
      }

      const today = new Date();
      const startOfDay = new Date(today.getFullYear(), today.getMonth(), today.getDate());
      const endOfDay = new Date(startOfDay.getTime() + 24 * 60 * 60 * 1000);

      const [orderStats, paymentStats, popularProducts, recentOrders] = await Promise.all([
        // 訂單統計
        prisma.order.groupBy({
          by: ['status'],
          where: {
            storeId: storeId as string,
            createdAt: {
              gte: startOfDay,
              lt: endOfDay,
            },
          },
          _count: {
            id: true,
          },
          _sum: {
            finalAmount: true,
          },
        }),
        // 付款方式統計
        prisma.payment.groupBy({
          by: ['method'],
          where: {
            status: 'COMPLETED',
            createdAt: {
              gte: startOfDay,
              lt: endOfDay,
            },
            order: {
              storeId: storeId as string,
            },
          },
          _count: {
            id: true,
          },
          _sum: {
            amount: true,
          },
        }),
        // 熱門商品
        prisma.orderItem.groupBy({
          by: ['productId'],
          where: {
            order: {
              storeId: storeId as string,
              createdAt: {
                gte: startOfDay,
                lt: endOfDay,
              },
            },
          },
          _sum: {
            quantity: true,
          },
          orderBy: {
            _sum: {
              quantity: 'desc',
            },
          },
          take: 5,
        }),
        // 最近訂單
        prisma.order.findMany({
          where: {
            storeId: storeId as string,
            createdAt: {
              gte: startOfDay,
              lt: endOfDay,
            },
          },
          include: {
            customer: {
              select: {
                displayName: true,
              },
            },
          },
          orderBy: { createdAt: 'desc' },
          take: 10,
        }),
      ]);

      // 處理熱門商品詳細資訊
      const popularProductsWithDetails = await Promise.all(
        popularProducts.map(async (item) => {
          const product = await prisma.product.findUnique({
            where: { id: item.productId },
            select: {
              name: true,
              basePrice: true,
              image: true,
            },
          });
          return {
            ...product,
            totalSold: item._sum.quantity,
          };
        })
      );

      // 計算總統計
      const totalOrders = orderStats.reduce((sum, stat) => sum + stat._count.id, 0);
      const totalRevenue = orderStats.reduce((sum, stat) => sum + (parseFloat(stat._sum.finalAmount?.toString() || '0')), 0);
      const completedOrders = orderStats.find(stat => stat.status === 'COMPLETED')?._count.id || 0;

      res.json({
        message: '今日營業統計獲取成功',
        data: {
          summary: {
            totalOrders,
            completedOrders,
            totalRevenue,
            averageOrderValue: totalOrders > 0 ? totalRevenue / totalOrders : 0,
          },
          ordersByStatus: orderStats.reduce((acc, stat) => {
            acc[stat.status.toLowerCase()] = {
              count: stat._count.id,
              revenue: parseFloat(stat._sum.finalAmount?.toString() || '0'),
            };
            return acc;
          }, {} as Record<string, any>),
          paymentMethods: paymentStats.reduce((acc, stat) => {
            acc[stat.method.toLowerCase()] = {
              count: stat._count.id,
              amount: parseFloat(stat._sum.amount?.toString() || '0'),
            };
            return acc;
          }, {} as Record<string, any>),
          popularProducts: popularProductsWithDetails,
          recentOrders: recentOrders.map(order => ({
            id: order.id,
            orderNumber: order.orderNumber,
            status: order.status,
            totalAmount: order.finalAmount,
            customerName: order.customer.displayName,
            createdAt: order.createdAt,
          })),
        },
      });
    } catch (error) {
      next(error);
    }
  }
);

/**
 * 員工POS - 打印訂單
 * POST /api/pos/orders/:id/print
 */
router.post(
  '/orders/:id/print',
  requireRoles('TENANT_ADMIN', 'STORE_MANAGER', 'STAFF'),
  [
    param('id').isUUID().withMessage('訂單ID格式無效'),
    body('printType').isIn(['RECEIPT', 'KITCHEN']).withMessage('打印類型無效'),
  ],
  async (req: AuthenticatedRequest, res, next) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return next(new AppError('輸入數據無效', 400, errors.array()));
      }

      const { id } = req.params;
      const { printType } = req.body;

      // 驗證訂單權限
      const order = await prisma.order.findFirst({
        where: {
          id,
          store: {
            tenantId: req.user!.tenantId,
          },
        },
      });

      if (!order) {
        return next(new AppError('訂單不存在或無權限', 404));
      }

      const success = await printService.reprintOrder(id, printType);

      if (success) {
        logger.info(`訂單重新打印成功: ${order.orderNumber} (類型: ${printType}, 員工: ${req.user!.email})`);
        res.json({
          message: '打印成功',
        });
      } else {
        res.status(500).json({
          message: '打印失敗，請檢查打印機狀態',
        });
      }
    } catch (error) {
      next(error);
    }
  }
);

/**
 * 員工POS - 測試打印機
 * POST /api/pos/printers/:id/test
 */
router.post(
  '/printers/:id/test',
  requireRoles('TENANT_ADMIN', 'STORE_MANAGER'),
  [param('id').isUUID().withMessage('打印機ID格式無效')],
  async (req: AuthenticatedRequest, res, next) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return next(new AppError('輸入數據無效', 400, errors.array()));
      }

      const { id } = req.params;

      // 驗證打印機權限
      const printer = await prisma.printer.findFirst({
        where: {
          id,
          store: {
            tenantId: req.user!.tenantId,
          },
        },
      });

      if (!printer) {
        return next(new AppError('打印機不存在或無權限', 404));
      }

      const success = await printService.testPrinter(id);

      res.json({
        message: success ? '打印機測試成功' : '打印機測試失敗',
        success,
      });
    } catch (error) {
      next(error);
    }
  }
);

/**
 * 員工POS - 開啟錢櫃
 * POST /api/pos/cash-drawer/open
 */
router.post(
  '/cash-drawer/open',
  requireRoles('TENANT_ADMIN', 'STORE_MANAGER', 'STAFF'),
  [body('reason').optional().isString().isLength({ max: 100 }).withMessage('原因不能超過100字符')],
  async (req: AuthenticatedRequest, res, next) => {
    try {
      const { reason } = req.body;

      // 這裡應該發送開啟錢櫃的命令到POS硬體
      // 實際實作需要根據具體的錢櫃型號和API

      logger.info(`錢櫃開啟: 員工${req.user!.displayName}, 原因: ${reason || '正常操作'}`);

      res.json({
        message: '錢櫃已開啟',
      });
    } catch (error) {
      next(error);
    }
  }
);

/**
 * 員工POS - 交班報表
 * GET /api/pos/shift-report
 */
router.get(
  '/shift-report',
  requireRoles('TENANT_ADMIN', 'STORE_MANAGER', 'STAFF'),
  [
    query('storeId').isUUID().withMessage('店鋪ID格式無效'),
    query('startTime').isISO8601().withMessage('開始時間格式無效'),
    query('endTime').optional().isISO8601().withMessage('結束時間格式無效'),
  ],
  async (req: AuthenticatedRequest, res, next) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return next(new AppError('輸入數據無效', 400, errors.array()));
      }

      const { storeId, startTime, endTime } = req.query;

      const start = new Date(startTime as string);
      const end = endTime ? new Date(endTime as string) : new Date();

      // 獲取交班期間的所有數據
      const [orders, payments, refunds] = await Promise.all([
        prisma.order.findMany({
          where: {
            storeId: storeId as string,
            createdAt: {
              gte: start,
              lte: end,
            },
          },
          include: {
            items: {
              include: {
                product: {
                  select: {
                    name: true,
                  },
                },
              },
            },
            payments: true,
          },
        }),
        prisma.payment.findMany({
          where: {
            status: 'COMPLETED',
            paidAt: {
              gte: start,
              lte: end,
            },
            order: {
              storeId: storeId as string,
            },
          },
        }),
        prisma.payment.findMany({
          where: {
            status: 'REFUNDED',
            refundedAt: {
              gte: start,
              lte: end,
            },
            order: {
              storeId: storeId as string,
            },
          },
        }),
      ]);

      // 統計數據
      const totalOrders = orders.length;
      const completedOrders = orders.filter(o => o.status === 'COMPLETED').length;
      const cancelledOrders = orders.filter(o => o.status === 'CANCELLED').length;

      const totalRevenue = payments.reduce((sum, p) => sum + parseFloat(p.amount.toString()), 0);
      const totalRefunds = refunds.reduce((sum, r) => sum + parseFloat(r.amount.toString()), 0);
      const netRevenue = totalRevenue - totalRefunds;

      // 按付款方式分組
      const paymentsByMethod = payments.reduce((acc, payment) => {
        const method = payment.method;
        if (!acc[method]) {
          acc[method] = { count: 0, amount: 0 };
        }
        acc[method].count++;
        acc[method].amount += parseFloat(payment.amount.toString());
        return acc;
      }, {} as Record<string, { count: number; amount: number }>);

      res.json({
        message: '交班報表生成成功',
        data: {
          period: {
            start: start.toISOString(),
            end: end.toISOString(),
          },
          summary: {
            totalOrders,
            completedOrders,
            cancelledOrders,
            totalRevenue,
            totalRefunds,
            netRevenue,
            averageOrderValue: completedOrders > 0 ? totalRevenue / completedOrders : 0,
          },
          paymentMethods: paymentsByMethod,
          staff: req.user!.displayName,
          generatedAt: new Date().toISOString(),
        },
      });
    } catch (error) {
      next(error);
    }
  }
);

export default router;