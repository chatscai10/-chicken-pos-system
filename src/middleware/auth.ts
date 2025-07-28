import { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import { PrismaClient } from '@prisma/client';
import AppError from '../utils/AppError';
import logger from '../utils/logger';

const prisma = new PrismaClient();

export interface AuthenticatedRequest extends Request {
  user?: {
    id: string;
    tenantId: string;
    email: string;
    roles: string[];
  };
}

/**
 * JWT認證中間件
 * 驗證用戶身份並注入用戶資訊到請求對象
 */
export const authMiddleware = async (
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction
): Promise<void> => {
  try {
    // 從Header中獲取Token
    const authHeader = req.headers.authorization;
    
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      throw new AppError('未提供認證令牌', 401);
    }

    const token = authHeader.substring(7); // 移除 'Bearer ' 前綴

    // 驗證JWT Token
    const decoded = jwt.verify(token, process.env.JWT_SECRET!) as {
      userId: string;
      tenantId: string;
      email: string;
      iat: number;
      exp: number;
    };

    // 查詢用戶資訊和角色
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
      throw new AppError('用戶不存在或已被停用', 401);
    }

    // 驗證租戶一致性
    if (user.tenantId !== decoded.tenantId) {
      throw new AppError('租戶資訊不匹配', 401);
    }

    // 注入用戶資訊到請求對象
    req.user = {
      id: user.id,
      tenantId: user.tenantId,
      email: user.email,
      roles: user.roles.map((ur: any) => ur.role.name),
    };

    next();
  } catch (error) {
    if (error instanceof jwt.JsonWebTokenError) {
      logger.warn('JWT驗證失敗:', error.message);
      return next(new AppError('無效的認證令牌', 401));
    }
    
    if (error instanceof jwt.TokenExpiredError) {
      logger.warn('JWT令牌已過期');
      return next(new AppError('認證令牌已過期', 401));
    }

    logger.error('認證中間件錯誤:', error);
    next(error);
  }
};

/**
 * 角色權限檢查中間件工廠
 * @param requiredRoles 需要的角色列表
 */
export const requireRoles = (...requiredRoles: string[]) => {
  return (req: AuthenticatedRequest, res: Response, next: NextFunction): void => {
    if (!req.user) {
      return next(new AppError('未認證用戶', 401));
    }

    const hasRequiredRole = requiredRoles.some(role => 
      req.user!.roles.includes(role)
    );

    if (!hasRequiredRole) {
      logger.warn(`用戶 ${req.user.id} 嘗試訪問需要角色 [${requiredRoles.join(', ')}] 的資源`);
      return next(new AppError('權限不足', 403));
    }

    next();
  };
};

/**
 * 可選認證中間件
 * 如果提供Token則驗證，否則繼續但不注入用戶資訊
 */
export const optionalAuth = async (
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction
): Promise<void> => {
  const authHeader = req.headers.authorization;
  
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return next(); // 沒有Token，直接繼續
  }

  try {
    await authMiddleware(req, res, next);
  } catch (error) {
    // 可選認證失敗時記錄但不阻止請求
    logger.warn('可選認證失敗:', error);
    next();
  }
};