import express from 'express';
import { body, validationResult } from 'express-validator';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import passport from 'passport';
import { Strategy as JwtStrategy, ExtractJwt } from 'passport-jwt';
import { PrismaClient } from '@prisma/client';
import AppError from '../utils/AppError';
import logger from '../utils/logger';
import { sendEmail } from '../services/emailService';
import { generateTokens, verifyRefreshToken } from '../utils/tokenUtils';

const router = express.Router();
const prisma = new PrismaClient();

// 配置Passport JWT策略
passport.use(
  new JwtStrategy(
    {
      jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
      secretOrKey: process.env.JWT_SECRET!,
    },
    async (payload, done) => {
      try {
        const user = await prisma.user.findUnique({
          where: { id: payload.userId },
          include: {
            roles: {
              include: {
                role: true,
              },
            },
          },
        });

        if (user && user.status === 'ACTIVE') {
          return done(null, user);
        }
        return done(null, false);
      } catch (error) {
        return done(error, false);
      }
    }
  )
);

/**
 * 用戶註冊
 * POST /api/auth/register
 */
router.post(
  '/register',
  [
    body('email').isEmail().withMessage('請提供有效的電子郵件'),
    body('password')
      .isLength({ min: 8 })
      .withMessage('密碼至少需要8個字符')
      .matches(/^(?=.*[a-z])(?=.*[A-Z])(?=.*\\d)/)
      .withMessage('密碼必須包含大小寫字母和數字'),
    body('displayName').trim().isLength({ min: 2 }).withMessage('顯示名稱至少需要2個字符'),
    body('phone').optional().isMobilePhone('zh-TW').withMessage('請提供有效的台灣手機號碼'),
    body('tenantId').isUUID().withMessage('租戶ID格式無效'),
  ],
  async (req, res, next) => {
    try {
      // 驗證輸入
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return next(new AppError('輸入數據無效', 400, errors.array()));
      }

      const { email, password, displayName, phone, tenantId } = req.body;

      // 檢查租戶是否存在
      const tenant = await prisma.tenant.findUnique({
        where: { id: tenantId },
      });

      if (!tenant || tenant.status !== 'ACTIVE') {
        return next(new AppError('租戶不存在或已停用', 400));
      }

      // 檢查用戶是否已存在
      const existingUser = await prisma.user.findFirst({
        where: {
          tenantId,
          email,
        },
      });

      if (existingUser) {
        return next(new AppError('該電子郵件已被註冊', 409));
      }

      // 密碼加密
      const saltRounds = parseInt(process.env.BCRYPT_ROUNDS || '12');
      const hashedPassword = await bcrypt.hash(password, saltRounds);

      // 創建用戶
      const user = await prisma.user.create({
        data: {
          tenantId,
          email,
          password: hashedPassword,
          displayName,
          phone,
          status: 'ACTIVE',
        },
        include: {
          tenant: {
            select: {
              id: true,
              name: true,
            },
          },
        },
      });

      // 分配默認角色 (顧客)
      const customerRole = await prisma.role.findFirst({
        where: { name: 'CUSTOMER' },
      });

      if (customerRole) {
        await prisma.userRole.create({
          data: {
            userId: user.id,
            roleId: customerRole.id,
          },
        });
      }

      // 創建顧客資料
      await prisma.customerProfile.create({
        data: {
          userId: user.id,
          loyaltyTier: 'BRONZE',
          totalSpent: 0,
        },
      });

      // 生成JWT令牌
      const { accessToken, refreshToken } = generateTokens({
        userId: user.id,
        tenantId: user.tenantId,
        email: user.email,
      });

      // 記錄日誌
      logger.info(`新用戶註冊成功: ${email} (租戶: ${tenant.name})`);

      // 發送歡迎郵件 (異步)
      sendEmail({
        to: email,
        subject: '歡迎加入！',
        template: 'welcome',
        data: {
          displayName,
          tenantName: tenant.name,
        },
      }).catch(error => {
        logger.error('發送歡迎郵件失敗:', error);
      });

      res.status(201).json({
        message: '註冊成功',
        data: {
          user: {
            id: user.id,
            email: user.email,
            displayName: user.displayName,
            tenant: user.tenant,
          },
          tokens: {
            accessToken,
            refreshToken,
          },
        },
      });
    } catch (error) {
      next(error);
    }
  }
);

/**
 * 用戶登入
 * POST /api/auth/login
 */
router.post(
  '/login',
  [
    body('email').isEmail().withMessage('請提供有效的電子郵件'),
    body('password').notEmpty().withMessage('密碼不能為空'),
    body('tenantId').optional().isUUID().withMessage('租戶ID格式無效'),
  ],
  async (req, res, next) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return next(new AppError('輸入數據無效', 400, errors.array()));
      }

      const { email, password, tenantId } = req.body;

      // 查找用戶
      const whereClause: any = { email };
      if (tenantId) {
        whereClause.tenantId = tenantId;
      }

      const user = await prisma.user.findFirst({
        where: whereClause,
        include: {
          tenant: {
            select: {
              id: true,
              name: true,
              status: true,
            },
          },
          roles: {
            include: {
              role: true,
            },
          },
        },
      });

      if (!user || !user.password) {
        return next(new AppError('電子郵件或密碼錯誤', 401));
      }

      // 檢查租戶狀態
      if (user.tenant.status !== 'ACTIVE') {
        return next(new AppError('租戶已停用或暫停服務', 403));
      }

      // 檢查用戶狀態
      if (user.status !== 'ACTIVE') {
        return next(new AppError('用戶已被停用', 403));
      }

      // 驗證密碼
      const isPasswordValid = await bcrypt.compare(password, user.password);
      if (!isPasswordValid) {
        return next(new AppError('電子郵件或密碼錯誤', 401));
      }

      // 更新最後登入時間
      await prisma.user.update({
        where: { id: user.id },
        data: { lastLoginAt: new Date() },
      });

      // 生成JWT令牌
      const { accessToken, refreshToken } = generateTokens({
        userId: user.id,
        tenantId: user.tenantId,
        email: user.email,
      });

      logger.info(`用戶登入成功: ${email} (租戶: ${user.tenant.name})`);

      res.json({
        message: '登入成功',
        data: {
          user: {
            id: user.id,
            email: user.email,
            displayName: user.displayName,
            tenant: {
              id: user.tenant.id,
              name: user.tenant.name,
            },
            roles: user.roles.map(ur => ur.role.name),
          },
          tokens: {
            accessToken,
            refreshToken,
          },
        },
      });
    } catch (error) {
      next(error);
    }
  }
);

/**
 * LINE登入回調
 * GET /api/auth/line/callback
 */
router.get('/line/callback', async (req, res, next) => {
  try {
    const { code, state } = req.query;
    
    if (!code) {
      return next(new AppError('LINE授權碼缺失', 400));
    }

    // 解析state參數 (包含tenantId)
    let tenantId: string;
    try {
      const stateData = JSON.parse(Buffer.from(state as string, 'base64').toString());
      tenantId = stateData.tenantId;
    } catch {
      return next(new AppError('無效的狀態參數', 400));
    }

    // 使用授權碼換取存取令牌
    const tokenResponse = await fetch('https://api.line.me/oauth2/v2.1/token', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code: code as string,
        redirect_uri: process.env.LINE_CALLBACK_URL!,
        client_id: process.env.LINE_CHANNEL_ID!,
        client_secret: process.env.LINE_CHANNEL_SECRET!,
      }),
    });

    const tokenData = await tokenResponse.json();
    
    if (!tokenData.access_token) {
      return next(new AppError('LINE授權失敗', 400));
    }

    // 獲取用戶資料
    const profileResponse = await fetch('https://api.line.me/v2/profile', {
      headers: {
        Authorization: `Bearer ${tokenData.access_token}`,
      },
    });

    const profile = await profileResponse.json();

    // 查找或創建用戶
    let user = await prisma.user.findUnique({
      where: { lineUserId: profile.userId },
      include: {
        tenant: true,
        roles: {
          include: {
            role: true,
          },
        },
      },
    });

    if (!user) {
      // 創建新用戶
      user = await prisma.user.create({
        data: {
          tenantId,
          email: `line_${profile.userId}@temp.com`, // 臨時郵箱
          displayName: profile.displayName,
          avatar: profile.pictureUrl,
          lineUserId: profile.userId,
          status: 'ACTIVE',
        },
        include: {
          tenant: true,
          roles: {
            include: {
              role: true,
            },
          },
        },
      });

      // 分配默認角色
      const customerRole = await prisma.role.findFirst({
        where: { name: 'CUSTOMER' },
      });

      if (customerRole) {
        await prisma.userRole.create({
          data: {
            userId: user.id,
            roleId: customerRole.id,
          },
        });
      }

      // 創建顧客資料
      await prisma.customerProfile.create({
        data: {
          userId: user.id,
          loyaltyTier: 'BRONZE',
        },
      });
    }

    // 生成JWT令牌
    const { accessToken, refreshToken } = generateTokens({
      userId: user.id,
      tenantId: user.tenantId,
      email: user.email,
    });

    // 重定向到前端並傳遞令牌
    const redirectUrl = `${process.env.FRONTEND_URL}/auth/callback?token=${accessToken}&refresh=${refreshToken}`;
    res.redirect(redirectUrl);
  } catch (error) {
    next(error);
  }
});

/**
 * 刷新令牌
 * POST /api/auth/refresh
 */
router.post('/refresh', async (req, res, next) => {
  try {
    const { refreshToken } = req.body;

    if (!refreshToken) {
      return next(new AppError('刷新令牌缺失', 400));
    }

    const payload = verifyRefreshToken(refreshToken);
    
    // 驗證用戶仍然有效
    const user = await prisma.user.findUnique({
      where: { id: payload.userId },
    });

    if (!user || user.status !== 'ACTIVE') {
      return next(new AppError('用戶無效', 401));
    }

    // 生成新的令牌對
    const tokens = generateTokens({
      userId: user.id,
      tenantId: user.tenantId,
      email: user.email,
    });

    res.json({
      message: '令牌刷新成功',
      data: {
        tokens,
      },
    });
  } catch (error) {
    next(new AppError('刷新令牌無效', 401));
  }
});

/**
 * 登出
 * POST /api/auth/logout
 */
router.post('/logout', async (req, res) => {
  // 在實際應用中，這裡可以將令牌加入黑名單
  // 目前只是返回成功響應
  res.json({
    message: '登出成功',
  });
});

/**
 * 忘記密碼
 * POST /api/auth/forgot-password
 */
router.post(
  '/forgot-password',
  [
    body('email').isEmail().withMessage('請提供有效的電子郵件'),
    body('tenantId').isUUID().withMessage('租戶ID格式無效'),
  ],
  async (req, res, next) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return next(new AppError('輸入數據無效', 400, errors.array()));
      }

      const { email, tenantId } = req.body;

      const user = await prisma.user.findFirst({
        where: {
          email,
          tenantId,
        },
      });

      if (!user) {
        // 為了安全，即使用戶不存在也返回成功
        return res.json({
          message: '如果該郵箱已註冊，您將收到重設密碼的郵件',
        });
      }

      // 生成重設令牌
      const resetToken = jwt.sign(
        { userId: user.id, email: user.email },
        process.env.JWT_SECRET!,
        { expiresIn: '1h' }
      );

      // 發送重設密碼郵件
      await sendEmail({
        to: email,
        subject: '重設密碼請求',
        template: 'password-reset',
        data: {
          displayName: user.displayName,
          resetUrl: `${process.env.FRONTEND_URL}/reset-password?token=${resetToken}`,
        },
      });

      res.json({
        message: '如果該郵箱已註冊，您將收到重設密碼的郵件',
      });
    } catch (error) {
      next(error);
    }
  }
);

export default router;