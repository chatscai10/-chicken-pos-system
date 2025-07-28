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
 * 獲取商品分類列表
 * GET /api/products/categories
 */
router.get(
  '/categories',
  [
    query('storeId').isUUID().withMessage('店鋪ID格式無效'),
    query('isActive').optional().isBoolean().withMessage('狀態值必須是布爾值'),
  ],
  async (req: AuthenticatedRequest, res, next) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return next(new AppError('輸入數據無效', 400, errors.array()));
      }

      const { storeId, isActive } = req.query;

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

      const whereClause: any = {
        storeId: storeId as string,
      };

      if (isActive !== undefined) {
        whereClause.isActive = isActive === 'true';
      }

      const categories = await prisma.category.findMany({
        where: whereClause,
        include: {
          _count: {
            select: {
              products: true,
            },
          },
        },
        orderBy: [
          { sortOrder: 'asc' },
          { createdAt: 'asc' },
        ],
      });

      res.json({
        message: '商品分類列表獲取成功',
        data: { categories },
      });
    } catch (error) {
      next(error);
    }
  }
);

/**
 * 創建商品分類
 * POST /api/products/categories
 */
router.post(
  '/categories',
  requireRoles('TENANT_ADMIN', 'STORE_MANAGER'),
  uploadMiddleware.single('image'),
  [
    body('storeId').isUUID().withMessage('店鋪ID格式無效'),
    body('name').trim().isLength({ min: 1, max: 50 }).withMessage('分類名稱長度必須在1-50字符之間'),
    body('description').optional().isString().isLength({ max: 200 }).withMessage('描述不能超過200字符'),
    body('sortOrder').optional().isInt({ min: 0 }).withMessage('排序值必須是非負整數'),
  ],
  async (req: AuthenticatedRequest, res, next) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return next(new AppError('輸入數據無效', 400, errors.array()));
      }

      const { storeId, name, description, sortOrder } = req.body;
      const imageFile = req.file;

      // 驗證店鋪權限
      const store = await prisma.store.findFirst({
        where: {
          id: storeId,
          tenantId: req.user!.tenantId,
        },
      });

      if (!store) {
        return next(new AppError('店鋪不存在或無權限', 404));
      }

      // 檢查分類名稱是否重複
      const existingCategory = await prisma.category.findFirst({
        where: {
          storeId,
          name,
        },
      });

      if (existingCategory) {
        return next(new AppError('分類名稱已存在', 409));
      }

      // 處理圖片上傳
      let imageUrl = null;
      if (imageFile) {
        // 這裡應該上傳到Azure Blob Storage
        // 暫時使用本地路徑
        imageUrl = `/uploads/categories/${imageFile.filename}`;
      }

      const category = await prisma.category.create({
        data: {
          storeId,
          name,
          description,
          image: imageUrl,
          sortOrder: sortOrder ? parseInt(sortOrder) : 0,
          isActive: true,
        },
      });

      logger.info(`商品分類創建成功: ${name} (店鋪ID: ${storeId})`);

      res.status(201).json({
        message: '商品分類創建成功',
        data: { category },
      });
    } catch (error) {
      next(error);
    }
  }
);

/**
 * 獲取商品列表
 * GET /api/products
 */
router.get(
  '/',
  [
    query('storeId').isUUID().withMessage('店鋪ID格式無效'),
    query('categoryId').optional().isUUID().withMessage('分類ID格式無效'),
    query('isAvailable').optional().isBoolean().withMessage('可用狀態必須是布爾值'),
    query('page').optional().isInt({ min: 1 }).withMessage('頁碼必須是正整數'),
    query('limit').optional().isInt({ min: 1, max: 100 }).withMessage('每頁數量必須在1-100之間'),
    query('search').optional().isString().withMessage('搜尋關鍵字必須是字符串'),
  ],
  async (req: AuthenticatedRequest, res, next) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return next(new AppError('輸入數據無效', 400, errors.array()));
      }

      const {
        storeId,
        categoryId,
        isAvailable,
        page = '1',
        limit = '20',
        search,
      } = req.query;

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

      const pageNum = parseInt(page as string);
      const limitNum = parseInt(limit as string);
      const offset = (pageNum - 1) * limitNum;

      const whereClause: any = {
        storeId: storeId as string,
      };

      if (categoryId) {
        whereClause.categoryId = categoryId as string;
      }

      if (isAvailable !== undefined) {
        whereClause.isAvailable = isAvailable === 'true';
      }

      if (search) {
        whereClause.OR = [
          { name: { contains: search as string } },
          { description: { contains: search as string } },
        ];
      }

      const [products, total] = await Promise.all([
        prisma.product.findMany({
          where: whereClause,
          include: {
            category: {
              select: {
                id: true,
                name: true,
              },
            },
            variants: true,
            addons: true,
            inventory: true,
          },
          skip: offset,
          take: limitNum,
          orderBy: [
            { sortOrder: 'asc' },
            { createdAt: 'desc' },
          ],
        }),
        prisma.product.count({ where: whereClause }),
      ]);

      res.json({
        message: '商品列表獲取成功',
        data: {
          products,
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
 * 獲取單個商品詳細資訊
 * GET /api/products/:id
 */
router.get(
  '/:id',
  [param('id').isUUID().withMessage('商品ID格式無效')],
  async (req: AuthenticatedRequest, res, next) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return next(new AppError('輸入數據無效', 400, errors.array()));
      }

      const { id } = req.params;

      const product = await prisma.product.findFirst({
        where: {
          id,
          store: {
            tenantId: req.user!.tenantId,
          },
        },
        include: {
          category: true,
          variants: {
            orderBy: { isDefault: 'desc' },
          },
          addons: true,
          inventory: true,
          store: {
            select: {
              id: true,
              name: true,
            },
          },
        },
      });

      if (!product) {
        return next(new AppError('商品不存在', 404));
      }

      res.json({
        message: '商品詳細資訊獲取成功',
        data: { product },
      });
    } catch (error) {
      next(error);
    }
  }
);

/**
 * 創建商品
 * POST /api/products
 */
router.post(
  '/',
  requireRoles('TENANT_ADMIN', 'STORE_MANAGER'),
  uploadMiddleware.single('image'),
  [
    body('storeId').isUUID().withMessage('店鋪ID格式無效'),
    body('categoryId').isUUID().withMessage('分類ID格式無效'),
    body('name').trim().isLength({ min: 1, max: 100 }).withMessage('商品名稱長度必須在1-100字符之間'),
    body('description').optional().isString().isLength({ max: 500 }).withMessage('描述不能超過500字符'),
    body('basePrice').isFloat({ min: 0 }).withMessage('基礎價格必須是非負數'),
    body('variants').optional().isArray().withMessage('規格變化必須是數組'),
    body('addons').optional().isArray().withMessage('加購選項必須是數組'),
    body('inventory').optional().isObject().withMessage('庫存資訊必須是對象'),
  ],
  async (req: AuthenticatedRequest, res, next) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return next(new AppError('輸入數據無效', 400, errors.array()));
      }

      const {
        storeId,
        categoryId,
        name,
        description,
        basePrice,
        variants,
        addons,
        inventory,
      } = req.body;
      const imageFile = req.file;

      // 驗證店鋪和分類權限
      const [store, category] = await Promise.all([
        prisma.store.findFirst({
          where: {
            id: storeId,
            tenantId: req.user!.tenantId,
          },
        }),
        prisma.category.findFirst({
          where: {
            id: categoryId,
            storeId,
          },
        }),
      ]);

      if (!store) {
        return next(new AppError('店鋪不存在或無權限', 404));
      }

      if (!category) {
        return next(new AppError('商品分類不存在', 404));
      }

      // 檢查商品名稱是否重複
      const existingProduct = await prisma.product.findFirst({
        where: {
          storeId,
          name,
        },
      });

      if (existingProduct) {
        return next(new AppError('商品名稱已存在', 409));
      }

      // 處理圖片上傳
      let imageUrl = null;
      if (imageFile) {
        imageUrl = `/uploads/products/${imageFile.filename}`;
      }

      // 創建商품
      const product = await prisma.product.create({
        data: {
          storeId,
          categoryId,
          name,
          description,
          basePrice: parseFloat(basePrice),
          image: imageUrl,
          isAvailable: true,
          variants: variants ? {
            create: variants.map((variant: any) => ({
              name: variant.name,
              price: parseFloat(variant.price),
              isDefault: variant.isDefault || false,
            })),
          } : undefined,
          addons: addons ? {
            create: addons.map((addon: any) => ({
              name: addon.name,
              price: parseFloat(addon.price),
              isRequired: addon.isRequired || false,
              maxQuantity: addon.maxQuantity || 1,
            })),
          } : undefined,
          inventory: inventory ? {
            create: {
              quantity: inventory.quantity || 0,
              minQuantity: inventory.minQuantity || 0,
              unit: inventory.unit || '個',
            },
          } : undefined,
        },
        include: {
          variants: true,
          addons: true,
          inventory: true,
        },
      });

      logger.info(`商品創建成功: ${name} (店鋪ID: ${storeId})`);

      res.status(201).json({
        message: '商品創建成功',
        data: { product },
      });
    } catch (error) {
      next(error);
    }
  }
);

/**
 * 更新商品
 * PUT /api/products/:id
 */
router.put(
  '/:id',
  requireRoles('TENANT_ADMIN', 'STORE_MANAGER'),
  uploadMiddleware.single('image'),
  [
    param('id').isUUID().withMessage('商品ID格式無效'),
    body('name').optional().trim().isLength({ min: 1, max: 100 }).withMessage('商品名稱長度必須在1-100字符之間'),
    body('description').optional().isString().isLength({ max: 500 }).withMessage('描述不能超過500字符'),
    body('basePrice').optional().isFloat({ min: 0 }).withMessage('基礎價格必須是非負數'),
    body('isAvailable').optional().isBoolean().withMessage('可用狀態必須是布爾值'),
  ],
  async (req: AuthenticatedRequest, res, next) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return next(new AppError('輸入數據無效', 400, errors.array()));
      }

      const { id } = req.params;
      const updateData = req.body;
      const imageFile = req.file;

      // 檢查商品是否存在及權限
      const existingProduct = await prisma.product.findFirst({
        where: {
          id,
          store: {
            tenantId: req.user!.tenantId,
          },
        },
      });

      if (!existingProduct) {
        return next(new AppError('商品不存在', 404));
      }

      // 檢查名稱重複
      if (updateData.name && updateData.name !== existingProduct.name) {
        const duplicateProduct = await prisma.product.findFirst({
          where: {
            storeId: existingProduct.storeId,
            name: updateData.name,
            id: { not: id },
          },
        });

        if (duplicateProduct) {
          return next(new AppError('商品名稱已存在', 409));
        }
      }

      // 處理圖片上傳
      if (imageFile) {
        updateData.image = `/uploads/products/${imageFile.filename}`;
      }

      // 轉換數據類型
      if (updateData.basePrice) {
        updateData.basePrice = parseFloat(updateData.basePrice);
      }

      const updatedProduct = await prisma.product.update({
        where: { id },
        data: {
          ...updateData,
          updatedAt: new Date(),
        },
        include: {
          variants: true,
          addons: true,
          inventory: true,
          category: true,
        },
      });

      logger.info(`商品更新成功: ${updatedProduct.name} (ID: ${id})`);

      res.json({
        message: '商品更新成功',
        data: { product: updatedProduct },
      });
    } catch (error) {
      next(error);
    }
  }
);

/**
 * 刪除商品
 * DELETE /api/products/:id
 */
router.delete(
  '/:id',
  requireRoles('TENANT_ADMIN', 'STORE_MANAGER'),
  [param('id').isUUID().withMessage('商品ID格式無效')],
  async (req: AuthenticatedRequest, res, next) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return next(new AppError('輸入數據無效', 400, errors.array()));
      }

      const { id } = req.params;

      // 檢查商品是否存在及權限
      const product = await prisma.product.findFirst({
        where: {
          id,
          store: {
            tenantId: req.user!.tenantId,
          },
        },
        include: {
          _count: {
            select: {
              orderItems: true,
            },
          },
        },
      });

      if (!product) {
        return next(new AppError('商品不存在', 404));
      }

      // 檢查是否有相關訂單
      if (product._count.orderItems > 0) {
        // 軟刪除 - 設為不可用
        await prisma.product.update({
          where: { id },
          data: {
            isAvailable: false,
            updatedAt: new Date(),
          },
        });

        logger.info(`商品軟刪除: ${product.name} (ID: ${id})`);

        return res.json({
          message: '商品已停用（因存在相關訂單）',
        });
      }

      // 硬刪除
      await prisma.product.delete({
        where: { id },
      });

      logger.info(`商品刪除成功: ${product.name} (ID: ${id})`);

      res.json({
        message: '商品刪除成功',
      });
    } catch (error) {
      next(error);
    }
  }
);

/**
 * 批量更新商品狀態
 * PATCH /api/products/batch-status
 */
router.patch(
  '/batch-status',
  requireRoles('TENANT_ADMIN', 'STORE_MANAGER'),
  [
    body('productIds').isArray({ min: 1 }).withMessage('商品ID列表不能為空'),
    body('productIds.*').isUUID().withMessage('商品ID格式無效'),
    body('isAvailable').isBoolean().withMessage('可用狀態必須是布爾值'),
  ],
  async (req: AuthenticatedRequest, res, next) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return next(new AppError('輸入數據無效', 400, errors.array()));
      }

      const { productIds, isAvailable } = req.body;

      // 驗證所有商品都屬於當前租戶
      const products = await prisma.product.findMany({
        where: {
          id: { in: productIds },
          store: {
            tenantId: req.user!.tenantId,
          },
        },
      });

      if (products.length !== productIds.length) {
        return next(new AppError('部分商品不存在或無權限', 404));
      }

      // 批量更新
      const result = await prisma.product.updateMany({
        where: {
          id: { in: productIds },
        },
        data: {
          isAvailable,
          updatedAt: new Date(),
        },
      });

      logger.info(`批量更新商品狀態: ${result.count}個商品設為${isAvailable ? '可用' : '不可用'}`);

      res.json({
        message: `成功更新${result.count}個商品狀態`,
        data: { updatedCount: result.count },
      });
    } catch (error) {
      next(error);
    }
  }
);

export default router;