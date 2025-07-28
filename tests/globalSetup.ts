import { PrismaClient } from '@prisma/client';
import { execSync } from 'child_process';
import { v4 as uuidv4 } from 'uuid';

const prisma = new PrismaClient();

export default async function globalSetup() {
  // 設置測試資料庫
  const testDatabaseUrl = process.env.TEST_DATABASE_URL || 
    `sqlserver://localhost:1433;database=chicken_pos_test_${uuidv4().slice(0, 8)};user=sa;password=TestPassword123;trustServerCertificate=true;encrypt=true`;
  
  process.env.DATABASE_URL = testDatabaseUrl;
  
  try {
    // 運行資料庫遷移
    execSync('npx prisma migrate deploy', { stdio: 'inherit' });
    
    // 創建測試種子數據
    await seedTestData();
    
    console.log('測試環境設置完成');
  } catch (error) {
    console.error('測試環境設置失敗:', error);
    throw error;
  }
}

async function seedTestData() {
  // 創建測試角色
  const roles = [
    { name: 'SUPER_ADMIN', description: '超級管理員', permissions: {} },
    { name: 'TENANT_ADMIN', description: '租戶管理員', permissions: {} },
    { name: 'STORE_MANAGER', description: '店鋪管理員', permissions: {} },
    { name: 'STAFF', description: '員工', permissions: {} },
    { name: 'CUSTOMER', description: '顧客', permissions: {} },
  ];

  for (const role of roles) {
    await prisma.role.upsert({
      where: { name: role.name },
      update: {},
      create: role,
    });
  }

  // 創建測試租戶
  const testTenant = await prisma.tenant.upsert({
    where: { id: 'test-tenant-id' },
    update: {},
    create: {
      id: 'test-tenant-id',
      name: '測試租戶',
      status: 'ACTIVE',
      domain: 'test',
    },
  });

  // 創建測試租戶訂閱
  await prisma.tenantSubscription.upsert({
    where: { tenantId: testTenant.id },
    update: {},
    create: {
      tenantId: testTenant.id,
      planType: 'PROFESSIONAL',
      status: 'ACTIVE',
      currentPeriodStart: new Date(),
      currentPeriodEnd: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
      billingCycle: 'MONTHLY',
      price: 3000,
      currency: 'TWD',
      features: {
        maxStores: 3,
        maxProducts: 500,
        maxOrders: 1000,
      },
    },
  });

  // 創建測試用戶
  const bcrypt = require('bcryptjs');
  const hashedPassword = await bcrypt.hash('testpassword123', 12);

  const testAdmin = await prisma.user.upsert({
    where: { id: 'test-admin-id' },
    update: {},
    create: {
      id: 'test-admin-id',
      tenantId: testTenant.id,
      email: 'admin@test.com',
      password: hashedPassword,
      displayName: '測試管理員',
      status: 'ACTIVE',
    },
  });

  const testCustomer = await prisma.user.upsert({
    where: { id: 'test-customer-id' },
    update: {},
    create: {
      id: 'test-customer-id',
      tenantId: testTenant.id,
      email: 'customer@test.com',
      password: hashedPassword,
      displayName: '測試顧客',
      phone: '0912345678',
      status: 'ACTIVE',
    },
  });

  // 分配角色
  const adminRole = await prisma.role.findFirst({ where: { name: 'TENANT_ADMIN' } });
  const customerRole = await prisma.role.findFirst({ where: { name: 'CUSTOMER' } });

  if (adminRole) {
    await prisma.userRole.upsert({
      where: { 
        userId_roleId: {
          userId: testAdmin.id,
          roleId: adminRole.id,
        }
      },
      update: {},
      create: {
        userId: testAdmin.id,
        roleId: adminRole.id,
      },
    });
  }

  if (customerRole) {
    await prisma.userRole.upsert({
      where: { 
        userId_roleId: {
          userId: testCustomer.id,
          roleId: customerRole.id,
        }
      },
      update: {},
      create: {
        userId: testCustomer.id,
        roleId: customerRole.id,
      },
    });
  }

  // 創建顧客資料
  await prisma.customerProfile.upsert({
    where: { userId: testCustomer.id },
    update: {},
    create: {
      userId: testCustomer.id,
      loyaltyTier: 'BRONZE',
      totalSpent: 0,
    },
  });

  // 創建測試店鋪
  const testStore = await prisma.store.upsert({
    where: { id: 'test-store-id' },
    update: {},
    create: {
      id: 'test-store-id',
      tenantId: testTenant.id,
      name: '測試雞排店',
      description: '專業測試用雞排店',
      address: '台北市信義區測試路123號',
      phone: '02-1234-5678',
      email: 'store@test.com',
      status: 'ACTIVE',
      businessHours: {
        monday: { open: '10:00', close: '22:00' },
        tuesday: { open: '10:00', close: '22:00' },
        wednesday: { open: '10:00', close: '22:00' },
        thursday: { open: '10:00', close: '22:00' },
        friday: { open: '10:00', close: '22:00' },
        saturday: { open: '10:00', close: '22:00' },
        sunday: { open: '10:00', close: '21:00' },
      },
    },
  });

  // 創建測試商品分類
  const testCategory = await prisma.category.upsert({
    where: { id: 'test-category-id' },
    update: {},
    create: {
      id: 'test-category-id',
      storeId: testStore.id,
      name: '雞排類',
      description: '各式美味雞排',
      sortOrder: 1,
      isActive: true,
    },
  });

  // 創建測試商品
  const testProduct = await prisma.product.upsert({
    where: { id: 'test-product-id' },
    update: {},
    create: {
      id: 'test-product-id',
      storeId: testStore.id,
      categoryId: testCategory.id,
      name: '香雞排',
      description: '酥脆外皮，嫩滑雞肉',
      basePrice: 60,
      isAvailable: true,
      sortOrder: 1,
    },
  });

  // 創建測試商品規格
  await prisma.productVariant.upsert({
    where: { id: 'test-variant-id' },
    update: {},
    create: {
      id: 'test-variant-id',
      productId: testProduct.id,
      name: '大份',
      price: 80,
      isDefault: false,
    },
  });

  // 創建測試加購項目
  await prisma.productAddon.upsert({
    where: { id: 'test-addon-id' },
    update: {},
    create: {
      id: 'test-addon-id',
      productId: testProduct.id,
      name: '加辣',
      price: 0,
      isRequired: false,
      maxQuantity: 1,
    },
  });

  // 創建測試庫存
  await prisma.inventory.upsert({
    where: { productId: testProduct.id },
    update: {},
    create: {
      productId: testProduct.id,
      quantity: 100,
      minQuantity: 10,
      unit: '份',
    },
  });

  console.log('測試種子數據創建完成');
}