import express from 'express';
import { body, param, query, validationResult } from 'express-validator';
import { PrismaClient } from '@prisma/client';
import { AuthenticatedRequest } from '../middleware/auth';
import { requireRoles } from '../middleware/auth';
import AppError from '../utils/AppError';
import logger from '../utils/logger';
import { uploadMiddleware } from '../middleware/upload';

const router = express.Router();
const prisma = new PrismaClient();

/**
 * 獲取店鋪列表
 * GET /api/stores
 */
router.get(
  '/',
  [
    query('page').optional().isInt({ min: 1 }).withMessage('頁碼必須是正整數'),
    query('limit').optional().isInt({ min: 1, max: 100 }).withMessage('每頁數量必須在1-100之間'),
    query('search').optional().isString().withMessage('搜尋關鍵字必須是字符串'),
    query('status').optional().isIn(['ACTIVE', 'INACTIVE', 'MAINTENANCE']).withMessage('狀態值無效'),
  ],
  async (req: AuthenticatedRequest, res, next) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return next(new AppError('輸入數據無效', 400, errors.array()));
      }

      const page = parseInt(req.query.page as string) || 1;
      const limit = parseInt(req.query.limit as string) || 10;
      const search = req.query.search as string;
      const status = req.query.status as string;
      const offset = (page - 1) * limit;

      // 構建查詢條件
      const whereClause: any = {
        tenantId: req.user!.tenantId,
      };

      if (search) {
        whereClause.OR = [
          { name: { contains: search } },
          { address: { contains: search } },
          { phone: { contains: search } },
        ];
      }

      if (status) {
        whereClause.status = status;
      }

      // 查詢店鋪列表
      const [stores, total] = await Promise.all([
        prisma.store.findMany({
          where: whereClause,
          include: {
            branches: {
              select: {
                id: true,
                name: true,
                address: true,
                isMain: true,
              },
            },
            _count: {
              select: {
                products: true,
                orders: true,
              },
            },
          },
          skip: offset,
          take: limit,
          orderBy: { createdAt: 'desc' },
        }),
        prisma.store.count({ where: whereClause }),
      ]);

      res.json({
        message: '店鋪列表獲取成功',
        data: {
          stores,
          pagination: {
            page,
            limit,
            total,
            totalPages: Math.ceil(total / limit),
          },
        },
      });
    } catch (error) {
      next(error);
    }
  }
);

/**
 * 獲取單個店鋪詳細資訊
 * GET /api/stores/:id
 */
router.get(
  '/:id',
  [param('id').isUUID().withMessage('店鋪ID格式無效')],
  async (req: AuthenticatedRequest, res, next) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return next(new AppError('輸入數據無效', 400, errors.array()));
      }

      const { id } = req.params;

      const store = await prisma.store.findFirst({
        where: {
          id,
          tenantId: req.user!.tenantId,
        },
        include: {
          branches: true,
          categories: {
            include: {
              products: {
                include: {
                  variants: true,
                  addons: true,
                  inventory: true,
                },
              },
            },
          },
          printers: true,
          _count: {
            select: {
              products: true,
              orders: true,
            },
          },
        },
      });

      if (!store) {
        return next(new AppError('店鋪不存在', 404));
      }

      res.json({
        message: '店鋪詳細資訊獲取成功',
        data: { store },
      });
    } catch (error) {
      next(error);
    }
  }
);

/**
 * 創建新店鋪
 * POST /api/stores
 */
router.post(
  '/',
  requireRoles('TENANT_ADMIN', 'SUPER_ADMIN'),
  [
    body('name').trim().isLength({ min: 1, max: 100 }).withMessage('店鋪名稱長度必須在1-100字符之間'),
    body('description').optional().isString().isLength({ max: 500 }).withMessage('描述不能超過500字符'),
    body('address').trim().isLength({ min: 1, max: 200 }).withMessage('地址長度必須在1-200字符之間'),
    body('phone').isMobilePhone('zh-TW').withMessage('請提供有效的台灣電話號碼'),
    body('email').optional().isEmail().withMessage('請提供有效的電子郵件'),
    body('businessHours').optional().isObject().withMessage('營業時間必須是對象格式'),
    body('branches').optional().isArray().withMessage('分店資訊必須是數組'),
  ],
  async (req: AuthenticatedRequest, res, next) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return next(new AppError('輸入數據無效', 400, errors.array()));
      }

      const { name, description, address, phone, email, businessHours, branches } = req.body;

      // 檢查店鋪名稱是否已存在
      const existingStore = await prisma.store.findFirst({
        where: {
          tenantId: req.user!.tenantId,
          name,
        },
      });

      if (existingStore) {
        return next(new AppError('店鋪名稱已存在', 409));
      }

      // 創建店鋪
      const store = await prisma.store.create({
        data: {
          tenantId: req.user!.tenantId,
          name,
          description,
          address,
          phone,
          email,
          businessHours,
          status: 'ACTIVE',
          branches: branches ? {
            create: branches.map((branch: any, index: number) => ({
              name: branch.name,
              address: branch.address,
              phone: branch.phone,
              isMain: index === 0, // 第一個分店設為主店
            })),
          } : undefined,
        },
        include: {
          branches: true,
        },
      });

      logger.info(`新店鋪創建成功: ${name} (ID: ${store.id})`);

      res.status(201).json({
        message: '店鋪創建成功',
        data: { store },
      });
    } catch (error) {
      next(error);
    }
  }
);

/**
 * 更新店鋪資訊
 * PUT /api/stores/:id
 */
router.put(
  '/:id',
  requireRoles('TENANT_ADMIN', 'STORE_MANAGER', 'SUPER_ADMIN'),
  [
    param('id').isUUID().withMessage('店鋪ID格式無效'),
    body('name').optional().trim().isLength({ min: 1, max: 100 }).withMessage('店鋪名稱長度必須在1-100字符之間'),
    body('description').optional().isString().isLength({ max: 500 }).withMessage('描述不能超過500字符'),
    body('address').optional().trim().isLength({ min: 1, max: 200 }).withMessage('地址長度必須在1-200字符之間'),
    body('phone').optional().isMobilePhone('zh-TW').withMessage('請提供有效的台灣電話號碼'),
    body('email').optional().isEmail().withMessage('請提供有效的電子郵件'),
    body('status').optional().isIn(['ACTIVE', 'INACTIVE', 'MAINTENANCE']).withMessage('狀態值無效'),
    body('businessHours').optional().isObject().withMessage('營業時間必須是對象格式'),
  ],
  async (req: AuthenticatedRequest, res, next) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return next(new AppError('輸入數據無效', 400, errors.array()));
      }

      const { id } = req.params;
      const updateData = req.body;

      // 檢查店鋪是否存在
      const existingStore = await prisma.store.findFirst({
        where: {
          id,
          tenantId: req.user!.tenantId,
        },
      });

      if (!existingStore) {
        return next(new AppError('店鋪不存在', 404));
      }

      // 如果更新名稱，檢查是否重複
      if (updateData.name && updateData.name !== existingStore.name) {
        const duplicateStore = await prisma.store.findFirst({
          where: {
            tenantId: req.user!.tenantId,
            name: updateData.name,
            id: { not: id },
          },
        });

        if (duplicateStore) {
          return next(new AppError('店鋪名稱已存在', 409));
        }
      }

      // 更新店鋪
      const updatedStore = await prisma.store.update({
        where: { id },
        data: {
          ...updateData,
          updatedAt: new Date(),
        },
        include: {
          branches: true,
        },
      });

      logger.info(`店鋪更新成功: ${updatedStore.name} (ID: ${id})`);

      res.json({
        message: '店鋪更新成功',
        data: { store: updatedStore },
      });
    } catch (error) {
      next(error);
    }
  }
);

/**
 * 刪除店鋪
 * DELETE /api/stores/:id
 */
router.delete(
  '/:id',
  requireRoles('TENANT_ADMIN', 'SUPER_ADMIN'),
  [param('id').isUUID().withMessage('店鋪ID格式無效')],
  async (req: AuthenticatedRequest, res, next) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return next(new AppError('輸入數據無效', 400, errors.array()));
      }

      const { id } = req.params;

      // 檢查店鋪是否存在
      const store = await prisma.store.findFirst({
        where: {
          id,
          tenantId: req.user!.tenantId,
        },
        include: {
          _count: {
            select: {
              orders: true,
              products: true,
            },
          },
        },
      });

      if (!store) {
        return next(new AppError('店鋪不存在', 404));
      }

      // 檢查是否有相關數據
      if (store._count.orders > 0) {
        return next(new AppError('該店鋪還有訂單記錄，無法刪除', 409));
      }

      // 軟刪除 (設置為非活躍狀態)
      await prisma.store.update({
        where: { id },
        data: {
          status: 'INACTIVE',
          updatedAt: new Date(),
        },
      });

      logger.info(`店鋪刪除成功: ${store.name} (ID: ${id})`);

      res.json({
        message: '店鋪刪除成功',
      });
    } catch (error) {
      next(error);
    }
  }
);

/**
 * 獲取店鋪統計數據
 * GET /api/stores/:id/stats
 */
router.get(
  '/:id/stats',
  [
    param('id').isUUID().withMessage('店鋪ID格式無效'),
    query('period').optional().isIn(['today', 'week', 'month', 'year']).withMessage('時間段無效'),
  ],
  async (req: AuthenticatedRequest, res, next) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return next(new AppError('輸入數據無效', 400, errors.array()));
      }

      const { id } = req.params;
      const period = req.query.period as string || 'today';

      // 檢查店鋪權限
      const store = await prisma.store.findFirst({
        where: {
          id,
          tenantId: req.user!.tenantId,
        },
      });

      if (!store) {
        return next(new AppError('店鋪不存在', 404));
      }

      // 計算時間範圍
      const now = new Date();
      let startDate: Date;

      switch (period) {
        case 'today':
          startDate = new Date(now.getFullYear(), now.getMonth(), now.getDate());
          break;
        case 'week':
          startDate = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
          break;
        case 'month':
          startDate = new Date(now.getFullYear(), now.getMonth(), 1);
          break;
        case 'year':
          startDate = new Date(now.getFullYear(), 0, 1);
          break;
        default:
          startDate = new Date(now.getFullYear(), now.getMonth(), now.getDate());
      }

      // 獲取統計數據
      const [orderStats, revenueStats, productStats] = await Promise.all([
        // 訂單統計
        prisma.order.groupBy({
          by: ['status'],
          where: {
            storeId: id,
            createdAt: {
              gte: startDate,
            },
          },
          _count: {
            id: true,
          },
        }),
        // 營收統計
        prisma.order.aggregate({
          where: {
            storeId: id,
            status: 'COMPLETED',
            createdAt: {
              gte: startDate,
            },
          },
          _sum: {
            finalAmount: true,
          },
          _count: {
            id: true,
          },
        }),
        // 商品統計
        prisma.product.count({
          where: {
            storeId: id,
            isAvailable: true,
          },
        }),
      ]);

      // 熱門商品
      const popularProducts = await prisma.orderItem.groupBy({
        by: ['productId'],
        where: {
          order: {
            storeId: id,
            createdAt: {
              gte: startDate,
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
      });

      const popularProductsWithDetails = await Promise.all(
        popularProducts.map(async (item) => {
          const product = await prisma.product.findUnique({
            where: { id: item.productId },
            select: {
              id: true,
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

      res.json({
        message: '店鋪統計數據獲取成功',
        data: {
          period,
          orders: {
            total: orderStats.reduce((sum, stat) => sum + stat._count.id, 0),
            breakdown: orderStats.reduce((acc, stat) => {
              acc[stat.status.toLowerCase()] = stat._count.id;
              return acc;
            }, {} as Record<string, number>),
          },
          revenue: {
            total: revenueStats._sum.finalAmount || 0,
            completedOrders: revenueStats._count || 0,
          },
          products: {
            total: productStats,
            popular: popularProductsWithDetails,
          },
        },
      });
    } catch (error) {
      next(error);
    }
  }
);

export default router;