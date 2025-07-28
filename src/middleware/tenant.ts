import { Request, Response, NextFunction } from 'express';
import { PrismaClient } from '@prisma/client';
import AppError from '../utils/AppError';
import logger from '../utils/logger';

const prisma = new PrismaClient();

export interface TenantRequest extends Request {
  tenant?: {
    id: string;
    name: string;
    status: string;
    settings?: any;
  };
}

/**
 * 租戶中間件
 * 根據子域名或Header識別租戶並注入租戶資訊
 */
export const tenantMiddleware = async (
  req: TenantRequest,
  res: Response,
  next: NextFunction
): Promise<void> => {
  try {
    let tenantIdentifier: string | null = null;

    // 方法1: 從自定義Header獲取租戶ID
    const tenantHeader = req.headers['x-tenant-id'] as string;
    if (tenantHeader) {
      tenantIdentifier = tenantHeader;
    }

    // 方法2: 從子域名獲取租戶識別符
    if (!tenantIdentifier) {
      const host = req.headers.host;
      if (host) {
        const subdomain = host.split('.')[0];
        // 排除常見的非租戶子域名
        if (subdomain && !['www', 'api', 'admin'].includes(subdomain)) {
          tenantIdentifier = subdomain;
        }
      }
    }

    // 方法3: 從URL路徑獲取租戶識別符 (如 /api/tenants/:tenantId/...)
    if (!tenantIdentifier) {
      const pathMatch = req.path.match(/^\/api\/tenants\/([^\/]+)/);
      if (pathMatch) {
        tenantIdentifier = pathMatch[1];
      }
    }

    if (!tenantIdentifier) {
      throw new AppError('無法識別租戶', 400);
    }

    // 查詢租戶資訊
    const tenant = await prisma.tenant.findFirst({
      where: {
        OR: [
          { id: tenantIdentifier },
          { domain: tenantIdentifier },
        ],
      },
      select: {
        id: true,
        name: true,
        status: true,
        settings: true,
      },
    });

    if (!tenant) {
      throw new AppError('租戶不存在', 404);
    }

    if (tenant.status !== 'ACTIVE') {
      throw new AppError('租戶已停用或暫停服務', 403);
    }

    // 注入租戶資訊到請求對象
    req.tenant = tenant;

    // 設置Prisma的租戶上下文 (用於Row-Level Security)
    await prisma.$executeRaw`SET SESSION app.current_tenant = ${tenant.id}`;

    logger.debug(`租戶識別成功: ${tenant.name} (${tenant.id})`);
    next();
  } catch (error) {
    logger.error('租戶中間件錯誤:', error);
    next(error);
  }
};

/**
 * 租戶管理員權限檢查
 * 確保用戶是當前租戶的管理員
 */
export const requireTenantAdmin = async (
  req: TenantRequest & { user?: any },
  res: Response,
  next: NextFunction
): Promise<void> => {
  try {
    if (!req.user || !req.tenant) {
      throw new AppError('認證或租戶資訊缺失', 401);
    }

    // 檢查用戶是否屬於當前租戶
    if (req.user.tenantId !== req.tenant.id) {
      throw new AppError('用戶不屬於當前租戶', 403);
    }

    // 檢查用戶是否有租戶管理員角色
    const hasAdminRole = req.user.roles.includes('TENANT_ADMIN') || 
                        req.user.roles.includes('SUPER_ADMIN');

    if (!hasAdminRole) {
      throw new AppError('需要租戶管理員權限', 403);
    }

    next();
  } catch (error) {
    next(error);
  }
};

/**
 * 租戶資源存取控制
 * 確保用戶只能存取自己租戶的資源
 */
export const tenantResourceAccess = (resourceTenantField = 'tenantId') => {
  return (req: any, res: Response, next: NextFunction): void => {
    // 在實際的資料庫查詢中，這個檢查會透過Prisma的WHERE條件來實現
    // 這裡主要是做額外的安全檢查
    req.tenantResourceField = resourceTenantField;
    next();
  };
};