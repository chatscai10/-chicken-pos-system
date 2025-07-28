import { PrismaClient } from '@prisma/client';
import axios from 'axios';
import logger from '../utils/logger';
import AppError from '../utils/AppError';

const prisma = new PrismaClient();

export interface PrintJobData {
  orderId: string;
  type: 'RECEIPT' | 'KITCHEN' | 'LABEL';
  content: string;
  copies?: number;
}

export interface PrinterConfig {
  id: string;
  name: string;
  type: 'EPSON' | 'STAR';
  location: string;
  ipAddress?: string;
  apiKey?: string;
  settings: any;
}

export class PrintService {
  /**
   * 發送打印任務
   */
  async sendPrintJob(printerId: string, jobData: PrintJobData): Promise<boolean> {
    try {
      const printer = await prisma.printer.findUnique({
        where: { id: printerId },
        include: {
          store: true,
        },
      });

      if (!printer || !printer.isActive) {
        throw new AppError('打印機不存在或已停用', 404);
      }

      let success = false;

      switch (printer.type) {
        case 'EPSON':
          success = await this.sendToEpsonPrinter(printer, jobData);
          break;
        case 'STAR':
          success = await this.sendToStarPrinter(printer, jobData);
          break;
        default:
          throw new AppError('不支援的打印機類型', 400);
      }

      // 記錄打印任務
      await prisma.printJob.create({
        data: {
          printerId,
          orderId: jobData.orderId,
          content: jobData.content,
          status: success ? 'COMPLETED' : 'FAILED',
          printedAt: success ? new Date() : null,
        },
      });

      return success;
    } catch (error) {
      logger.error('打印任務失敗:', error);
      
      // 記錄失敗的打印任務
      await prisma.printJob.create({
        data: {
          printerId,
          orderId: jobData.orderId,
          content: jobData.content,
          status: 'FAILED',
        },
      });

      return false;
    }
  }

  /**
   * Epson打印機整合
   */
  private async sendToEpsonPrinter(printer: any, jobData: PrintJobData): Promise<boolean> {
    try {
      const epsonApiUrl = `http://${printer.ipAddress}/cgi-bin/epos/service.cgi`;
      
      // 構建Epson ePOS-Print API請求
      const printData = this.buildEpsonPrintData(jobData);
      
      const response = await axios.post(epsonApiUrl, printData, {
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Basic ${Buffer.from(`admin:${printer.apiKey}`).toString('base64')}`,
        },
        timeout: 10000,
      });

      logger.info(`Epson打印成功: ${printer.name}`, response.data);
      return response.status === 200 && response.data.success;
    } catch (error) {
      logger.error(`Epson打印失敗: ${printer.name}`, error);
      return false;
    }
  }

  /**
   * Star打印機整合
   */
  private async sendToStarPrinter(printer: any, jobData: PrintJobData): Promise<boolean> {
    try {
      const starApiUrl = `http://${printer.ipAddress}/api/starcloudprnt`;
      
      // 構建Star CloudPRNT API請求
      const printData = this.buildStarPrintData(jobData);
      
      const response = await axios.post(starApiUrl, printData, {
        headers: {
          'Content-Type': 'application/json',
          'X-Star-Api-Key': printer.apiKey,
        },
        timeout: 10000,
      });

      logger.info(`Star打印成功: ${printer.name}`, response.data);
      return response.status === 200;
    } catch (error) {
      logger.error(`Star打印失敗: ${printer.name}`, error);
      return false;
    }
  }

  /**
   * 構建Epson打印數據
   */
  private buildEpsonPrintData(jobData: PrintJobData): any {
    return {
      method: 'print',
      params: {
        devid: 'local_printer',
        timeout: 10000,
        doc: {
          type: 'receipt',
          content: [
            {
              type: 'text',
              data: jobData.content,
              style: {
                font: 'font_a',
                size: { width: 1, height: 1 },
                align: 'left',
              },
            },
            {
              type: 'cut',
              feed: 3,
            },
          ],
        },
      },
    };
  }

  /**
   * 構建Star打印數據
   */
  private buildStarPrintData(jobData: PrintJobData): any {
    return {
      document: {
        type: 'text/plain',
        content: jobData.content + '\\n\\n\\n',
      },
      printer: 'Star_CloudPRNT',
      jobReady: true,
    };
  }

  /**
   * 生成收據內容
   */
  generateReceiptContent(order: any): string {
    const lines: string[] = [];
    
    // 店鋪資訊
    lines.push('================================');
    lines.push(`       ${order.store.name}`);
    lines.push(`   ${order.store.address}`);
    lines.push(`   電話: ${order.store.phone}`);
    lines.push('================================');
    lines.push('');
    
    // 訂單資訊
    lines.push(`訂單號碼: ${order.orderNumber}`);
    lines.push(`日期時間: ${new Date(order.createdAt).toLocaleString('zh-TW')}`);
    lines.push(`顧客: ${order.customer.displayName || order.customer.email}`);
    lines.push(`類型: ${this.getOrderTypeText(order.orderType)}`);
    lines.push('--------------------------------');
    
    // 商品清單
    for (const item of order.items) {
      lines.push(`${item.product.name}`);
      if (item.variant) {
        lines.push(`  規格: ${item.variant.name}`);
      }
      lines.push(`  數量: ${item.quantity} x $${item.unitPrice}`);
      lines.push(`  小計: $${item.totalPrice}`);
      
      // 加購項目
      if (item.addons && item.addons.length > 0) {
        for (const addon of item.addons) {
          lines.push(`  + ${addon.addon.name} x${addon.quantity} ($${addon.price})`);
        }
      }
      
      if (item.note) {
        lines.push(`  備註: ${item.note}`);
      }
      lines.push('');
    }
    
    lines.push('--------------------------------');
    lines.push(`小計: $${order.totalAmount}`);
    if (order.discountAmount > 0) {
      lines.push(`折扣: -$${order.discountAmount}`);
    }
    lines.push(`總計: $${order.finalAmount}`);
    lines.push('--------------------------------');
    
    // 付款資訊
    if (order.payments && order.payments.length > 0) {
      const payment = order.payments[0];
      lines.push(`付款方式: ${this.getPaymentMethodText(payment.method)}`);
      lines.push(`付款狀態: ${this.getPaymentStatusText(payment.status)}`);
      if (payment.paidAt) {
        lines.push(`付款時間: ${new Date(payment.paidAt).toLocaleString('zh-TW')}`);
      }
    }
    
    lines.push('');
    lines.push('謝謝您的光臨！');
    lines.push('歡迎再次來訪');
    lines.push('================================');
    
    return lines.join('\\n');
  }

  /**
   * 生成廚房單內容
   */
  generateKitchenContent(order: any): string {
    const lines: string[] = [];
    
    lines.push('*** 廚房工作單 ***');
    lines.push('');
    lines.push(`訂單: ${order.orderNumber}`);
    lines.push(`時間: ${new Date(order.createdAt).toLocaleString('zh-TW')}`);
    lines.push(`類型: ${this.getOrderTypeText(order.orderType)}`);
    lines.push('========================');
    
    for (const item of order.items) {
      lines.push(`【${item.quantity}】${item.product.name}`);
      if (item.variant) {
        lines.push(`   規格: ${item.variant.name}`);
      }
      
      if (item.addons && item.addons.length > 0) {
        for (const addon of item.addons) {
          lines.push(`   + ${addon.addon.name} x${addon.quantity}`);
        }
      }
      
      if (item.note) {
        lines.push(`   ** ${item.note} **`);
      }
      lines.push('');
    }
    
    if (order.note) {
      lines.push('========================');
      lines.push(`整單備註: ${order.note}`);
    }
    
    lines.push('========================');
    
    return lines.join('\\n');
  }

  /**
   * 自動打印訂單
   */
  async autoPrintOrder(orderId: string): Promise<void> {
    try {
      const order = await prisma.order.findUnique({
        where: { id: orderId },
        include: {
          items: {
            include: {
              product: true,
              variant: true,
              addons: {
                include: {
                  addon: true,
                },
              },
            },
          },
          store: {
            include: {
              printers: {
                where: { isActive: true },
              },
            },
          },
          customer: true,
          payments: true,
        },
      });

      if (!order) {
        throw new AppError('訂單不存在', 404);
      }

      // 找到收據打印機
      const receiptPrinter = order.store.printers.find((p: any) => p.location === '櫃台');
      if (receiptPrinter) {
        const receiptContent = this.generateReceiptContent(order);
        await this.sendPrintJob(receiptPrinter.id, {
          orderId,
          type: 'RECEIPT',
          content: receiptContent,
        });
      }

      // 找到廚房打印機
      const kitchenPrinter = order.store.printers.find((p: any) => p.location === '廚房');
      if (kitchenPrinter) {
        const kitchenContent = this.generateKitchenContent(order);
        await this.sendPrintJob(kitchenPrinter.id, {
          orderId,
          type: 'KITCHEN',
          content: kitchenContent,
        });
      }

      logger.info(`訂單自動打印完成: ${order.orderNumber}`);
    } catch (error) {
      logger.error(`訂單自動打印失敗: ${orderId}`, error);
    }
  }

  /**
   * 測試打印機連接
   */
  async testPrinter(printerId: string): Promise<boolean> {
    try {
      const testContent = this.generateTestContent();
      return await this.sendPrintJob(printerId, {
        orderId: 'TEST',
        type: 'RECEIPT',
        content: testContent,
      });
    } catch (error) {
      logger.error(`打印機測試失敗: ${printerId}`, error);
      return false;
    }
  }

  /**
   * 生成測試打印內容
   */
  private generateTestContent(): string {
    const lines: string[] = [];
    
    lines.push('*** 打印機測試 ***');
    lines.push('');
    lines.push('如果您能看到這張測試單，');
    lines.push('表示打印機連接正常。');
    lines.push('');
    lines.push(`測試時間: ${new Date().toLocaleString('zh-TW')}`);
    lines.push('');
    lines.push('雞排店線上點餐系統');
    lines.push('===================');
    
    return lines.join('\\n');
  }

  /**
   * 獲取訂單類型文字
   */
  private getOrderTypeText(orderType: string): string {
    const typeMap: Record<string, string> = {
      DINE_IN: '內用',
      TAKEOUT: '外帶',
      DELIVERY: '外送',
      UBER_EATS: 'Uber Eats',
    };
    return typeMap[orderType] || orderType;
  }

  /**
   * 獲取付款方式文字
   */
  private getPaymentMethodText(method: string): string {
    const methodMap: Record<string, string> = {
      CASH: '現金',
      CARD: '刷卡',
      LINE_PAY: 'LINE Pay',
      MOBILE_PAYMENT: '行動支付',
    };
    return methodMap[method] || method;
  }

  /**
   * 獲取付款狀態文字
   */
  private getPaymentStatusText(status: string): string {
    const statusMap: Record<string, string> = {
      PENDING: '待付款',
      COMPLETED: '已付款',
      FAILED: '付款失敗',
      REFUNDED: '已退款',
    };
    return statusMap[status] || status;
  }

  /**
   * 重新打印訂單
   */
  async reprintOrder(orderId: string, printType: 'RECEIPT' | 'KITCHEN'): Promise<boolean> {
    try {
      const order = await prisma.order.findUnique({
        where: { id: orderId },
        include: {
          items: {
            include: {
              product: true,
              variant: true,
              addons: {
                include: {
                  addon: true,
                },
              },
            },
          },
          store: {
            include: {
              printers: {
                where: { isActive: true },
              },
            },
          },
          customer: true,
          payments: true,
        },
      });

      if (!order) {
        throw new AppError('訂單不存在', 404);
      }

      const targetLocation = printType === 'RECEIPT' ? '櫃台' : '廚房';
      const printer = order.store.printers.find((p: any) => p.location === targetLocation);

      if (!printer) {
        throw new AppError(`找不到${targetLocation}打印機`, 404);
      }

      const content = printType === 'RECEIPT' 
        ? this.generateReceiptContent(order)
        : this.generateKitchenContent(order);

      return await this.sendPrintJob(printer.id, {
        orderId,
        type: printType,
        content,
      });
    } catch (error) {
      logger.error(`重新打印失敗: ${orderId}`, error);
      return false;
    }
  }

  /**
   * 獲取打印歷史
   */
  async getPrintHistory(storeId: string, limit = 50) {
    return await prisma.printJob.findMany({
      where: {
        printer: {
          storeId,
        },
      },
      include: {
        printer: {
          select: {
            name: true,
            location: true,
          },
        },
      },
      orderBy: { createdAt: 'desc' },
      take: limit,
    });
  }
}