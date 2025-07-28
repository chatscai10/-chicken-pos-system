import { Server } from 'socket.io';
import { PrismaClient } from '@prisma/client';
import jwt from 'jsonwebtoken';
import logger from '../utils/logger';

const prisma = new PrismaClient();

export class SocketManager {
  private io: Server;

  constructor(io: Server) {
    this.io = io;
    this.setupSocketHandlers();
  }

  private setupSocketHandlers() {
    // Socket.IO認證中間件
    this.io.use(async (socket, next) => {
      try {
        const token = socket.handshake.auth.token;
        
        if (!token) {
          throw new Error('未提供認證令牌');
        }

        const decoded = jwt.verify(token, process.env.JWT_SECRET!) as any;
        
        const user = await prisma.user.findUnique({
          where: { id: decoded.userId },
          include: {
            roles: {
              include: {
                role: true,
              },
            },
          },
        });

        if (!user || user.status !== 'ACTIVE') {
          throw new Error('用戶不存在或已被停用');
        }

        socket.data.user = {
          id: user.id,
          tenantId: user.tenantId,
          email: user.email,
          displayName: user.displayName,
          roles: user.roles.map((ur: any) => ur.role.name),
        };

        next();
      } catch (error) {
        logger.warn('Socket認證失敗:', (error as Error).message);
        next(new Error('認證失敗'));
      }
    });

    // 連接處理
    this.io.on('connection', (socket) => {
      const user = socket.data.user;
      logger.info(`用戶連接Socket: ${user.displayName} (${socket.id})`);

      // 自動加入租戶房間
      socket.join(`tenant:${user.tenantId}`);
      socket.join(`user:${user.id}`);

      // 設置用戶狀態處理器
      this.setupUserHandlers(socket);
      this.setupOrderHandlers(socket);
      this.setupStoreHandlers(socket);
      this.setupNotificationHandlers(socket);

      // 斷開連接處理
      socket.on('disconnect', (reason) => {
        logger.info(`用戶斷開Socket連接: ${user.displayName} (原因: ${reason})`);
      });
    });
  }

  /**
   * 用戶相關事件處理器
   */
  private setupUserHandlers(socket: any) {
    const user = socket.data.user;

    // 加入店鋪房間
    socket.on('join-store', (storeId: string) => {
      // 驗證用戶是否有權限訪問該店鋪
      this.verifyStoreAccess(user.tenantId, storeId).then(hasAccess => {
        if (hasAccess) {
          socket.join(`store:${storeId}`);
          logger.info(`用戶 ${user.displayName} 加入店鋪房間: ${storeId}`);
          
          socket.emit('store-joined', {
            storeId,
            message: '已連接到店鋪即時通知',
          });
        } else {
          socket.emit('error', {
            message: '無權限訪問該店鋪',
          });
        }
      });
    });

    // 離開店鋪房間
    socket.on('leave-store', (storeId: string) => {
      socket.leave(`store:${storeId}`);
      logger.info(`用戶 ${user.displayName} 離開店鋪房間: ${storeId}`);
    });

    // 設置用戶狀態
    socket.on('set-status', (status: 'online' | 'busy' | 'away') => {
      socket.data.status = status;
      socket.to(`tenant:${user.tenantId}`).emit('user-status-changed', {
        userId: user.id,
        displayName: user.displayName,
        status,
      });
    });
  }

  /**
   * 訂單相關事件處理器
   */
  private setupOrderHandlers(socket: any) {
    const user = socket.data.user;

    // 訂單狀態更新
    socket.on('update-order-status', async (data: {
      orderId: string;
      status: string;
      note?: string;
    }) => {
      try {
        // 驗證權限
        if (!user.roles.some((role: any) => ['TENANT_ADMIN', 'STORE_MANAGER', 'STAFF'].includes(role))) {
          socket.emit('error', { message: '權限不足' });
          return;
        }

        const { orderId, status, note } = data;

        // 更新訂單狀態
        const order = await prisma.order.update({
          where: { id: orderId },
          data: {
            status,
            updatedAt: new Date(),
          },
          include: {
            customer: {
              select: {
                displayName: true,
              },
            },
          },
        });

        // 記錄狀態變更歷史
        await prisma.orderStatusHistory.create({
          data: {
            orderId,
            status,
            note: note || `狀態更新為${status}`,
            createdBy: user.id,
          },
        });

        // 廣播訂單狀態更新
        this.io.to(`store:${order.storeId}`).emit('order-status-updated', {
          orderId,
          orderNumber: order.orderNumber,
          status,
          customerName: order.customer.displayName,
          updatedBy: user.displayName,
          updatedAt: new Date(),
        });

        // 通知顧客
        this.io.to(`user:${order.customerId}`).emit('your-order-updated', {
          orderId,
          orderNumber: order.orderNumber,
          status,
          message: this.getStatusMessage(status),
        });

        logger.info(`訂單狀態通過Socket更新: ${order.orderNumber} -> ${status}`);
      } catch (error) {
        logger.error('Socket訂單狀態更新失敗:', error);
        socket.emit('error', {
          message: '訂單狀態更新失敗',
        });
      }
    });

    // 訂單進度查詢
    socket.on('track-order', async (orderNumber: string) => {
      try {
        const order = await prisma.order.findFirst({
          where: {
            orderNumber,
            store: {
              tenantId: user.tenantId,
            },
          },
          include: {
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
          socket.emit('error', { message: '訂單不存在' });
          return;
        }

        socket.emit('order-tracking-info', {
          orderId: order.id,
          orderNumber: order.orderNumber,
          status: order.status,
          estimatedTime: order.estimatedTime,
          statusHistory: order.statusHistory,
          message: this.getStatusMessage(order.status),
        });
      } catch (error) {
        logger.error('Socket訂單追踪失敗:', error);
        socket.emit('error', {
          message: '訂單追踪查詢失敗',
        });
      }
    });
  }

  /**
   * 店鋪相關事件處理器
   */
  private setupStoreHandlers(socket: any) {
    const user = socket.data.user;

    // 獲取店鋪即時統計
    socket.on('get-store-stats', async (storeId: string) => {
      try {
        const hasAccess = await this.verifyStoreAccess(user.tenantId, storeId);
        if (!hasAccess) {
          socket.emit('error', { message: '無權限訪問該店鋪' });
          return;
        }

        const today = new Date();
        const startOfDay = new Date(today.getFullYear(), today.getMonth(), today.getDate());

        const [orderCount, revenue, pendingOrders] = await Promise.all([
          prisma.order.count({
            where: {
              storeId,
              createdAt: { gte: startOfDay },
            },
          }),
          prisma.order.aggregate({
            where: {
              storeId,
              status: 'COMPLETED',
              createdAt: { gte: startOfDay },
            },
            _sum: { finalAmount: true },
          }),
          prisma.order.count({
            where: {
              storeId,
              status: { in: ['PENDING', 'CONFIRMED', 'PREPARING'] },
            },
          }),
        ]);

        socket.emit('store-stats-updated', {
          storeId,
          todayOrders: orderCount,
          todayRevenue: parseFloat(revenue._sum.finalAmount?.toString() || '0'),
          pendingOrders,
          lastUpdated: new Date(),
        });
      } catch (error) {
        logger.error('Socket店鋪統計查詢失敗:', error);
        socket.emit('error', {
          message: '店鋪統計查詢失敗',
        });
      }
    });

    // 店鋪營業狀態變更
    socket.on('update-store-status', async (data: {
      storeId: string;
      status: 'ACTIVE' | 'INACTIVE' | 'MAINTENANCE';
    }) => {
      try {
        if (!user.roles.some((role: any) => ['TENANT_ADMIN', 'STORE_MANAGER'].includes(role))) {
          socket.emit('error', { message: '權限不足' });
          return;
        }

        const { storeId, status } = data;

        await prisma.store.update({
          where: { id: storeId },
          data: { status },
        });

        // 廣播店鋪狀態變更
        this.io.to(`store:${storeId}`).emit('store-status-changed', {
          storeId,
          status,
          updatedBy: user.displayName,
          updatedAt: new Date(),
        });

        logger.info(`店鋪狀態通過Socket更新: ${storeId} -> ${status}`);
      } catch (error) {
        logger.error('Socket店鋪狀態更新失敗:', error);
        socket.emit('error', {
          message: '店鋪狀態更新失敗',
        });
      }
    });
  }

  /**
   * 通知相關事件處理器
   */
  private setupNotificationHandlers(socket: any) {
    const user = socket.data.user;

    // 標記通知為已讀
    socket.on('mark-notification-read', async (notificationId: string) => {
      try {
        // 這裡可以實作通知系統的已讀標記
        socket.emit('notification-marked-read', { notificationId });
      } catch (error) {
        logger.error('Socket通知標記失敗:', error);
      }
    });

    // 發送系統廣播 (管理員專用)
    socket.on('send-broadcast', async (data: {
      message: string;
      type: 'info' | 'warning' | 'error';
      targetStores?: string[];
    }) => {
      try {
        if (!user.roles.some((role: any) => ['TENANT_ADMIN', 'SUPER_ADMIN'].includes(role))) {
          socket.emit('error', { message: '權限不足' });
          return;
        }

        const { message, type, targetStores } = data;

        if (targetStores && targetStores.length > 0) {
          // 發送到指定店鋪
          targetStores.forEach(storeId => {
            this.io.to(`store:${storeId}`).emit('system-broadcast', {
              message,
              type,
              from: user.displayName,
              timestamp: new Date(),
            });
          });
        } else {
          // 發送到整個租戶
          this.io.to(`tenant:${user.tenantId}`).emit('system-broadcast', {
            message,
            type,
            from: user.displayName,
            timestamp: new Date(),
          });
        }

        logger.info(`系統廣播發送: ${message} (發送者: ${user.displayName})`);
      } catch (error) {
        logger.error('Socket系統廣播失敗:', error);
      }
    });
  }

  /**
   * 發送新訂單通知
   */
  sendNewOrderNotification(order: any) {
    this.io.to(`store:${order.storeId}`).emit('new-order', {
      orderId: order.id,
      orderNumber: order.orderNumber,
      orderType: order.orderType,
      totalAmount: order.totalAmount,
      itemCount: order.items?.length || 0,
      customerName: order.customer?.displayName,
      estimatedTime: order.estimatedTime,
      createdAt: order.createdAt,
    });

    // 播放提示音通知
    this.io.to(`store:${order.storeId}`).emit('play-notification-sound', {
      type: 'new-order',
    });
  }

  /**
   * 發送訂單狀態更新通知
   */
  sendOrderStatusUpdate(order: any, newStatus: string) {
    // 通知店鋪
    this.io.to(`store:${order.storeId}`).emit('order-status-updated', {
      orderId: order.id,
      orderNumber: order.orderNumber,
      status: newStatus,
      customerName: order.customer?.displayName,
      updatedAt: new Date(),
    });

    // 通知顧客
    this.io.to(`user:${order.customerId}`).emit('your-order-updated', {
      orderId: order.id,
      orderNumber: order.orderNumber,
      status: newStatus,
      message: this.getStatusMessage(newStatus),
      estimatedTime: order.estimatedTime,
    });
  }

  /**
   * 發送支付完成通知
   */
  sendPaymentCompletedNotification(order: any) {
    this.io.to(`store:${order.storeId}`).emit('payment-completed', {
      orderId: order.id,
      orderNumber: order.orderNumber,
      amount: order.finalAmount,
      customerName: order.customer?.displayName,
      paidAt: new Date(),
    });

    // 播放支付成功提示音
    this.io.to(`store:${order.storeId}`).emit('play-notification-sound', {
      type: 'payment-completed',
    });
  }

  /**
   * 獲取在線用戶統計
   */
  async getOnlineUsers(tenantId: string) {
    const sockets = await this.io.in(`tenant:${tenantId}`).fetchSockets();
    
    return sockets.map(socket => ({
      userId: socket.data.user.id,
      displayName: socket.data.user.displayName,
      roles: socket.data.user.roles,
      status: socket.data.status || 'online',
      connectedAt: socket.handshake.time,
    }));
  }

  /**
   * 驗證用戶是否有權限訪問店鋪
   */
  private async verifyStoreAccess(tenantId: string, storeId: string): Promise<boolean> {
    try {
      const store = await prisma.store.findFirst({
        where: {
          id: storeId,
          tenantId,
        },
      });
      return !!store;
    } catch (error) {
      return false;
    }
  }

  /**
   * 獲取狀態顯示訊息
   */
  private getStatusMessage(status: string): string {
    const statusMessages: Record<string, string> = {
      PENDING: '訂單待確認',
      CONFIRMED: '訂單已確認，準備中',
      PREPARING: '製作中，請稍候',
      READY: '製作完成，請取餐',
      COMPLETED: '訂單已完成',
      CANCELLED: '訂單已取消',
    };

    return statusMessages[status] || '狀態未知';
  }
}