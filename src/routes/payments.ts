import express from 'express';
import { body, param, validationResult } from 'express-validator';
import { PrismaClient } from '@prisma/client';
import { AuthenticatedRequest } from '../middleware/auth';
import AppError from '../utils/AppError';
import logger from '../utils/logger';
import { LinePayService } from '../services/linePayService';
import { io } from '../server';

const router = express.Router();
const prisma = new PrismaClient();
const linePayService = new LinePayService();

/**
 * LINE Pay付款請求
 * POST /api/payments/line-pay/request
 */
router.post(
  '/line-pay/request',
  [
    body('orderId').isUUID().withMessage('訂單ID格式無效'),
    body('amount').isFloat({ min: 1 }).withMessage('金額必須大於0'),
    body('currency').optional().equals('TWD').withMessage('僅支援TWD貨幣'),
  ],
  async (req: AuthenticatedRequest, res, next) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return next(new AppError('輸入數據無效', 400, errors.array()));
      }

      const { orderId, amount, currency = 'TWD' } = req.body;

      // 驗證訂單
      const order = await prisma.order.findFirst({
        where: {
          id: orderId,
          customerId: req.user!.id,
          paymentStatus: 'PENDING',
        },
        include: {
          store: {
            select: {
              name: true,
              tenantId: true,
            },
          },
          items: {
            include: {
              product: {
                select: {
                  name: true,
                },
              },
            },
          },
        },
      });

      if (!order) {
        return next(new AppError('訂單不存在或已付款', 404));
      }

      // 驗證租戶權限
      if (order.store.tenantId !== req.user!.tenantId) {
        return next(new AppError('無權限處理此訂單', 403));
      }

      // 驗證金額
      if (Math.abs(parseFloat(amount) - parseFloat(order.finalAmount.toString())) > 0.01) {
        return next(new AppError('付款金額與訂單金額不符', 400));
      }

      // 構建商品名稱
      const productName = order.items.length === 1 
        ? order.items[0].product.name
        : `${order.store.name} - ${order.items.length}項商品`;

      // 發起LINE Pay付款請求
      const paymentRequest = {
        amount: parseFloat(amount),
        currency,
        orderId: order.orderNumber,
        productName,
        returnUrls: {
          confirmUrl: `${process.env.APP_URL}/api/payments/line-pay/confirm`,
          cancelUrl: `${process.env.APP_URL}/api/payments/line-pay/cancel`,
        },
        packages: [{
          id: order.id,
          amount: parseFloat(amount),
          products: order.items.map(item => ({
            id: item.product.id,
            name: item.product.name,
            quantity: item.quantity,
            price: parseFloat(item.unitPrice.toString()),
          })),
        }],
      };

      const paymentResponse = await linePayService.requestPayment(paymentRequest);

      if (!paymentResponse.success) {
        throw new AppError('LINE Pay付款請求失敗', 500);
      }

      // 創建付款記錄
      const payment = await prisma.payment.create({
        data: {
          orderId: order.id,
          amount: parseFloat(amount),
          method: 'LINE_PAY',
          status: 'PENDING',
          transactionId: paymentResponse.data.transactionId,
          gatewayResponse: paymentResponse.data,
        },
      });

      logger.info(`LINE Pay付款請求成功: 訂單${order.orderNumber}, 交易ID: ${paymentResponse.data.transactionId}`);

      res.json({
        message: 'LINE Pay付款請求成功',
        data: {
          paymentId: payment.id,
          transactionId: paymentResponse.data.transactionId,
          paymentUrl: paymentResponse.data.paymentUrl.web,
          paymentAccessToken: paymentResponse.data.paymentAccessToken,
        },
      });
    } catch (error) {
      next(error);
    }
  }
);

/**
 * LINE Pay付款確認
 * GET /api/payments/line-pay/confirm
 */
router.get('/line-pay/confirm', async (req, res, next) => {
  try {
    const { transactionId, orderId } = req.query;

    if (!transactionId || !orderId) {
      return next(new AppError('缺少必要參數', 400));
    }

    // 查找付款記錄
    const payment = await prisma.payment.findFirst({
      where: {
        transactionId: transactionId as string,
      },
      include: {
        order: {
          include: {
            store: true,
            customer: true,
          },
        },
      },
    });

    if (!payment) {
      return next(new AppError('付款記錄不存在', 404));
    }

    // 確認付款
    const confirmResponse = await linePayService.confirmPayment(
      transactionId as string,
      parseFloat(payment.amount.toString())
    );

    if (!confirmResponse.success) {
      // 付款確認失敗
      await prisma.payment.update({
        where: { id: payment.id },
        data: {
          status: 'FAILED',
          gatewayResponse: {
            ...payment.gatewayResponse,
            confirmResponse: confirmResponse.data,
          },
        },
      });

      throw new AppError('付款確認失敗', 400);
    }

    // 付款成功，更新記錄
    await Promise.all([
      // 更新付款記錄
      prisma.payment.update({
        where: { id: payment.id },
        data: {
          status: 'COMPLETED',
          paidAt: new Date(),
          gatewayResponse: {
            ...payment.gatewayResponse,
            confirmResponse: confirmResponse.data,
          },
        },
      }),
      // 更新訂單狀態
      prisma.order.update({
        where: { id: payment.orderId },
        data: {
          paymentStatus: 'COMPLETED',
          status: 'CONFIRMED',
          updatedAt: new Date(),
        },
      }),
      // 記錄訂單狀態變更
      prisma.orderStatusHistory.create({
        data: {
          orderId: payment.orderId,
          status: 'CONFIRMED',
          note: 'LINE Pay付款完成',
        },
      }),
    ]);

    // 發送即時通知
    io.to(`store:${payment.order.storeId}`).emit('orderUpdate', {
      orderId: payment.orderId,
      status: 'CONFIRMED',
      paymentStatus: 'COMPLETED',
      message: '新訂單已付款確認',
    });

    logger.info(`LINE Pay付款完成: 訂單${payment.order.orderNumber}, 金額: ${payment.amount}`);

    // 重定向到成功頁面
    res.redirect(`${process.env.FRONTEND_URL}/payment/success?orderId=${payment.orderId}`);
  } catch (error) {
    // 重定向到失敗頁面
    res.redirect(`${process.env.FRONTEND_URL}/payment/failure?error=${encodeURIComponent(error.message)}`);
  }
});

/**
 * LINE Pay付款取消
 * GET /api/payments/line-pay/cancel
 */
router.get('/line-pay/cancel', async (req, res) => {
  const { orderId } = req.query;
  
  logger.info(`LINE Pay付款取消: 訂單${orderId}`);
  
  // 重定向到取消頁面
  res.redirect(`${process.env.FRONTEND_URL}/payment/cancelled?orderId=${orderId}`);
});

/**
 * 查詢付款狀態
 * GET /api/payments/:paymentId/status
 */
router.get(
  '/:paymentId/status',
  [param('paymentId').isUUID().withMessage('付款ID格式無效')],
  async (req: AuthenticatedRequest, res, next) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return next(new AppError('輸入數據無效', 400, errors.array()));
      }

      const { paymentId } = req.params;

      const payment = await prisma.payment.findFirst({
        where: {
          id: paymentId,
          order: {
            store: {
              tenantId: req.user!.tenantId,
            },
          },
        },
        include: {
          order: {
            select: {
              id: true,
              orderNumber: true,
              status: true,
              paymentStatus: true,
            },
          },
        },
      });

      if (!payment) {
        return next(new AppError('付款記錄不存在', 404));
      }

      res.json({
        message: '付款狀態查詢成功',
        data: {
          payment: {
            id: payment.id,
            amount: payment.amount,
            method: payment.method,
            status: payment.status,
            transactionId: payment.transactionId,
            paidAt: payment.paidAt,
            createdAt: payment.createdAt,
          },
          order: payment.order,
        },
      });
    } catch (error) {
      next(error);
    }
  }
);

/**
 * 退款請求
 * POST /api/payments/:paymentId/refund
 */
router.post(
  '/:paymentId/refund',
  [
    param('paymentId').isUUID().withMessage('付款ID格式無效'),
    body('amount').optional().isFloat({ min: 0.01 }).withMessage('退款金額必須大於0'),
    body('reason').optional().isString().isLength({ max: 200 }).withMessage('退款原因不能超過200字符'),
  ],
  async (req: AuthenticatedRequest, res, next) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return next(new AppError('輸入數據無效', 400, errors.array()));
      }

      const { paymentId } = req.params;
      const { amount, reason } = req.body;

      // 查找付款記錄
      const payment = await prisma.payment.findFirst({
        where: {
          id: paymentId,
          status: 'COMPLETED',
          order: {
            store: {
              tenantId: req.user!.tenantId,
            },
          },
        },
        include: {
          order: true,
        },
      });

      if (!payment) {
        return next(new AppError('付款記錄不存在或狀態不允許退款', 404));
      }

      // 檢查用戶權限 (只有管理員可以退款)
      if (!req.user!.roles.some(role => ['TENANT_ADMIN', 'STORE_MANAGER', 'SUPER_ADMIN'].includes(role))) {
        return next(new AppError('權限不足', 403));
      }

      const refundAmount = amount ? parseFloat(amount) : parseFloat(payment.amount.toString());

      // 驗證退款金額
      if (refundAmount > parseFloat(payment.amount.toString())) {
        return next(new AppError('退款金額不能超過原付款金額', 400));
      }

      // 發起LINE Pay退款
      const refundResponse = await linePayService.refundPayment(
        payment.transactionId!,
        refundAmount
      );

      if (!refundResponse.success) {
        throw new AppError('退款請求失敗', 500);
      }

      // 更新付款記錄
      await prisma.payment.update({
        where: { id: payment.id },
        data: {
          status: 'REFUNDED',
          refundedAt: new Date(),
          gatewayResponse: {
            ...payment.gatewayResponse,
            refundResponse: refundResponse.data,
          },
        },
      });

      // 更新訂單狀態
      await Promise.all([
        prisma.order.update({
          where: { id: payment.orderId },
          data: {
            status: 'CANCELLED',
            paymentStatus: 'REFUNDED',
            updatedAt: new Date(),
          },
        }),
        prisma.orderStatusHistory.create({
          data: {
            orderId: payment.orderId,
            status: 'CANCELLED',
            note: `退款完成: ${reason || '系統退款'}`,
            createdBy: req.user!.id,
          },
        }),
      ]);

      logger.info(`退款完成: 訂單${payment.order.orderNumber}, 金額: ${refundAmount}`);

      res.json({
        message: '退款成功',
        data: {
          refundTransactionId: refundResponse.data.refundTransactionId,
          refundAmount,
        },
      });
    } catch (error) {
      next(error);
    }
  }
);

/**
 * 獲取付款歷史
 * GET /api/payments/history
 */
router.get('/history', async (req: AuthenticatedRequest, res, next) => {
  try {
    const { page = '1', limit = '20', status, method, orderId } = req.query;

    const pageNum = parseInt(page as string);
    const limitNum = parseInt(limit as string);
    const offset = (pageNum - 1) * limitNum;

    const whereClause: any = {
      order: {
        store: {
          tenantId: req.user!.tenantId,
        },
      },
    };

    if (status) {
      whereClause.status = status as string;
    }

    if (method) {
      whereClause.method = method as string;
    }

    if (orderId) {
      whereClause.orderId = orderId as string;
    }

    const [payments, total] = await Promise.all([
      prisma.payment.findMany({
        where: whereClause,
        include: {
          order: {
            select: {
              id: true,
              orderNumber: true,
              totalAmount: true,
              customer: {
                select: {
                  displayName: true,
                  email: true,
                },
              },
            },
          },
        },
        skip: offset,
        take: limitNum,
        orderBy: { createdAt: 'desc' },
      }),
      prisma.payment.count({ where: whereClause }),
    ]);

    res.json({
      message: '付款歷史查詢成功',
      data: {
        payments,
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
});

export default router;