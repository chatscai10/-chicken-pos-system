#!/bin/bash

echo "🚀 Vercel 部署腳本"
echo "=================="

# 檢查是否安裝 Vercel CLI
if ! command -v vercel &> /dev/null; then
    echo "📦 安裝 Vercel CLI..."
    npm install -g vercel
fi

echo "🔧 建立生產環境配置..."

# 建立生產環境資料庫Schema
echo "📊 轉換資料庫 Schema 為 PostgreSQL..."
cat > prisma/schema-production.prisma << 'EOL'
// Prisma schema 文件 (PostgreSQL 生產版)
generator client {
  provider = "prisma-client-js"
}

datasource db {
  provider = "postgresql"
  url      = env("DATABASE_URL")
}

// ================================
// 系統核心表
// ================================

// 租戶管理
model Tenant {
  id          String   @id @default(cuid())
  name        String
  domain      String?  @unique
  status      String   @default("ACTIVE") // ACTIVE, SUSPENDED, CANCELLED
  settings    Json?
  createdAt   DateTime @default(now())
  updatedAt   DateTime @updatedAt

  // 關聯
  subscription TenantSubscription?
  stores       Store[]
  users        User[]

  @@map("tenants")
}

// 租戶訂閱
model TenantSubscription {
  id              String   @id @default(cuid())
  tenantId        String   @unique
  planType        String   // FREE, PROFESSIONAL, ENTERPRISE, CUSTOM
  status          String   @default("ACTIVE") // ACTIVE, CANCELLED, EXPIRED
  currentPeriodStart DateTime
  currentPeriodEnd   DateTime
  trialEnd        DateTime?
  billingCycle    String   @default("MONTHLY") // MONTHLY, YEARLY
  price           Decimal  @default(0) @db.Decimal(10,2)
  currency        String   @default("TWD")
  features        Json?
  
  // 關聯
  tenant          Tenant   @relation(fields: [tenantId], references: [id])

  @@map("tenant_subscriptions")
}

// ================================
// 用戶系統
// ================================

model User {
  id          String     @id @default(cuid())
  tenantId    String
  email       String
  password    String
  displayName String
  phone       String?
  avatar      String?
  status      String     @default("ACTIVE") // ACTIVE, INACTIVE, SUSPENDED
  lastLoginAt DateTime?
  createdAt   DateTime   @default(now())
  updatedAt   DateTime   @updatedAt

  // 關聯
  tenant       Tenant    @relation(fields: [tenantId], references: [id])
  roles        UserRole[]
  customerProfile CustomerProfile?
  staffProfile    StaffProfile?
  orders          Order[]
  memberPoints    MemberPoint[]

  @@unique([tenantId, email])
  @@map("users")
}

model Role {
  id          String @id @default(cuid())
  name        String @unique
  description String?
  permissions Json
  
  // 關聯
  userRoles   UserRole[]

  @@map("roles")
}

model UserRole {
  id     String @id @default(cuid())
  userId String
  roleId String

  // 關聯  
  user   User   @relation(fields: [userId], references: [id])
  role   Role   @relation(fields: [roleId], references: [id])

  @@unique([userId, roleId])
  @@map("user_roles")
}

// 顧客資料
model CustomerProfile {
  id          String    @id @default(cuid())
  userId      String    @unique
  birthday    DateTime?
  gender      String?   // MALE, FEMALE, OTHER
  address     String?
  preferences Json?
  loyaltyTier String    @default("BRONZE") // BRONZE, SILVER, GOLD, PLATINUM
  totalSpent  Decimal   @default(0) @db.Decimal(10,2)
  
  // 關聯
  user        User      @relation(fields: [userId], references: [id])

  @@map("customer_profiles")
}

// 員工資料
model StaffProfile {
  id          String    @id @default(cuid())
  userId      String    @unique
  employeeId  String
  position    String
  department  String?
  hireDate    DateTime
  salary      Decimal?  @db.Decimal(10,2)
  
  // 關聯
  user        User      @relation(fields: [userId], references: [id])

  @@map("staff_profiles")
}

// ================================
// 店鋪管理
// ================================

model Store {
  id          String      @id @default(cuid())
  tenantId    String
  name        String
  description String?
  address     String
  phone       String
  email       String?
  image       String?
  status      String      @default("ACTIVE") // ACTIVE, INACTIVE, MAINTENANCE
  settings    Json?
  createdAt   DateTime    @default(now())
  updatedAt   DateTime    @updatedAt

  // 營業時間
  businessHours Json?

  // 關聯
  tenant        Tenant     @relation(fields: [tenantId], references: [id])
  branches      StoreBranch[]
  categories    Category[]
  products      Product[]
  orders        Order[]
  printers      Printer[]

  @@map("stores")
}

model StoreBranch {
  id        String @id @default(cuid())
  storeId   String
  name      String
  address   String
  phone     String
  isMain    Boolean @default(false)
  
  // 關聯
  store     Store  @relation(fields: [storeId], references: [id])
  orders    Order[]

  @@map("store_branches")
}

// ================================
// 商品系統
// ================================

model Category {
  id          String   @id @default(cuid())
  storeId     String
  name        String
  description String?
  sortOrder   Int      @default(0)
  isActive    Boolean  @default(true)
  createdAt   DateTime @default(now())

  // 關聯
  store       Store    @relation(fields: [storeId], references: [id])
  products    Product[]

  @@map("categories")
}

model Product {
  id          String    @id @default(cuid())
  storeId     String
  categoryId  String
  name        String
  description String?
  basePrice   Decimal   @db.Decimal(10,2)
  image       String?
  isAvailable Boolean   @default(true)
  sortOrder   Int       @default(0)
  createdAt   DateTime  @default(now())
  updatedAt   DateTime  @updatedAt

  // 關聯
  store       Store     @relation(fields: [storeId], references: [id])
  category    Category  @relation(fields: [categoryId], references: [id])
  variants    ProductVariant[]
  addons      ProductAddon[]
  inventory   Inventory?
  orderItems  OrderItem[]

  @@map("products")
}

model ProductVariant {
  id        String  @id @default(cuid())
  productId String
  name      String
  price     Decimal @db.Decimal(10,2)
  isDefault Boolean @default(false)

  // 關聯
  product   Product @relation(fields: [productId], references: [id])
  orderItems OrderItem[]

  @@map("product_variants")
}

model ProductAddon {
  id           String  @id @default(cuid())
  productId    String
  name         String
  price        Decimal @db.Decimal(10,2)
  isRequired   Boolean @default(false)
  maxQuantity  Int     @default(1)

  // 關聯
  product      Product @relation(fields: [productId], references: [id])
  orderItemAddons OrderItemAddon[]

  @@map("product_addons")
}

model Inventory {
  id          String @id @default(cuid())
  productId   String @unique
  quantity    Int
  minQuantity Int    @default(0)
  unit        String @default("個")
  
  // 關聯
  product     Product @relation(fields: [productId], references: [id])

  @@map("inventory")
}

// ================================
// 訂單系統
// ================================

model Order {
  id            String      @id @default(cuid())
  orderNumber   String      @unique
  storeId       String
  branchId      String?
  customerId    String
  orderType     String      // DINE_IN, TAKEOUT, DELIVERY, UBER_EATS
  status        String      @default("PENDING") // PENDING, CONFIRMED, PREPARING, READY, COMPLETED, CANCELLED
  totalAmount   Decimal     @db.Decimal(10,2)
  discountAmount Decimal    @default(0) @db.Decimal(10,2)
  finalAmount   Decimal     @db.Decimal(10,2)
  paymentStatus String      @default("PENDING") // PENDING, COMPLETED, FAILED, REFUNDED
  estimatedTime Int?        // 預估製作時間(分鐘)
  note          String?
  tableNumber   String?
  createdAt     DateTime    @default(now())
  updatedAt     DateTime    @updatedAt

  // 關聯
  store         Store       @relation(fields: [storeId], references: [id])
  branch        StoreBranch? @relation(fields: [branchId], references: [id])
  customer      User        @relation(fields: [customerId], references: [id])
  items         OrderItem[]
  payments      Payment[]
  statusHistory OrderStatusHistory[]

  @@map("orders")
}

model OrderItem {
  id          String  @id @default(cuid())
  orderId     String
  productId   String
  variantId   String?
  quantity    Int
  unitPrice   Decimal @db.Decimal(10,2)
  totalPrice  Decimal @db.Decimal(10,2)
  note        String?

  // 關聯
  order       Order   @relation(fields: [orderId], references: [id])
  product     Product @relation(fields: [productId], references: [id])
  variant     ProductVariant? @relation(fields: [variantId], references: [id])
  addons      OrderItemAddon[]

  @@map("order_items")
}

model OrderItemAddon {
  id        String @id @default(cuid())
  orderItemId String
  addonId   String
  quantity  Int
  price     Decimal @db.Decimal(10,2)

  // 關聯
  orderItem OrderItem    @relation(fields: [orderItemId], references: [id])
  addon     ProductAddon @relation(fields: [addonId], references: [id])

  @@map("order_item_addons")
}

model OrderStatusHistory {
  id        String      @id @default(cuid())
  orderId   String
  status    String      
  note      String?
  createdAt DateTime    @default(now())
  createdBy String?

  // 關聯
  order     Order       @relation(fields: [orderId], references: [id])

  @@map("order_status_history")
}

// ================================
// 支付系統
// ================================

model Payment {
  id              String        @id @default(cuid())
  orderId         String
  amount          Decimal       @db.Decimal(10,2)
  method          String        // CASH, CARD, LINE_PAY, MOBILE_PAYMENT
  status          String        @default("PENDING") // PENDING, COMPLETED, FAILED, REFUNDED
  transactionId   String?
  paidAt          DateTime?
  refundedAt      DateTime?
  createdAt       DateTime      @default(now())

  // 關聯
  order           Order         @relation(fields: [orderId], references: [id])

  @@map("payments")
}

// ================================
// 會員系統
// ================================

model MemberPoint {
  id          String      @id @default(cuid())
  userId      String
  type        String      // EARN, REDEEM, EXPIRE, ADMIN_ADJUST
  amount      Int
  description String
  expiresAt   DateTime?
  createdAt   DateTime    @default(now())

  // 關聯
  user        User        @relation(fields: [userId], references: [id])

  @@map("member_points")
}

model Coupon {
  id            String     @id @default(cuid())
  storeId       String
  name          String
  code          String     @unique
  type          String     // PERCENTAGE, FIXED_AMOUNT, FREE_SHIPPING
  value         Decimal    @db.Decimal(10,2)
  minOrderAmount Decimal?  @db.Decimal(10,2)
  maxDiscount   Decimal?   @db.Decimal(10,2)
  usageLimit    Int?
  usedCount     Int        @default(0)
  isActive      Boolean    @default(true)
  validFrom     DateTime
  validUntil    DateTime
  createdAt     DateTime   @default(now())

  @@map("coupons")
}

// ================================
// 打印機系統
// ================================

model Printer {
  id        String      @id @default(cuid())
  storeId   String
  name      String
  type      String      // EPSON, STAR, GENERIC
  location  String
  ipAddress String?
  apiKey    String?
  settings  Json?
  isActive  Boolean     @default(true)

  // 關聯
  store     Store       @relation(fields: [storeId], references: [id])
  jobs      PrintJob[]

  @@map("printers")
}

model PrintJob {
  id        String    @id @default(cuid())
  printerId String
  orderId   String
  content   String    // 打印內容
  status    String    @default("PENDING") // PENDING, PRINTING, COMPLETED, FAILED
  retryCount Int      @default(0)
  createdAt DateTime  @default(now())
  printedAt DateTime?

  // 關聯
  printer   Printer   @relation(fields: [printerId], references: [id])

  @@map("print_jobs")
}
EOL

echo "📝 建立環境變數模板..."
cat > .env.production.template << 'EOL'
# 生產環境配置模板
NODE_ENV=production
PORT=3000
API_VERSION=v1

# 資料庫配置 (請替換為真實的 PostgreSQL 連接字串)
DATABASE_URL="postgresql://username:password@hostname:5432/database_name?schema=public"

# JWT配置 (請生成安全的密鑰)
JWT_SECRET="請替換為超級安全的JWT密鑰_至少32字符"
JWT_EXPIRES_IN="24h"
JWT_REFRESH_SECRET="請替換為刷新令牌密鑰_至少32字符"
JWT_REFRESH_EXPIRES_IN="7d"

# LINE相關配置 (請替換為真實的API金鑰)
LINE_CHANNEL_ID="您的真實LINE Channel ID"
LINE_CHANNEL_SECRET="您的真實LINE Channel Secret"
LINE_CALLBACK_URL="https://您的網域.vercel.app/auth/line/callback"

# LINE Pay配置 (請替換為真實的API金鑰)
LINE_PAY_CHANNEL_ID="您的真實LINE Pay Channel ID"
LINE_PAY_CHANNEL_SECRET="您的真實LINE Pay Channel Secret"
LINE_PAY_ENV="production"
LINE_PAY_API_URL="https://api-pay.line.me"

# Uber Eats配置 (如需要)
UBER_CLIENT_ID="您的Uber Client ID"
UBER_CLIENT_SECRET="您的Uber Client Secret"
UBER_API_URL="https://api.uber.com"

# 郵件服務配置 (推薦使用 SendGrid)
SENDGRID_API_KEY="您的SendGrid API密鑰"
FROM_EMAIL="noreply@您的網域.com"

# 安全配置
BCRYPT_ROUNDS=12
RATE_LIMIT_WINDOW_MS=900000
RATE_LIMIT_MAX_REQUESTS=100

# 應用配置
APP_URL="https://您的網域.vercel.app"
FRONTEND_URL="https://您的前端網域.vercel.app"
UPLOAD_MAX_SIZE=5242880

# 日誌配置
LOG_LEVEL="info"
EOL

echo "🔧 修改 package.json 添加生產腳本..."
# 使用 node 來修改 package.json
node -e "
const fs = require('fs');
const pkg = JSON.parse(fs.readFileSync('package.json', 'utf8'));
pkg.scripts = {
  ...pkg.scripts,
  'vercel-build': 'prisma generate && prisma migrate deploy && npm run build',
  'start:prod': 'node dist/test-server.js',
  'db:migrate:prod': 'prisma migrate deploy',
  'db:generate': 'prisma generate'
};
fs.writeFileSync('package.json', JSON.stringify(pkg, null, 2));
console.log('✅ package.json 已更新');
"

echo ""
echo "🚀 開始 Vercel 部署..."
echo "1. 請先安裝依賴: npm install"
echo "2. 登入 Vercel: vercel login"
echo "3. 部署: vercel --prod"
echo ""
echo "🔧 部署前請確認："
echo "✅ GitHub 倉庫已推送"
echo "⚠️  需要設定 PostgreSQL 資料庫 (推薦 Supabase 或 PlanetScale)"
echo "⚠️  需要在 Vercel 面板設定環境變數"
echo ""
read -p "按 Enter 繼續自動部署，或 Ctrl+C 取消..."

# 自動部署
vercel login
vercel --prod