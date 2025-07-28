import { PrismaClient } from '@prisma/client';
import logger from '../utils/logger';
import AppError from '../utils/AppError';

const prisma = new PrismaClient();

export interface OrderItem {
  productId: string;
  variantId?: string;
  quantity: number;
  unitPrice: number;
  totalPrice: number;
  note?: string;
  addons?: Array<{
    addonId: string;
    quantity: number;
    price: number;
  }>;
}

export class OrderService {
  /**
   * 驗證訂單項目並計算價格
   */
  async validateOrderItems(items: any[], storeId: string): Promise<OrderItem[]> {
    const validatedItems: OrderItem[] = [];

    for (const item of items) {
      // 查詢商品資訊
      const product = await prisma.product.findFirst({
        where: {
          id: item.productId,
          storeId,
          isAvailable: true,
        },
        include: {
          variants: true,
          addons: true,
          inventory: true,
        },
      });

      if (!product) {
        throw new AppError(`商品不存在或已下架: ${item.productId}`, 400);
      }

      // 檢查庫存
      if (product.inventory && product.inventory.quantity < item.quantity) {
        throw new AppError(`商品庫存不足: ${product.name}`, 400);
      }

      let unitPrice = parseFloat(product.basePrice.toString());

      // 處理規格變化
      if (item.variantId) {
        const variant = product.variants.find((v: any) => v.id === item.variantId);
        if (!variant) {
          throw new AppError(`商品規格不存在: ${item.variantId}`, 400);
        }
        unitPrice = parseFloat(variant.price.toString());
      }

      // 處理加購項目
      const validatedAddons: Array<{
        addonId: string;
        quantity: number;
        price: number;
      }> = [];

      if (item.addons && item.addons.length > 0) {
        for (const addon of item.addons) {
          const productAddon = product.addons.find((a: any) => a.id === addon.addonId);
          if (!productAddon) {
            throw new AppError(`加購項目不存在: ${addon.addonId}`, 400);
          }

          // 檢查數量限制
          if (addon.quantity > productAddon.maxQuantity) {
            throw new AppError(`加購項目數量超過限制: ${productAddon.name}`, 400);
          }

          validatedAddons.push({
            addonId: addon.addonId,
            quantity: addon.quantity,
            price: parseFloat(productAddon.price.toString()),
          });

          // 將加購項目價格加入單價
          unitPrice += parseFloat(productAddon.price.toString()) * addon.quantity;
        }
      }

      const totalPrice = unitPrice * item.quantity;

      validatedItems.push({
        productId: item.productId,
        variantId: item.variantId,
        quantity: item.quantity,
        unitPrice,
        totalPrice,
        note: item.note,
        addons: validatedAddons.length > 0 ? validatedAddons : undefined,
      });
    }

    return validatedItems;
  }

  /**
   * 驗證優惠券
   */
  async validateCoupon(couponCode: string, storeId: string, orderAmount: number) {
    const coupon = await prisma.coupon.findFirst({
      where: {
        code: couponCode,
        storeId,
        isActive: true,
        validFrom: { lte: new Date() },
        validUntil: { gte: new Date() },
      },
    });

    if (!coupon) {
      throw new AppError('優惠券不存在或已過期', 400);
    }

    // 檢查使用次數
    if (coupon.usageLimit && coupon.usedCount >= coupon.usageLimit) {
      throw new AppError('優惠券使用次數已達上限', 400);
    }

    // 檢查最低消費金額
    if (coupon.minOrderAmount && orderAmount < parseFloat(coupon.minOrderAmount.toString())) {
      throw new AppError(`最低消費金額為 ${coupon.minOrderAmount}`, 400);
    }

    return coupon;
  }

  /**
   * 計算折扣金額
   */
  calculateDiscount(coupon: any, orderAmount: number): number {
    let discount = 0;

    switch (coupon.type) {
      case 'PERCENTAGE':
        discount = orderAmount * (parseFloat(coupon.value.toString()) / 100);
        break;
      case 'FIXED_AMOUNT':
        discount = parseFloat(coupon.value.toString());
        break;
      case 'FREE_SHIPPING':
        // 這裡可以根據實際配送費計算
        discount = 0;
        break;
    }

    // 檢查最大折扣限制
    if (coupon.maxDiscount && discount > parseFloat(coupon.maxDiscount.toString())) {
      discount = parseFloat(coupon.maxDiscount.toString());
    }

    return Math.min(discount, orderAmount);
  }

  /**
   * 生成訂單號碼
   */
  async generateOrderNumber(storeId: string): Promise<string> {
    const today = new Date();
    const dateStr = today.toISOString().slice(0, 10).replace(/-/g, '');
    
    // 獲取今日訂單數量
    const startOfDay = new Date(today.getFullYear(), today.getMonth(), today.getDate());
    const endOfDay = new Date(startOfDay.getTime() + 24 * 60 * 60 * 1000);
    
    const todayOrderCount = await prisma.order.count({
      where: {
        storeId,
        createdAt: {
          gte: startOfDay,
          lt: endOfDay,
        },
      },
    });

    const sequence = (todayOrderCount + 1).toString().padStart(4, '0');
    return `${dateStr}${sequence}`;
  }

  /**
   * 計算預估準備時間
   */
  calculateEstimatedTime(items: OrderItem[]): number {
    // 基礎時間：10分鐘
    let baseTime = 10;
    
    // 根據商品數量增加時間
    const totalQuantity = items.reduce((sum, item) => sum + item.quantity, 0);
    const additionalTime = Math.max(0, (totalQuantity - 1) * 2);
    
    // 複雜商品額外時間
    const complexItems = items.filter(item => item.addons && item.addons.length > 0);
    const complexityTime = complexItems.length * 3;
    
    return baseTime + additionalTime + complexityTime;
  }

  /**
   * 驗證訂單狀態轉換是否合法
   */
  validateStatusTransition(currentStatus: string, newStatus: string): boolean {
    const validTransitions: Record<string, string[]> = {
      PENDING: ['CONFIRMED', 'CANCELLED'],
      CONFIRMED: ['PREPARING', 'CANCELLED'],
      PREPARING: ['READY', 'CANCELLED'],
      READY: ['COMPLETED'],
      COMPLETED: [], // 已完成的訂單不能再轉換
      CANCELLED: [], // 已取消的訂單不能再轉換
    };

    return validTransitions[currentStatus]?.includes(newStatus) || false;
  }

  /**
   * 獲取狀態顯示訊息
   */
  getStatusMessage(status: string): string {
    const statusMessages: Record<string, string> = {
      PENDING: '訂單待確認',
      CONFIRMED: '訂單已確認',
      PREPARING: '製作中',
      READY: '製作完成，請取餐',
      COMPLETED: '訂單已完成',
      CANCELLED: '訂單已取消',
    };

    return statusMessages[status] || '狀態未知';
  }

  /**
   * 計算剩餘等待時間
   */
  calculateRemainingTime(order: any): number {
    if (!order.estimatedTime || ['COMPLETED', 'CANCELLED'].includes(order.status)) {
      return 0;
    }

    const createdAt = new Date(order.createdAt);
    const estimatedCompletionTime = new Date(createdAt.getTime() + order.estimatedTime * 60 * 1000);
    const now = new Date();
    
    const remainingMs = estimatedCompletionTime.getTime() - now.getTime();
    return Math.max(0, Math.ceil(remainingMs / (60 * 1000))); // 返回分鐘數
  }

  /**
   * 處理訂單完成後的後續操作
   */
  async handleOrderCompletion(order: any): Promise<void> {
    try {
      // 更新會員積分
      await this.updateMemberPoints(order.customerId, order.finalAmount);
      
      // 更新商品銷量統計
      await this.updateProductSalesStats(order.items);
      
      // 更新客戶消費記錄
      await this.updateCustomerSpending(order.customerId, order.finalAmount);
      
      logger.info(`訂單完成後續處理完成: ${order.orderNumber}`);
    } catch (error) {
      logger.error('訂單完成後續處理失敗:', error);
    }
  }

  /**
   * 更新會員積分
   */
  private async updateMemberPoints(customerId: string, orderAmount: number): Promise<void> {
    const points = Math.floor(parseFloat(orderAmount.toString()) / 10); // 每10元1積分
    
    if (points > 0) {
      await prisma.memberPoint.create({
        data: {
          userId: customerId,
          points,
          type: 'EARN',
          description: `訂單消費獲得積分`,
        },
      });
    }
  }

  /**
   * 更新商品銷量統計
   */
  private async updateProductSalesStats(orderItems: any[]): Promise<void> {
    for (const item of orderItems) {
      // 這裡可以實作商品銷量統計邏輯
      // 例如更新商品的銷量計數、熱門度等
      logger.debug(`更新商品銷量: ${item.productId}, 數量: ${item.quantity}`);
    }
  }

  /**
   * 更新客戶消費記錄
   */
  private async updateCustomerSpending(customerId: string, amount: number): Promise<void> {
    await prisma.customerProfile.updateMany({
      where: { userId: customerId },
      data: {
        totalSpent: {
          increment: parseFloat(amount.toString()),
        },
      },
    });

    // 檢查是否需要升級會員等級
    const customerProfile = await prisma.customerProfile.findFirst({
      where: { userId: customerId },
    });

    if (customerProfile) {
      const newTier = this.calculateLoyaltyTier(parseFloat(customerProfile.totalSpent.toString()));
      if (newTier !== customerProfile.loyaltyTier) {
        await prisma.customerProfile.update({
          where: { userId: customerId },
          data: { loyaltyTier: newTier },
        });
        
        logger.info(`客戶會員等級升級: ${customerId} -> ${newTier}`);
      }
    }
  }

  /**
   * 計算會員等級
   */
  private calculateLoyaltyTier(totalSpent: number): string {
    if (totalSpent >= 10000) return 'PLATINUM';
    if (totalSpent >= 5000) return 'GOLD';
    if (totalSpent >= 1000) return 'SILVER';
    return 'BRONZE';
  }

  /**
   * 獲取訂單統計數據
   */
  async getOrderStats(storeId: string, period: 'today' | 'week' | 'month' = 'today') {
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
    }

    const [orderCount, revenue, avgOrderValue] = await Promise.all([
      prisma.order.count({
        where: {
          storeId,
          status: 'COMPLETED',
          createdAt: { gte: startDate },
        },
      }),
      prisma.order.aggregate({
        where: {
          storeId,
          status: 'COMPLETED',
          createdAt: { gte: startDate },
        },
        _sum: { finalAmount: true },
      }),
      prisma.order.aggregate({
        where: {
          storeId,
          status: 'COMPLETED',
          createdAt: { gte: startDate },
        },
        _avg: { finalAmount: true },
      }),
    ]);

    return {
      orderCount,
      revenue: revenue._sum.finalAmount || 0,
      avgOrderValue: avgOrderValue._avg.finalAmount || 0,
    };
  }
}