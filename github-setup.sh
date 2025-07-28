#!/bin/bash

if [ -z "$1" ]; then
    echo "❌ 請提供 GitHub 倉庫 URL"
    echo "用法: ./github-setup.sh https://github.com/您的用戶名/chicken-pos-system.git"
    exit 1
fi

REPO_URL=$1

echo "🔗 設定 GitHub 遠端倉庫..."
echo "倉庫 URL: $REPO_URL"

# 檢查是否已有 origin
if git remote get-url origin &> /dev/null; then
    echo "🔄 更新現有的 origin..."
    git remote set-url origin $REPO_URL
else
    echo "➕ 添加新的 origin..."
    git remote add origin $REPO_URL
fi

echo "📤 推送到 GitHub..."
git branch -M main
git push -u origin main

if [ $? -eq 0 ]; then
    echo ""
    echo "🎉 成功推送到 GitHub!"
    echo "🌐 您的倉庫: $REPO_URL"
    echo ""
    echo "🚀 接下來選擇部署方案："
    echo "1. Vercel (推薦): ./deploy-vercel.sh"
    echo "2. Railway: ./deploy-railway.sh"
    echo "3. DigitalOcean: ./deploy-digitalocean.sh"
else
    echo "❌ 推送失敗，請檢查："
    echo "1. GitHub 倉庫 URL 是否正確"
    echo "2. 您是否有推送權限"
    echo "3. 網路連接是否正常"
fi