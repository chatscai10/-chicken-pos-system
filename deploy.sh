#!/bin/bash

echo "🚀 雞排店POS系統 - 一鍵部署腳本"
echo "================================"
echo ""
echo "請選擇部署方案："
echo "1. Railway (推薦 - 最簡單，包含資料庫)"
echo "2. Vercel (適合前端 + 外部資料庫)"
echo "3. 只準備 GitHub 倉庫"
echo ""
read -p "請輸入選項 (1-3): " choice

case $choice in
    1)
        echo ""
        echo "🚂 您選擇了 Railway 部署"
        echo "==============================="
        echo "✅ 優勢："
        echo "  - 自動提供 PostgreSQL 資料庫"
        echo "  - 一鍵部署，無需額外配置"
        echo "  - 月費約 $5 USD"
        echo "  - 支援自動擴容"
        echo ""
        echo "📋 準備步驟："
        echo "1. 初始化 Git 倉庫"
        echo "2. 推送到 GitHub"
        echo "3. 部署到 Railway"
        echo "4. 測試功能"
        echo ""
        read -p "按 Enter 開始，或 Ctrl+C 取消..."
        
        # 執行 GitHub 準備
        echo "🔧 步驟 1: 準備 Git 倉庫..."
        chmod +x github-init.sh
        ./github-init.sh
        
        echo ""
        echo "🌐 請在新視窗完成以下操作："
        echo "1. 前往 https://github.com/new"
        echo "2. 建立倉庫名稱: chicken-pos-system"
        echo "3. 設為 Public"
        echo "4. 不要勾選任何初始化選項"
        echo "5. 點擊 'Create repository'"
        echo ""
        read -p "完成後，請貼上您的倉庫 URL: " repo_url
        
        # 執行 GitHub 設定
        chmod +x github-setup.sh
        ./github-setup.sh "$repo_url"
        
        if [ $? -eq 0 ]; then
            echo ""
            echo "🚂 步驟 2: 部署到 Railway..."
            chmod +x deploy-railway.sh
            ./deploy-railway.sh
        fi
        ;;
    2)
        echo ""
        echo "⚡ 您選擇了 Vercel 部署"
        echo "========================"
        echo "⚠️  注意："
        echo "  - Vercel 適合前端應用"
        echo "  - 需要外部 PostgreSQL 資料庫"
        echo "  - 推薦搭配 Supabase 或 PlanetScale"
        echo ""
        read -p "按 Enter 繼續，或 Ctrl+C 取消..."
        
        # 執行 Vercel 流程
        chmod +x github-init.sh
        ./github-init.sh
        
        echo ""
        read -p "請貼上您的 GitHub 倉庫 URL: " repo_url
        chmod +x github-setup.sh
        ./github-setup.sh "$repo_url"
        
        if [ $? -eq 0 ]; then
            chmod +x deploy-vercel.sh
            ./deploy-vercel.sh
        fi
        ;;
    3)
        echo ""
        echo "📦 準備 GitHub 倉庫"
        echo "==================="
        chmod +x github-init.sh
        ./github-init.sh
        
        echo ""
        read -p "請貼上您的 GitHub 倉庫 URL: " repo_url
        chmod +x github-setup.sh
        ./github-setup.sh "$repo_url"
        
        echo ""
        echo "✅ GitHub 倉庫準備完成！"
        echo "🚀 後續可執行："
        echo "  - Railway 部署: ./deploy-railway.sh"
        echo "  - Vercel 部署: ./deploy-vercel.sh"
        ;;
    *)
        echo "❌ 無效選項"
        exit 1
        ;;
esac

echo ""
echo "🎉 部署流程執行完成！"
echo ""
echo "📋 後續步驟："
echo "1. 等待部署完成 (約 3-5 分鐘)"
echo "2. 測試部署結果: ./test-deployment.sh [您的網址]"
echo "3. 在雲端面板設定環境變數"
echo "4. 執行資料庫初始化"
echo ""
echo "🆘 如果遇到問題："
echo "- 檢查 GitHub 倉庫是否正確推送"
echo "- 檢查雲端服務的建置日誌"
echo "- 確認環境變數設定正確"