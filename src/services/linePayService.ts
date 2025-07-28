import axios, { AxiosInstance } from 'axios';
import crypto from 'crypto';
import logger from '../utils/logger';

export interface LinePayRequestData {
  amount: number;
  currency: string;
  orderId: string;
  productName: string;
  returnUrls: {
    confirmUrl: string;
    cancelUrl: string;
  };
  packages: Array<{
    id: string;
    amount: number;
    products: Array<{
      id: string;
      name: string;
      quantity: number;
      price: number;
    }>;
  }>;
}

export interface LinePayResponse {
  success: boolean;
  data: any;
  error?: string;
}

export class LinePayService {
  private client: AxiosInstance;
  private channelId: string;
  private channelSecret: string;
  private apiUrl: string;

  constructor() {
    this.channelId = process.env.LINE_PAY_CHANNEL_ID!;
    this.channelSecret = process.env.LINE_PAY_CHANNEL_SECRET!;
    this.apiUrl = process.env.LINE_PAY_API_URL!;

    if (!this.channelId || !this.channelSecret || !this.apiUrl) {
      throw new Error('LINE Pay configuration is missing');
    }

    this.client = axios.create({
      baseURL: this.apiUrl,
      timeout: 30000,
      headers: {
        'Content-Type': 'application/json',
        'X-LINE-ChannelId': this.channelId,
      },
    });

    // 請求攔截器 - 添加簽名
    this.client.interceptors.request.use((config) => {
      const signature = this.generateSignature(config.url!, config.data || '');
      config.headers['X-LINE-Authorization'] = signature;
      return config;
    });

    // 響應攔截器 - 日誌記錄
    this.client.interceptors.response.use(
      (response) => {
        logger.debug('LINE Pay API Response:', {
          url: response.config.url,
          status: response.status,
          data: response.data,
        });
        return response;
      },
      (error) => {
        logger.error('LINE Pay API Error:', {
          url: error.config?.url,
          status: error.response?.status,
          data: error.response?.data,
        });
        return Promise.reject(error);
      }
    );
  }

  /**
   * 生成LINE Pay API簽名
   */
  private generateSignature(uri: string, body: string): string {
    const nonce = crypto.randomUUID();
    const timestamp = Date.now().toString();
    
    const message = this.channelSecret + uri + body + nonce + timestamp;
    const signature = crypto
      .createHmac('sha256', this.channelSecret)
      .update(message)
      .digest('base64');

    return `${signature}:${nonce}:${timestamp}`;
  }

  /**
   * 發起付款請求
   */
  async requestPayment(data: LinePayRequestData): Promise<LinePayResponse> {
    try {
      logger.info('發起LINE Pay付款請求:', {
        orderId: data.orderId,
        amount: data.amount,
        currency: data.currency,
      });

      const response = await this.client.post('/v3/payments/request', data);

      if (response.data.returnCode === '0000') {
        return {
          success: true,
          data: {
            transactionId: response.data.info.transactionId,
            paymentAccessToken: response.data.info.paymentAccessToken,
            paymentUrl: response.data.info.paymentUrl,
          },
        };
      } else {
        logger.error('LINE Pay付款請求失敗:', response.data);
        return {
          success: false,
          data: response.data,
          error: response.data.returnMessage || 'Unknown error',
        };
      }
    } catch (error: any) {
      logger.error('LINE Pay付款請求異常:', error);
      return {
        success: false,
        data: null,
        error: error.message || 'Network error',
      };
    }
  }

  /**
   * 確認付款
   */
  async confirmPayment(transactionId: string, amount: number): Promise<LinePayResponse> {
    try {
      logger.info('確認LINE Pay付款:', {
        transactionId,
        amount,
      });

      const data = {
        amount,
        currency: 'TWD',
      };

      const response = await this.client.post(
        `/v3/payments/${transactionId}/confirm`,
        data
      );

      if (response.data.returnCode === '0000') {
        return {
          success: true,
          data: {
            orderId: response.data.info.orderId,
            transactionId: response.data.info.transactionId,
            payInfo: response.data.info.payInfo,
          },
        };
      } else {
        logger.error('LINE Pay付款確認失敗:', response.data);
        return {
          success: false,
          data: response.data,
          error: response.data.returnMessage || 'Confirmation failed',
        };
      }
    } catch (error: any) {
      logger.error('LINE Pay付款確認異常:', error);
      return {
        success: false,
        data: null,
        error: error.message || 'Network error',
      };
    }
  }

  /**
   * 查詢付款狀態
   */
  async checkPaymentStatus(transactionId: string): Promise<LinePayResponse> {
    try {
      logger.info('查詢LINE Pay付款狀態:', { transactionId });

      const response = await this.client.get(`/v3/payments/requests/${transactionId}`);

      if (response.data.returnCode === '0000') {
        return {
          success: true,
          data: response.data.info,
        };
      } else {
        return {
          success: false,
          data: response.data,
          error: response.data.returnMessage || 'Query failed',
        };
      }
    } catch (error: any) {
      logger.error('LINE Pay付款狀態查詢異常:', error);
      return {
        success: false,
        data: null,
        error: error.message || 'Network error',
      };
    }
  }

  /**
   * 退款
   */
  async refundPayment(transactionId: string, refundAmount?: number): Promise<LinePayResponse> {
    try {
      logger.info('發起LINE Pay退款:', {
        transactionId,
        refundAmount,
      });

      const data: any = {};
      if (refundAmount) {
        data.refundAmount = refundAmount;
      }

      const response = await this.client.post(
        `/v3/payments/${transactionId}/refund`,
        data
      );

      if (response.data.returnCode === '0000') {
        return {
          success: true,
          data: {
            refundTransactionId: response.data.info.refundTransactionId,
            refundAmount: response.data.info.refundAmount,
          },
        };
      } else {
        logger.error('LINE Pay退款失敗:', response.data);
        return {
          success: false,
          data: response.data,
          error: response.data.returnMessage || 'Refund failed',
        };
      }
    } catch (error: any) {
      logger.error('LINE Pay退款異常:', error);
      return {
        success: false,
        data: null,
        error: error.message || 'Network error',
      };
    }
  }

  /**
   * 預授權付款請求
   */
  async preApprovedPayment(regKey: string, data: LinePayRequestData): Promise<LinePayResponse> {
    try {
      logger.info('發起LINE Pay預授權付款:', {
        regKey,
        orderId: data.orderId,
        amount: data.amount,
      });

      const requestData = {
        ...data,
        options: {
          payment: {
            capture: false, // 預授權
          },
        },
      };

      const response = await this.client.post(
        `/v3/payments/preApprovedPay/${regKey}/payment`,
        requestData
      );

      if (response.data.returnCode === '0000') {
        return {
          success: true,
          data: {
            transactionId: response.data.info.transactionId,
            orderId: response.data.info.orderId,
          },
        };
      } else {
        logger.error('LINE Pay預授權付款失敗:', response.data);
        return {
          success: false,
          data: response.data,
          error: response.data.returnMessage || 'Pre-approved payment failed',
        };
      }
    } catch (error: any) {
      logger.error('LINE Pay預授權付款異常:', error);
      return {
        success: false,
        data: null,
        error: error.message || 'Network error',
      };
    }
  }

  /**
   * 驗證Webhook簽名
   */
  verifyWebhookSignature(body: string, signature: string): boolean {
    try {
      const [receivedSignature, nonce, timestamp] = signature.split(':');
      
      const message = this.channelSecret + '/webhooks/payment' + body + nonce + timestamp;
      const expectedSignature = crypto
        .createHmac('sha256', this.channelSecret)
        .update(message)
        .digest('base64');

      return receivedSignature === expectedSignature;
    } catch (error) {
      logger.error('Webhook簽名驗證異常:', error);
      return false;
    }
  }

  /**
   * 處理Webhook通知
   */
  async handleWebhook(body: any): Promise<void> {
    try {
      logger.info('收到LINE Pay Webhook通知:', body);

      const { events } = body;
      
      for (const event of events) {
        switch (event.type) {
          case 'payment.completed':
            await this.handlePaymentCompleted(event);
            break;
          case 'payment.failed':
            await this.handlePaymentFailed(event);
            break;
          case 'refund.completed':
            await this.handleRefundCompleted(event);
            break;
          default:
            logger.warn('未知的Webhook事件類型:', event.type);
        }
      }
    } catch (error) {
      logger.error('處理Webhook通知異常:', error);
      throw error;
    }
  }

  private async handlePaymentCompleted(event: any): Promise<void> {
    // 處理付款完成事件
    logger.info('處理付款完成事件:', event);
  }

  private async handlePaymentFailed(event: any): Promise<void> {
    // 處理付款失敗事件
    logger.info('處理付款失敗事件:', event);
  }

  private async handleRefundCompleted(event: any): Promise<void> {
    // 處理退款完成事件
    logger.info('處理退款完成事件:', event);
  }
}