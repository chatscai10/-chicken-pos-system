import { PrismaClient } from '@prisma/client';
import * as bcrypt from 'bcryptjs';

const prisma = new PrismaClient();

async function main() {
  console.log('開始初始化測試數據...');

  // 創建角色
  const roles = [
    { name: 'SUPER_ADMIN', description: '超級管理員', permissions: '{"all": true}' },
    { name: 'TENANT_ADMIN', description: '租戶管理員', permissions: '{"tenant": true}' },
    { name: 'STORE_MANAGER', description: '店鋪管理員', permissions: '{"store": true}' },
    { name: 'STAFF', description: '員工', permissions: '{"pos": true}' },
    { name: 'CUSTOMER', description: '顧客', permissions: '{"order": true}' },
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
      name: '測試雞排連鎖',
      domain: 'test-chicken',
      status: 'ACTIVE',
      settings: JSON.stringify({
        theme: 'default',
        currency: 'TWD',
        timezone: 'Asia/Taipei'
      }),
    },
  });

  // 創建租戶訂閱
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
      features: JSON.stringify({
        maxStores: 3,
        maxProducts: 500,
        maxOrders: 1000,
      }),
    },
  });

  // 創建測試用戶
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
      phone: '0912345678',
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
      phone: '0987654321',
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
      preferences: JSON.stringify({
        spiceLevel: 'medium',
        dietary: []
      }),
    },
  });

  // 創建測試店鋪
  const testStore = await prisma.store.upsert({
    where: { id: 'test-store-id' },
    update: {},
    create: {
      id: 'test-store-id',
      tenantId: testTenant.id,
      name: '信義店雞排專賣',
      description: '最新鮮的雞排，最道地的台灣味',
      address: '台北市信義區信義路五段123號',
      phone: '02-2345-6789',
      email: 'xinyi@test.com',
      status: 'ACTIVE',
      businessHours: JSON.stringify({
        monday: { open: '10:00', close: '22:00' },
        tuesday: { open: '10:00', close: '22:00' },
        wednesday: { open: '10:00', close: '22:00' },
        thursday: { open: '10:00', close: '22:00' },
        friday: { open: '10:00', close: '22:00' },
        saturday: { open: '10:00', close: '22:00' },
        sunday: { open: '10:00', close: '21:00' },
      }),
    },
  });

  // 創建測試商品分類
  const categories = [
    { id: 'cat-chicken', name: '雞排類', description: '各式美味雞排' },
    { id: 'cat-drink', name: '飲料類', description: '清涼解渴飲品' },
    { id: 'cat-side', name: '配菜類', description: '精選小食配菜' },
  ];

  for (const cat of categories) {
    await prisma.category.upsert({
      where: { id: cat.id },
      update: {},
      create: {
        id: cat.id,
        storeId: testStore.id,
        name: cat.name,
        description: cat.description,
        sortOrder: categories.indexOf(cat),
        isActive: true,
      },
    });
  }

  // 創建測試商品
  const products = [
    {
      id: 'prod-chicken-1',
      categoryId: 'cat-chicken',
      name: '經典雞排',
      description: '酥脆外皮，嫩滑雞肉，經典原味',
      basePrice: 60,
    },
    {
      id: 'prod-chicken-2',
      categoryId: 'cat-chicken',
      name: '辣味雞排',
      description: '特調辣椒粉，香辣帶勁',
      basePrice: 65,
    },
    {
      id: 'prod-drink-1',
      categoryId: 'cat-drink',
      name: '紅茶',
      description: '傳統台式紅茶',
      basePrice: 25,
    },
  ];

  for (const prod of products) {
    await prisma.product.upsert({
      where: { id: prod.id },
      update: {},
      create: {
        id: prod.id,
        storeId: testStore.id,
        categoryId: prod.categoryId,
        name: prod.name,
        description: prod.description,
        basePrice: prod.basePrice,
        isAvailable: true,
        sortOrder: products.indexOf(prod),
      },
    });

    // 為每個商品創建庫存記錄
    await prisma.inventory.upsert({
      where: { productId: prod.id },
      update: {},
      create: {
        productId: prod.id,
        quantity: 100,
        minQuantity: 10,
        unit: '份',
      },
    });
  }

  // 為雞排產品創建規格和加購項目
  await prisma.productVariant.create({
    data: {
      productId: 'prod-chicken-1',
      name: '大份',
      price: 20, // 額外加價
      isDefault: false,
    },
  });

  await prisma.productAddon.create({
    data: {
      productId: 'prod-chicken-1',
      name: '加起司',
      price: 15,
      isRequired: false,
      maxQuantity: 1,
    },
  });

  await prisma.productAddon.create({
    data: {
      productId: 'prod-chicken-1',
      name: '加辣',
      price: 0,
      isRequired: false,
      maxQuantity: 1,
    },
  });

  // 創建測試打印機
  await prisma.printer.create({
    data: {
      storeId: testStore.id,
      name: '收銀台打印機',
      type: 'EPSON',
      location: '收銀台',
      ipAddress: '192.168.1.100',
      isActive: true,
      settings: JSON.stringify({
        paperWidth: 80,
        fontSize: 12,
        copies: 1,
      }),
    },
  });

  console.log('測試數據初始化完成！');
  console.log('管理員帳號: admin@test.com / testpassword123');
  console.log('顧客帳號: customer@test.com / testpassword123');
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });