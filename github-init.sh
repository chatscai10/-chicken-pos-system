#!/bin/bash

echo "🚀 GitHub 部署準備腳本"
echo "========================"

# 檢查Git是否安裝
if ! command -v git &> /dev/null; then
    echo "❌ Git 未安裝，請先安裝 Git"
    exit 1
fi

# 檢查是否已經是Git倉庫
if [ ! -d ".git" ]; then
    echo "📦 初始化 Git 倉庫..."
    git init
    
    # 建立.gitignore
    echo "建立 .gitignore 檔案..."
    cat > .gitignore << EOL
# Dependencies
node_modules/
npm-debug.log*
yarn-debug.log*
yarn-error.log*

# Environment variables
.env
.env.local
.env.development
.env.test
.env.production

# Database
*.db
*.sqlite
*.sqlite3
dev.db

# Logs
logs/
*.log

# Runtime data
pids/
*.pid
*.seed
*.pid.lock

# Coverage directory used by tools like istanbul
coverage/

# Build outputs
dist/
build/

# IDE files
.vscode/
.idea/
*.swp
*.swo

# OS generated files
.DS_Store
.DS_Store?
._*
.Spotlight-V100
.Trashes
ehthumbs.db
Thumbs.db

# Temporary files
tmp/
temp/
verify-data.ts
EOL

else
    echo "✅ Git 倉庫已存在"
fi

# 添加所有檔案
echo "📁 添加檔案到 Git..."
git add .

# 檢查是否有變更
if git diff --staged --quiet; then
    echo "ℹ️  沒有檔案變更需要提交"
else
    # 提交變更
    echo "💾 提交變更..."
    git commit -m "🚀 準備部署：完整的雞排店POS系統

✅ 功能完成:
- 用戶認證系統 (註冊/登入/JWT)
- 店鋪管理系統
- 商品管理 (分類/規格/加購/庫存)
- 訂單系統 (完整下單流程)
- 支付系統準備 (LINE Pay整合)
- Socket.IO即時通訊準備
- SQLite本地測試完成

🛠️ 技術架構:
- Node.js + Express + TypeScript
- Prisma ORM + SQLite/PostgreSQL
- JWT認證 + bcrypt加密
- Socket.IO即時通訊
- 多租戶SaaS架構

📱 測試帳號:
- 管理員: admin@test.com / testpassword123
- 顧客: customer@test.com / testpassword123

🎯 準備生產部署: Vercel + Railway + DigitalOcean

🤖 Generated with [Claude Code](https://claude.ai/code)

Co-Authored-By: Claude <noreply@anthropic.com>"
fi

echo ""
echo "🌐 接下來請執行以下步驟："
echo "1. 前往 https://github.com/new"
echo "2. 創建新倉庫，名稱：chicken-pos-system"
echo "3. 不要勾選 'Initialize with README'"
echo "4. 創建後，複製倉庫 URL"
echo "5. 回到終端機執行：./github-setup.sh [您的倉庫URL]"
echo ""
echo "範例："
echo "  ./github-setup.sh https://github.com/您的用戶名/chicken-pos-system.git"