import request from 'supertest';
import { app } from '../../src/server';

describe('Authentication Routes', () => {
  describe('POST /api/auth/register', () => {
    it('should register a new user successfully', async () => {
      const userData = {
        email: 'newuser@test.com',
        password: 'Password123!',
        displayName: '新用戶',
        phone: '0987654321',
        tenantId: 'test-tenant-id',
      };

      const response = await request(app)
        .post('/api/auth/register')
        .send(userData)
        .expect(201);

      expect(response.body.message).toBe('註冊成功');
      expect(response.body.data.user.email).toBe(userData.email);
      expect(response.body.data.tokens).toHaveProperty('accessToken');
      expect(response.body.data.tokens).toHaveProperty('refreshToken');
    });

    it('should return error for duplicate email', async () => {
      const userData = {
        email: 'admin@test.com', // 已存在的測試用戶
        password: 'Password123!',
        displayName: '重複用戶',
        tenantId: 'test-tenant-id',
      };

      const response = await request(app)
        .post('/api/auth/register')
        .send(userData)
        .expect(409);

      expect(response.body.message).toBe('該電子郵件已被註冊');
    });

    it('should return validation error for invalid data', async () => {
      const userData = {
        email: 'invalid-email',
        password: '123', // 密碼太短
        displayName: '',
      };

      const response = await request(app)
        .post('/api/auth/register')
        .send(userData)
        .expect(400);

      expect(response.body.message).toBe('輸入數據無效');
    });
  });

  describe('POST /api/auth/login', () => {
    it('should login successfully with valid credentials', async () => {
      const loginData = {
        email: 'admin@test.com',
        password: 'testpassword123',
        tenantId: 'test-tenant-id',
      };

      const response = await request(app)
        .post('/api/auth/login')
        .send(loginData)
        .expect(200);

      expect(response.body.message).toBe('登入成功');
      expect(response.body.data.user.email).toBe(loginData.email);
      expect(response.body.data.tokens).toHaveProperty('accessToken');
    });

    it('should return error for invalid credentials', async () => {
      const loginData = {
        email: 'admin@test.com',
        password: 'wrongpassword',
        tenantId: 'test-tenant-id',
      };

      const response = await request(app)
        .post('/api/auth/login')
        .send(loginData)
        .expect(401);

      expect(response.body.message).toBe('電子郵件或密碼錯誤');
    });

    it('should return error for non-existent user', async () => {
      const loginData = {
        email: 'nonexistent@test.com',
        password: 'Password123!',
        tenantId: 'test-tenant-id',
      };

      const response = await request(app)
        .post('/api/auth/login')
        .send(loginData)
        .expect(401);

      expect(response.body.message).toBe('電子郵件或密碼錯誤');
    });
  });

  describe('POST /api/auth/refresh', () => {
    let refreshToken: string;

    beforeAll(async () => {
      // 先登入獲取refresh token
      const loginResponse = await request(app)
        .post('/api/auth/login')
        .send({
          email: 'admin@test.com',
          password: 'testpassword123',
          tenantId: 'test-tenant-id',
        });

      refreshToken = loginResponse.body.data.tokens.refreshToken;
    });

    it('should refresh token successfully', async () => {
      const response = await request(app)
        .post('/api/auth/refresh')
        .send({ refreshToken })
        .expect(200);

      expect(response.body.message).toBe('令牌刷新成功');
      expect(response.body.data.tokens).toHaveProperty('accessToken');
      expect(response.body.data.tokens).toHaveProperty('refreshToken');
    });

    it('should return error for invalid refresh token', async () => {
      const response = await request(app)
        .post('/api/auth/refresh')
        .send({ refreshToken: 'invalid-token' })
        .expect(401);

      expect(response.body.message).toBe('刷新令牌無效');
    });
  });

  describe('POST /api/auth/logout', () => {
    it('should logout successfully', async () => {
      const response = await request(app)
        .post('/api/auth/logout')
        .expect(200);

      expect(response.body.message).toBe('登出成功');
    });
  });
});