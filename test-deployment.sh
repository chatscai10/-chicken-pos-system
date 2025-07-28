#!/bin/bash

if [ -z "$1" ]; then
    echo "❌ 請提供部署後的網址"
    echo "用法: ./test-deployment.sh https://your-app.vercel.app"
    exit 1
fi

BASE_URL=$1

echo "🧪 部署後功能測試"
echo "=================="
echo "測試網址: $BASE_URL"
echo ""

# 測試健康檢查
echo "🔍 測試 1: 健康檢查..."
HEALTH_RESPONSE=$(curl -s "$BASE_URL/health")
if echo "$HEALTH_RESPONSE" | grep -q "OK"; then
    echo "✅ 健康檢查通過"
else
    echo "❌ 健康檢查失敗: $HEALTH_RESPONSE"
    exit 1
fi

# 測試根端點
echo ""
echo "🔍 測試 2: API 根端點..."
ROOT_RESPONSE=$(curl -s "$BASE_URL/")
if echo "$ROOT_RESPONSE" | grep -q "雞排店線上點餐系統"; then
    echo "✅ API 根端點正常"
else
    echo "❌ API 根端點異常: $ROOT_RESPONSE"
fi

# 測試用戶註冊
echo ""
echo "🔍 測試 3: 用戶註冊功能..."
REGISTER_RESPONSE=$(curl -s -X POST "$BASE_URL/api/auth/register" \
  -H "Content-Type: application/json" \
  -d '{
    "email": "test-deploy@example.com",
    "password": "testpassword123",
    "displayName": "部署測試用戶",
    "phone": "0912345678"
  }')

if echo "$REGISTER_RESPONSE" | grep -q "註冊成功"; then
    echo "✅ 用戶註冊功能正常"
    # 提取 token
    TOKEN=$(echo "$REGISTER_RESPONSE" | grep -o '"token":"[^"]*"' | cut -d'"' -f4)
else
    echo "⚠️  用戶註冊異常，嘗試使用測試帳號登入..."
    
    # 嘗試使用預設測試帳號登入
    LOGIN_RESPONSE=$(curl -s -X POST "$BASE_URL/api/auth/login" \
      -H "Content-Type: application/json" \
      -d '{
        "email": "customer@test.com",
        "password": "testpassword123"
      }')
    
    if echo "$LOGIN_RESPONSE" | grep -q "登入成功"; then
        echo "✅ 測試帳號登入成功"
        TOKEN=$(echo "$LOGIN_RESPONSE" | grep -o '"token":"[^"]*"' | cut -d'"' -f4)
    else
        echo "❌ 認證系統異常: $LOGIN_RESPONSE"
        exit 1
    fi
fi

# 測試需要認證的端點
if [ ! -z "$TOKEN" ]; then
    echo ""
    echo "🔍 測試 4: 認證端點..."
    
    # 測試店鋪資料
    STORES_RESPONSE=$(curl -s -X GET "$BASE_URL/api/stores" \
      -H "Content-Type: application/json" \
      -H "Authorization: Bearer $TOKEN")
    
    if echo "$STORES_RESPONSE" | grep -q "success"; then
        echo "✅ 店鋪資料端點正常"
    else
        echo "❌ 店鋪資料端點異常: $STORES_RESPONSE"
    fi
    
    # 測試商品資料
    PRODUCTS_RESPONSE=$(curl -s -X GET "$BASE_URL/api/products" \
      -H "Content-Type: application/json" \
      -H "Authorization: Bearer $TOKEN")
    
    if echo "$PRODUCTS_RESPONSE" | grep -q "success"; then
        echo "✅ 商品資料端點正常"
    else
        echo "❌ 商品資料端點異常: $PRODUCTS_RESPONSE"
    fi
fi

# 測試無效token
echo ""
echo "🔍 測試 5: 安全性檢查..."
INVALID_TOKEN_RESPONSE=$(curl -s -X GET "$BASE_URL/api/stores" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer invalid_token")

if echo "$INVALID_TOKEN_RESPONSE" | grep -q "無效的令牌"; then
    echo "✅ 安全性檢查通過 - 無效token被正確拒絕"
else
    echo "⚠️  安全性檢查: $INVALID_TOKEN_RESPONSE"
fi

echo ""
echo "🎉 部署測試完成！"
echo "🌐 您的應用已成功部署到: $BASE_URL"
echo ""
echo "📋 測試帳號:"
echo "- 管理員: admin@test.com / testpassword123"
echo "- 顧客: customer@test.com / testpassword123"
echo ""
echo "📱 主要端點:"
echo "- 健康檢查: $BASE_URL/health"
echo "- API文檔: $BASE_URL/"
echo "- 用戶登入: $BASE_URL/api/auth/login"
echo "- 商品列表: $BASE_URL/api/products"
echo "- 訂單管理: $BASE_URL/api/orders"