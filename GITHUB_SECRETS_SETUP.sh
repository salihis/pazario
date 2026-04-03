#!/bin/bash
# GitHub Secrets Setup Guide
# Kullanım: GitHub UI'de Settings > Secrets and Variables > Actions

# ═══════════════════════════════════════════════════════════════════
# DATABASE & CACHE SECRETS (Production)
# ═══════════════════════════════════════════════════════════════════

# DATABASE_URL_PROD - Production PostgreSQL
# Format: postgresql://user:password@host:5432/database
# Örnek: postgresql://pazario:securepassword@db.example.com:5432/pazario_prod

# REDIS_URL_PROD - Production Redis
# Format: redis://:password@host:6379
# Örnek: redis://:securepassword@cache.example.com:6379

# ═══════════════════════════════════════════════════════════════════
# AUTHENTICATION & SECURITY
# ═══════════════════════════════════════════════════════════════════

# JWT_SECRET - JWT signing key (min 32 chars)
# Örnek: your-super-secret-jwt-key-min-32-characters-long-here

# FIELD_ENCRYPTION_KEY - AES-256 encryption (32 bytes hex)
# Örnek: a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2

# ═══════════════════════════════════════════════════════════════════
# MARKETPLACE API CREDENTIALS
# ═══════════════════════════════════════════════════════════════════

# TRENDYOL API
# TY_API_KEY - Trendyol API Key
# TY_API_SECRET - Trendyol API Secret
# TY_SUPPLIER_ID - Trendyol Supplier/Distributor ID

# N11 API
# N11_APPKEY - N11 App Key
# N11_APPSECRET - N11 App Secret

# HEPSIBURADA API
# HB_MERCHANT_ID - Hepsiburada Merchant ID (UUID format)
# HB_SERVICE_KEY - Hepsiburada Service Key (12 chars)

# PAZARAMA API
# PZ_CLIENT_ID - Pazarama OAuth Client ID
# PZ_CLIENT_SECRET - Pazarama OAuth Client Secret

# ═══════════════════════════════════════════════════════════════════
# SHIPPING/CARGO API CREDENTIALS
# ═══════════════════════════════════════════════════════════════════

# ARAS_API_KEY - Aras Kargo API Key
# YURTICI_API_KEY - Yurtiçi Kargo API Key
# SURAT_API_KEY - Sürat Kargo API Key
# PTT_API_KEY - PTT Kargo API Key

# ═══════════════════════════════════════════════════════════════════
# AI/LLM CREDENTIALS
# ═══════════════════════════════════════════════════════════════════

# ANTHROPIC_API_KEY - Claude API Key (sk-ant-...)
# GEMINI_API_KEY - Google Gemini API Key (optional, for category mapping)

# ═══════════════════════════════════════════════════════════════════
# APPLICATION CONFIGURATION
# ═══════════════════════════════════════════════════════════════════

# ALLOWED_ORIGINS - CORS whitelist (comma-separated)
# Örnek: https://app.example.com,https://www.example.com

# SLACK_WEBHOOK_URL - Slack notifications for errors
# Format: https://hooks.slack.com/services/YOUR/WEBHOOK/URL

# LOG_LEVEL - Logging level (info, debug, warn, error)
# NODE_ENV - Environment (production, development, test)

# ═══════════════════════════════════════════════════════════════════
# DEPLOYMENT INFO
# ═══════════════════════════════════════════════════════════════════

# DEPLOY_HOST - Server SSH host
# DEPLOY_USER - SSH username
# DEPLOY_KEY - SSH private key (base64 encoded)
# DEPLOY_PATH - Deploy directory path

echo "GitHub Secrets Setup Guide Created"
