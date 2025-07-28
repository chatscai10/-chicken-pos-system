import express from 'express';
import { body, param, query, validationResult } from 'express-validator';
import { PrismaClient } from '@prisma/client';
import { AuthenticatedRequest } from '../middleware/auth';
import { requireRoles } from '../middleware/auth';
import AppError from '../utils/AppError';
import logger from '../utils/logger';

const router = express.Router();
const prisma = new PrismaClient();

/**
 * 創建新租戶 (Super Admin Only)
 * POST /api/admin/tenants
 */
router.post(
  '/tenants',
  requireRoles('SUPER_ADMIN'),
  [
    body('name').trim().isLength({ min: 1, max: 100 }).withMessage('租戶名稱長度必須在1-100字符之間'),
    body('domain').optional().isString().isLength({ max: 50 }).withMessage('域名不能超過50字符'),
    body('adminEmail').isEmail().withMessage('管理員郵箱格式無效'),
    body('adminPassword').isLength({ min: 8 }).withMessage('管理員密碼至少需要8個字符'),
    body('planType').isIn(['FREE', 'PROFESSIONAL', 'ENTERPRISE', 'CUSTOM']).withMessage('方案類型無效'),
    body('settings').optional().isObject().withMessage('設定必須是對象格式'),
  ],
  async (req: AuthenticatedRequest, res, next) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return next(new AppError('輸入數據無效', 400, errors.array()));
      }

      const { name, domain, adminEmail, adminPassword, planType, settings } = req.body;

      // 檢查域名是否已存在
      if (domain) {
        const existingTenant = await prisma.tenant.findUnique({
          where: { domain },
        });

        if (existingTenant) {
          return next(new AppError('域名已被使用', 409));
        }
      }

      // 檢查管理員郵箱是否已存在
      const existingUser = await prisma.user.findFirst({
        where: { email: adminEmail },
      });

      if (existingUser) {
        return next(new AppError('管理員郵箱已被使用', 409));
      }

      // 創建租戶
      const tenant = await prisma.tenant.create({
        data: {
          name,
          domain,
          status: 'ACTIVE',
          settings,
        },
      });

      // 創建訂閱記錄
      const now = new Date();
      const endDate = new Date(now.getFullYear(), now.getMonth() + 1, now.getDate());

      await prisma.tenantSubscription.create({
        data: {
          tenantId: tenant.id,
          planType,
          status: planType === 'FREE' ? 'ACTIVE' : 'TRIAL',
          currentPeriodStart: now,
          currentPeriodEnd: endDate,
          trialEnd: planType !== 'FREE' ? endDate : null,
          billingCycle: 'MONTHLY',
          price: getPlanPrice(planType),
          currency: 'TWD',
          features: getPlanFeatures(planType),
        },
      });

      // 創建租戶管理員用戶
      const bcrypt = require('bcryptjs');
      const hashedPassword = await bcrypt.hash(adminPassword, 12);

      const adminUser = await prisma.user.create({
        data: {
          tenantId: tenant.id,
          email: adminEmail,
          password: hashedPassword,
          displayName: 'Administrator',
          status: 'ACTIVE',
        },
      });

      // 分配租戶管理員角色
      const adminRole = await prisma.role.findFirst({
        where: { name: 'TENANT_ADMIN' },
      });

      if (adminRole) {
        await prisma.userRole.create({
          data: {
            userId: adminUser.id,
            roleId: adminRole.id,
          },
        });
      }

      logger.info(`新租戶創建成功: ${name} (管理員: ${adminEmail})`);

      res.status(201).json({
        message: '租戶創建成功',
        data: {
          tenant: {
            id: tenant.id,
            name: tenant.name,
            domain: tenant.domain,
            status: tenant.status,
          },
          admin: {
            email: adminUser.email,
            displayName: adminUser.displayName,
          },
        },
      });
    } catch (error) {
      next(error);
    }
  }
);

/**
 * 獲取租戶列表
 * GET /api/admin/tenants
 */
router.get(
  '/tenants',
  requireRoles('SUPER_ADMIN'),
  [
    query('page').optional().isInt({ min: 1 }).withMessage('頁碼必須是正整數'),
    query('limit').optional().isInt({ min: 1, max: 100 }).withMessage('每頁數量必須在1-100之間'),
    query('status').optional().isIn(['ACTIVE', 'SUSPENDED', 'CANCELLED']).withMessage('狀態值無效'),
    query('planType').optional().isIn(['FREE', 'PROFESSIONAL', 'ENTERPRISE', 'CUSTOM']).withMessage('方案類型無效'),
  ],
  async (req: AuthenticatedRequest, res, next) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return next(new AppError('輸入數據無效', 400, errors.array()));
      }

      const page = parseInt(req.query.page as string) || 1;
      const limit = parseInt(req.query.limit as string) || 20;
      const status = req.query.status as string;
      const planType = req.query.planType as string;
      const offset = (page - 1) * limit;

      const whereClause: any = {};

      if (status) {
        whereClause.status = status;
      }

      if (planType) {
        whereClause.subscription = {
          planType,
        };
      }

      const [tenants, total] = await Promise.all([
        prisma.tenant.findMany({
          where: whereClause,
          include: {
            subscription: {
              select: {
                planType: true,
                status: true,
                currentPeriodEnd: true,
                price: true,
              },
            },
            stores: {
              select: {
                id: true,
                name: true,
                status: true,
              },
            },
            users: {
              where: {
                roles: {
                  some: {
                    role: {
                      name: 'TENANT_ADMIN',
                    },
                  },
                },
              },
              select: {
                email: true,
                displayName: true,
                lastLoginAt: true,
              },
            },
            _count: {
              select: {
                users: true,
                stores: true,
              },
            },
          },
          skip: offset,
          take: limit,
          orderBy: { createdAt: 'desc' },
        }),
        prisma.tenant.count({ where: whereClause }),
      ]);

      res.json({
        message: '租戶列表獲取成功',
        data: {
          tenants,
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
 * 更新租戶狀態
 * PATCH /api/admin/tenants/:id/status
 */
router.patch(
  '/tenants/:id/status',
  requireRoles('SUPER_ADMIN'),
  [
    param('id').isUUID().withMessage('租戶ID格式無效'),
    body('status').isIn(['ACTIVE', 'SUSPENDED', 'CANCELLED']).withMessage('狀態值無效'),
    body('reason').optional().isString().isLength({ max: 200 }).withMessage('原因不能超過200字符'),
  ],
  async (req: AuthenticatedRequest, res, next) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return next(new AppError('輸入數據無效', 400, errors.array()));
      }

      const { id } = req.params;
      const { status, reason } = req.body;

      const tenant = await prisma.tenant.findUnique({
        where: { id },
      });

      if (!tenant) {
        return next(new AppError('租戶不存在', 404));
      }

      const updatedTenant = await prisma.tenant.update({
        where: { id },
        data: {
          status,
          updatedAt: new Date(),
        },
      });

      logger.info(`租戶狀態更新: ${tenant.name} -> ${status} (原因: ${reason || 'N/A'})`);

      res.json({
        message: '租戶狀態更新成功',
        data: { tenant: updatedTenant },
      });
    } catch (error) {
      next(error);
    }
  }
);

/**
 * 獲取系統統計
 * GET /api/admin/statistics
 */
router.get(
  '/statistics',
  requireRoles('SUPER_ADMIN'),
  async (req: AuthenticatedRequest, res, next) => {
    try {
      const [
        tenantStats,
        subscriptionStats,
        orderStats,
        revenueStats,
        activeTenantsThisMonth,
      ] = await Promise.all([
        // 租戶統計
        prisma.tenant.groupBy({
          by: ['status'],
          _count: {
            id: true,
          },
        }),
        // 訂閱統計
        prisma.tenantSubscription.groupBy({
          by: ['planType'],
          _count: {
            id: true,
          },
          _sum: {
            price: true,
          },
        }),
        // 訂單統計 (最近30天)
        prisma.order.aggregate({
          where: {
            createdAt: {
              gte: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000),
            },
          },
          _count: {
            id: true,
          },
          _sum: {
            finalAmount: true,
          },
        }),
        // 收入統計 (最近12個月)
        prisma.tenantSubscription.aggregate({
          where: {
            status: 'ACTIVE',
            currentPeriodStart: {
              gte: new Date(Date.now() - 365 * 24 * 60 * 60 * 1000),
            },
          },
          _sum: {
            price: true,
          },
        }),
        // 本月活躍租戶
        prisma.tenant.count({
          where: {
            status: 'ACTIVE',
            stores: {
              some: {
                orders: {
                  some: {
                    createdAt: {
                      gte: new Date(new Date().getFullYear(), new Date().getMonth(), 1),
                    },
                  },
                },
              },
            },
          },
        }),
      ]);

      res.json({
        message: '系統統計獲取成功',
        data: {
          tenants: {
            total: tenantStats.reduce((sum: any, stat: any) => sum + stat._count.id, 0),
            breakdown: tenantStats.reduce((acc: any, stat: any) => {
              acc[stat.status.toLowerCase()] = stat._count.id;
              return acc;
            }, {} as Record<string, number>),
            activeThisMonth: activeTenantsThisMonth,
          },
          subscriptions: {
            breakdown: subscriptionStats.reduce((acc, stat) => {
              acc[stat.planType.toLowerCase()] = {
                count: stat._count.id,
                revenue: parseFloat(stat._sum.price?.toString() || '0'),
              };
              return acc;
            }, {} as Record<string, any>),
            totalRevenue: parseFloat(revenueStats._sum.price?.toString() || '0'),
          },
          orders: {
            totalOrders: orderStats._count.id || 0,
            totalRevenue: parseFloat(orderStats._sum.finalAmount?.toString() || '0'),
          },
          generatedAt: new Date().toISOString(),
        },
      });
    } catch (error) {
      next(error);
    }
  }
);

/**
 * 獲取方案價格
 */
function getPlanPrice(planType: string): number {
  const prices: Record<string, number> = {
    FREE: 0,
    PROFESSIONAL: 3000,
    ENTERPRISE: 8000,
    CUSTOM: 0, // 需要另外設定
  };
  return prices[planType] || 0;
}

/**
 * 獲取方案功能
 */
function getPlanFeatures(planType: string): any {
  const features: Record<string, any> = {
    FREE: {
      maxStores: 1,
      maxProducts: 50,
      maxOrders: 100,
      features: ['基本點餐', '基本報表'],
    },
    PROFESSIONAL: {
      maxStores: 3,
      maxProducts: 500,
      maxOrders: 1000,
      features: ['完整功能', 'LINE Pay整合', '雲端打印', '進階報表'],
    },
    ENTERPRISE: {
      maxStores: -1, // 無限制
      maxProducts: -1,
      maxOrders: -1,
      features: ['所有功能', 'API存取', 'Uber Eats整合', '客製化支援'],
    },
    CUSTOM: {
      maxStores: -1,
      maxProducts: -1,
      maxOrders: -1,
      features: ['客製化功能'],
    },
  };
  return features[planType] || features.FREE;
}

export default router;