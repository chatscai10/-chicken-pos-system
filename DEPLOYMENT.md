# 🚀 部署指南 - 雞排店線上點餐系統

## 系統要求

### 最低硬體需求
- **CPU**: 2核心
- **記憶體**: 4GB RAM
- **存儲**: 20GB SSD
- **網路**: 100Mbps

### 推薦硬體配置
- **CPU**: 4核心
- **記憶體**: 8GB RAM
- **存儲**: 50GB SSD
- **網路**: 1Gbps

### 軟體依賴
- Node.js 18.0+
- npm 9.0+
- Azure SQL Database 或 SQL Server 2019+
- Redis 6.0+

## Azure雲端部署

### 1. 資源創建

```bash
# 創建資源群組
az group create --name chicken-pos-rg --location eastasia

# 創建Azure SQL Database
az sql server create \\
  --name chicken-pos-sql \\
  --resource-group chicken-pos-rg \\
  --location eastasia \\
  --admin-user posadmin \\
  --admin-password YourSecurePassword123!

az sql db create \\
  --resource-group chicken-pos-rg \\
  --server chicken-pos-sql \\
  --name chicken-pos-db \\
  --service-objective S2

# 創建Redis Cache
az redis create \\
  --location eastasia \\
  --name chicken-pos-redis \\
  --resource-group chicken-pos-rg \\
  --sku Basic \\
  --vm-size c1

# 創建App Service Plan
az appservice plan create \\
  --name chicken-pos-plan \\
  --resource-group chicken-pos-rg \\
  --sku S2 \\
  --is-linux

# 創建Web App
az webapp create \\
  --resource-group chicken-pos-rg \\
  --plan chicken-pos-plan \\
  --name chicken-pos-api \\
  --runtime "NODE|18-lts"
```

### 2. 環境變數配置

```bash
# 設置應用程式設定
az webapp config appsettings set \\
  --resource-group chicken-pos-rg \\
  --name chicken-pos-api \\
  --settings \\
    NODE_ENV=production \\
    DATABASE_URL="your_database_connection_string" \\
    REDIS_URL="your_redis_connection_string" \\
    JWT_SECRET="your_jwt_secret" \\
    LINE_PAY_CHANNEL_ID="your_line_pay_channel_id" \\
    LINE_PAY_CHANNEL_SECRET="your_line_pay_channel_secret"
```

### 3. 部署應用程式

```bash
# 建置應用程式
npm install
npm run build

# 部署到Azure
az webapp deployment source config-zip \\
  --resource-group chicken-pos-rg \\
  --name chicken-pos-api \\
  --src dist.zip
```

## Docker部署

### 1. Dockerfile

```dockerfile
# 多階段構建
FROM node:18-alpine AS builder

WORKDIR /app
COPY package*.json ./
RUN npm ci --only=production && npm cache clean --force

FROM node:18-alpine AS runtime

# 創建非root用戶
RUN addgroup -g 1001 -S nodejs
RUN adduser -S nextjs -u 1001

WORKDIR /app

# 複製依賴
COPY --from=builder /app/node_modules ./node_modules
COPY --chown=nextjs:nodejs . .

# 建置應用程式
RUN npm run build

# 切換到非root用戶
USER nextjs

# 暴露端口
EXPOSE 3000

# 健康檢查
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \\
  CMD curl -f http://localhost:3000/health || exit 1

# 啟動應用程式
CMD ["npm", "start"]
```

### 2. docker-compose.yml

```yaml
version: '3.8'

services:
  app:
    build: .
    ports:
      - "3000:3000"
    environment:
      - NODE_ENV=production
      - DATABASE_URL=sqlserver://db:1433;database=chicken_pos;user=sa;password=YourPassword123!
      - REDIS_URL=redis://redis:6379
    depends_on:
      - db
      - redis
    restart: unless-stopped

  db:
    image: mcr.microsoft.com/mssql/server:2019-latest
    environment:
      - ACCEPT_EULA=Y
      - SA_PASSWORD=YourPassword123!
    ports:
      - "1433:1433"
    volumes:
      - sqlserver_data:/var/opt/mssql
    restart: unless-stopped

  redis:
    image: redis:6-alpine
    ports:
      - "6379:6379"
    volumes:
      - redis_data:/data
    restart: unless-stopped

  nginx:
    image: nginx:alpine
    ports:
      - "80:80"
      - "443:443"
    volumes:
      - ./nginx.conf:/etc/nginx/nginx.conf
      - ./ssl:/etc/ssl
    depends_on:
      - app
    restart: unless-stopped

volumes:
  sqlserver_data:
  redis_data:
```

### 3. 部署命令

```bash
# 啟動服務
docker-compose up -d

# 查看日誌
docker-compose logs -f

# 停止服務
docker-compose down
```

## 資料庫遷移

### 1. 初始化資料庫

```bash
# 生成Prisma Client
npx prisma generate

# 運行資料庫遷移
npx prisma migrate deploy

# 填充種子數據
npx prisma db seed
```

### 2. 備份與還原

```bash
# 備份資料庫
sqlcmd -S server_name -d chicken_pos_db -Q "BACKUP DATABASE chicken_pos_db TO DISK = 'backup.bak'"

# 還原資料庫
sqlcmd -S server_name -Q "RESTORE DATABASE chicken_pos_db FROM DISK = 'backup.bak'"
```

## SSL憑證配置

### 1. Let's Encrypt (免費)

```bash
# 安裝Certbot
sudo apt-get install certbot python3-certbot-nginx

# 獲取憑證
sudo certbot --nginx -d yourdomain.com

# 自動續約
sudo crontab -e
# 添加: 0 12 * * * /usr/bin/certbot renew --quiet
```

### 2. 商業憑證

```nginx
server {
    listen 443 ssl http2;
    server_name yourdomain.com;

    ssl_certificate /path/to/your/certificate.crt;
    ssl_certificate_key /path/to/your/private.key;
    
    ssl_protocols TLSv1.2 TLSv1.3;
    ssl_ciphers ECDHE-RSA-AES128-GCM-SHA256:ECDHE-RSA-AES256-GCM-SHA384;
    ssl_prefer_server_ciphers off;

    location / {
        proxy_pass http://localhost:3000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host $host;
        proxy_cache_bypass $http_upgrade;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
```

## 監控與日誌

### 1. PM2進程管理

```javascript
// ecosystem.config.js
module.exports = {
  apps: [{
    name: 'chicken-pos-api',
    script: 'dist/server.js',
    instances: 'max',
    exec_mode: 'cluster',
    env: {
      NODE_ENV: 'development'
    },
    env_production: {
      NODE_ENV: 'production',
      PORT: 3000
    },
    log_file: './logs/combined.log',
    out_file: './logs/out.log',
    error_file: './logs/error.log',
    log_date_format: 'YYYY-MM-DD HH:mm Z',
    max_memory_restart: '1G',
    node_args: '--max_old_space_size=1024'
  }]
};
```

```bash
# 啟動應用
pm2 start ecosystem.config.js --env production

# 查看狀態
pm2 status

# 查看日誌
pm2 logs

# 重新啟動
pm2 restart chicken-pos-api

# 設置開機自啟
pm2 startup
pm2 save
```

### 2. 日誌輪替

```bash
# /etc/logrotate.d/chicken-pos
/var/log/chicken-pos/*.log {
    daily
    missingok
    rotate 14
    compress
    notifempty
    create 644 nodejs nodejs
    postrotate
        pm2 reloadLogs
    endscript
}
```

## 效能調優

### 1. Node.js優化

```javascript
// 在server.ts中添加
process.env.UV_THREADPOOL_SIZE = '16'; // 增加線程池大小

// 設置記憶體限制
if (process.env.NODE_ENV === 'production') {
  process.env.NODE_OPTIONS = '--max_old_space_size=2048';
}
```

### 2. 資料庫優化

```sql
-- 建立索引
CREATE INDEX IX_Order_StoreId_CreatedAt ON [Order] (StoreId, CreatedAt);
CREATE INDEX IX_Order_CustomerId_Status ON [Order] (CustomerId, Status);
CREATE INDEX IX_OrderItem_ProductId ON OrderItem (ProductId);

-- 統計資訊更新
UPDATE STATISTICS [Order];
UPDATE STATISTICS [OrderItem];
UPDATE STATISTICS [Product];
```

### 3. Redis優化

```bash
# redis.conf配置
maxmemory 1gb
maxmemory-policy allkeys-lru
save 900 1
save 300 10
save 60 10000
```

## 安全性檢查清單

### 1. 網路安全
- [ ] 防火牆配置正確
- [ ] 僅開放必要端口 (80, 443, 22)
- [ ] SSH密鑰認證
- [ ] DDoS防護啟用

### 2. 應用安全
- [ ] 所有API端點都有認證
- [ ] 輸入驗證和SQL注入防護
- [ ] XSS防護啟用
- [ ] CORS配置正確
- [ ] 敏感資訊不在日誌中

### 3. 資料安全
- [ ] 資料庫加密
- [ ] 定期備份
- [ ] 密碼強度要求
- [ ] JWT密鑰安全
- [ ] 資料駐留合規

## 故障排除

### 1. 常見問題

**應用無法啟動**
```bash
# 檢查日誌
pm2 logs chicken-pos-api

# 檢查端口佔用
netstat -tlnp | grep :3000

# 檢查環境變數
pm2 env chicken-pos-api
```

**資料庫連接失敗**
```bash
# 測試連接
npx prisma db push --preview-feature

# 檢查防火牆規則
az sql server firewall-rule list --resource-group chicken-pos-rg --server chicken-pos-sql
```

**Redis連接問題**
```bash
# 測試Redis連接
redis-cli -h your-redis-host.redis.cache.windows.net -p 6380 -a YourAccessKey ping
```

### 2. 效能問題

**記憶體洩漏**
```bash
# 查看記憶體使用
pm2 monit

# 產生heap dump
node --inspect=9229 dist/server.js
```

**資料庫查詢慢**
```sql
-- 查看慢查詢
SELECT TOP 10 
    total_worker_time/execution_count AS avg_cpu_time,
    total_logical_reads/execution_count as avg_logical_reads,
    total_elapsed_time/execution_count as avg_elapsed_time,
    execution_count,
    SUBSTRING(st.text, (qs.statement_start_offset/2)+1, 
        ((CASE qs.statement_end_offset
            WHEN -1 THEN DATALENGTH(st.text)
            ELSE qs.statement_end_offset
            END - qs.statement_start_offset)/2) + 1) AS statement_text
FROM sys.dm_exec_query_stats qs
CROSS APPLY sys.dm_exec_sql_text(qs.sql_handle) st
ORDER BY total_worker_time/execution_count DESC;
```

## 維護計畫

### 1. 日常維護
- [ ] 檢查系統日誌
- [ ] 監控資源使用
- [ ] 備份驗證
- [ ] SSL憑證檢查

### 2. 定期維護
- [ ] 系統更新 (每月)
- [ ] 資料庫維護 (每週)
- [ ] 效能評估 (每季)
- [ ] 安全審計 (每半年)

### 3. 緊急響應
- [ ] 24/7監控告警
- [ ] 備用系統準備
- [ ] 回滾計畫
- [ ] 聯絡人清單

---

## 部署檢查清單

部署前請確認以下項目：

### 環境配置
- [ ] 生產環境變數設定
- [ ] 資料庫連接字串
- [ ] Redis連接設定
- [ ] SSL憑證配置

### 安全設定
- [ ] JWT密鑰已更新
- [ ] API密鑰已設定
- [ ] 防火牆規則正確
- [ ] HTTPS強制啟用

### 功能測試
- [ ] 用戶註冊登入
- [ ] 訂單創建流程
- [ ] 支付功能測試
- [ ] 即時通知測試

### 效能驗證
- [ ] 負載測試通過
- [ ] 資料庫效能正常
- [ ] 快取功能正常
- [ ] 監控系統運作

部署完成後，請進行完整的功能測試以確保系統正常運作。