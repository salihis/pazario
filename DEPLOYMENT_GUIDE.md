# 🚀 PAZARIO - GitHub Actions & Deployment Guide

## GitHub Secrets Setup (Must Do First)

Go to: **Settings > Secrets and Variables > Actions**

### Add these secrets:

```
# Database
DATABASE_URL_PROD=postgresql://user:password@host:5432/pazario_prod
REDIS_URL_PROD=redis://:password@host:6379

# Security
JWT_SECRET=your-super-secret-jwt-key-min-32-characters-long-here
FIELD_ENCRYPTION_KEY=a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2

# Marketplace (Get from marketplace admin panels)
TY_API_KEY=your_trendyol_key
TY_API_SECRET=your_trendyol_secret
TY_SUPPLIER_ID=your_supplier_id
N11_APPKEY=your_n11_key
N11_APPSECRET=your_n11_secret
HB_MERCHANT_ID=your_hepsi_merchant_id
HB_SERVICE_KEY=your_hepsi_service_key
PZ_CLIENT_ID=your_pazarama_client_id
PZ_CLIENT_SECRET=your_pazarama_client_secret

# Cargo (Get from cargo companies)
ARAS_API_KEY=your_aras_key
YURTICI_API_KEY=your_yurtici_key
SURAT_API_KEY=your_surat_key
PTT_API_KEY=your_ptt_key

# AI
ANTHROPIC_API_KEY=sk-ant-your-key
GEMINI_API_KEY=your_gemini_key

# Deployment
DEPLOY_HOST=your.server.com
DEPLOY_USER=ubuntu
DEPLOY_SSH_KEY=base64-encoded-ssh-private-key
DEPLOY_PATH=/home/ubuntu/pazario

# Notifications
SLACK_WEBHOOK_URL=https://hooks.slack.com/services/YOUR/WEBHOOK/URL

# CORS
ALLOWED_ORIGINS=https://app.example.com,https://www.example.com
```

## Workflows

### 1. CI Workflow (`.github/workflows/ci.yml`)
**Triggered on:** `push` to main/develop, `pull_request` to main

**What it does:**
- ✅ Installs dependencies
- ✅ Type checking (TypeScript)
- ✅ Runs tests (Vitest)
- ✅ Builds backend
- ✅ Builds frontend

### 2. Deploy Backend Workflow (`.github/workflows/deploy-backend.yml`)
**Triggered on:** `push` to main (pazario-backend path)

**What it does:**
- ✅ Runs all tests
- ✅ Builds Docker image
- ✅ Deploys to production server
- ✅ Health check
- ✅ Slack notification

## Local Development

### Start services:
```bash
docker-compose up -d
```

### Run backend:
```bash
cd pazario-backend
npm run dev
```

### Run frontend:
```bash
cd pazario-admin
npm run dev
```

## Production Deployment

### Option 1: Using GitHub Actions (Automated)
```bash
git push origin main
# Workflow automatically triggers, builds, and deploys
```

### Option 2: Manual Deployment

1. **SSH to server:**
```bash
ssh -i deploy_key ubuntu@your.server.com
```

2. **Clone/Update repo:**
```bash
cd /home/ubuntu/pazario
git pull origin main
```

3. **Create .env file:**
```bash
cp .env.production.example .env.production
# Edit with actual values
nano .env.production
```

4. **Start services:**
```bash
docker-compose -f docker-compose.prod.yml up -d
```

5. **Check status:**
```bash
docker-compose -f docker-compose.prod.yml ps
docker-compose -f docker-compose.prod.yml logs -f backend
```

## Monitoring

### Health checks:
```bash
curl http://localhost:3000/health
```

### Logs:
```bash
docker-compose logs -f backend
docker-compose logs -f postgres
docker-compose logs -f redis
```

### Database backup:
```bash
docker exec pazario-postgres-prod \
  pg_dump -U pazario pazario_prod | \
  gzip > backup_$(date +%Y%m%d_%H%M%S).sql.gz
```

## Rollback

If deployment fails:
```bash
# Stop current version
docker-compose -f docker-compose.prod.yml down

# Checkout previous commit
git checkout HEAD~1

# Redeploy
docker-compose -f docker-compose.prod.yml up -d
```

## Environment Variables Reference

| Variable | Example | Required | Description |
|----------|---------|----------|-------------|
| DATABASE_URL | postgresql://... | Yes | Production database |
| REDIS_URL | redis://:pass@... | Yes | Redis connection |
| JWT_SECRET | min-32-chars | Yes | Token signing key |
| TY_API_KEY | abc123 | No | Trendyol API |
| ANTHROPIC_API_KEY | sk-ant-... | No | Claude API |
| ALLOWED_ORIGINS | https://app.com | Yes | CORS whitelist |
| SLACK_WEBHOOK_URL | https://hooks... | No | Error notifications |

## Troubleshooting

### Backend won't start
1. Check database connection: `curl http://localhost:3000/health`
2. Check logs: `docker-compose logs backend`
3. Verify DATABASE_URL env var

### Database connection refused
1. Verify postgres is running: `docker-compose ps`
2. Check DB_PASSWORD
3. Ensure database exists

### Port already in use
```bash
# Find process using port 3000
lsof -i :3000
kill -9 <PID>
```

## Scaling

For higher traffic:

1. **Add load balancer** (nginx/haproxy)
2. **Scale backend** (create multiple instances)
3. **Upgrade database** (connection pooling)
4. **Use CDN** for static assets
5. **Optimize queries** (database indexes)
