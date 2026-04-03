# GitHub Secrets Configuration Guide

## Overview
Bu rehber, Pazar.io projesinin CI/CD pipeline'ında kullanan GitHub Secrets'i nasıl ayarlayacağını açıklar.

## GitHub Repository Settings → Secrets and variables → Actions

### 1. Database Secrets

```
TEST_DATABASE_URL = "postgresql://pazario:password@localhost:5432/pazario_test"
```

### 2. Redis Secrets

```
TEST_REDIS_URL = "redis://localhost:6379"
```

### 3. Deployment Secrets (Production)

SSH ile deploy etmek için:

```
DEPLOY_KEY = [SSH Private Key Content - copy full content of ~/.ssh/id_rsa]
DEPLOY_HOST = "your-production-server.com"
DEPLOY_USER = "deploy"
DEPLOY_PATH = "/var/www/pazario-backend"
```

### 4. Notification Secrets

```
SLACK_WEBHOOK_URL = "https://hooks.slack.com/services/YOUR/WEBHOOK/URL"
```

### 5. API Credentials (Production)

Bu secrets'ler CI/CD pipeline tarafından kullanılmıyor (production .env'de var),
ama deployment stage'de reference edilebilir:

```
TRENDYOL_API_KEY = "..."
HB_MERCHANT_ID = "..."
N11_APPKEY = "..."
PAZARAMA_CLIENT_ID = "..."
ANTHROPIC_API_KEY = "..."
```

## Adım Adım Setup

### 1. SSH Key Generation (for deployment)

```bash
# Server üzerinde (if not already done)
ssh-keygen -t rsa -b 4096 -f ~/.ssh/deploy -N ""

# Public key'i authorized_keys'e ekle
cat ~/.ssh/deploy.pub >> ~/.ssh/authorized_keys

# Private key'i GitHub secret'e kopyala
cat ~/.ssh/deploy
```

### 2. Repository Settings

Go to: `Settings → Secrets and variables → Actions → New repository secret`

Şu secrets'leri ekle:

| Secret Name | Value |
|-------------|-------|
| `DEPLOY_KEY` | SSH Private Key (full content) |
| `DEPLOY_HOST` | Your production IP/domain |
| `DEPLOY_USER` | SSH username (usually `deploy`) |
| `DEPLOY_PATH` | Path to app folder (e.g., `/app/pazario`) |
| `SLACK_WEBHOOK_URL` | Slack incoming webhook URL |
| `TEST_DATABASE_URL` | Test PostgreSQL connection string |
| `TEST_REDIS_URL` | Test Redis URL |

### 3. Slack Webhook Setup

1. Go to: https://api.slack.com/apps
2. Create New App → From scratch
3. Name: "Pazar.io CI/CD"
4. Select your workspace
5. Go to "Incoming Webhooks" → Activate
6. Click "Add New Webhook to Workspace"
7. Select channel (e.g., #deployments)
8. Copy Webhook URL
9. Add to GitHub Secrets as `SLACK_WEBHOOK_URL`

### 4. Test Secrets

Run a workflow manually to test:

```bash
git push origin main
# Go to Actions tab and monitor
```

## Workflow Stages

### Stage 1: Test ✓
- PostgreSQL health check
- Redis health check
- npm install
- TypeScript type checking
- Linting
- Database migration
- Unit tests

### Stage 2: Build ✓
- Docker image build
- Push to container registry (GHCR)
- Cache management

### Stage 3: Security Scan
- Trivy vulnerability scan
- npm audit

### Stage 4: Deploy (only on main)
- SSH to production server
- Pull latest code
- Run `docker-compose.prod.yml up`

## Example: Manual Deployment

If auto-deploy fails:

```bash
# SSH into production server
ssh deploy@your-production-server.com

# Navigate to project
cd /var/www/pazario-backend

# Pull latest changes
git pull origin main

# Deploy with env file
docker-compose -f docker-compose.prod.yml --env-file .env.production up --build -d

# Check status
docker-compose -f docker-compose.prod.yml ps
```

## Troubleshooting

### Issue: "Permission denied (publickey)"

**Solution:**
```bash
# Verify SSH key setup on server
ssh -i ~/.ssh/deploy deploy@your-server "echo 'SSH works!'"

# If fails, regenerate and add to authorized_keys again
```

### Issue: "Database connection failed"

**Solution:**
```bash
# Check TEST_DATABASE_URL secret format
# Should be: postgresql://USER:PASSWORD@localhost:5432/DB_NAME

# Or run tests locally first
cd pazario-backend
npm run test
```

### Issue: Docker image build fails

**Solution:**
```bash
# Check Dockerfile syntax
docker build -f Dockerfile -t pazario:test .

# If fails locally, fix Dockerfile before pushing
```

## Security Best Practices

1. ✅ Never commit secrets to git
2. ✅ Use GitHub Secrets, not `.env` files
3. ✅ Rotate SSH keys periodically
4. ✅ Use separate secrets for dev/staging/prod
5. ✅ Review Secret access in "Security → Secrets accessed by workflow"
6. ✅ Limit SSH key permissions: `chmod 600 ~/.ssh/id_rsa`
7. ✅ Use branch protection rules (require passing checks before merge)

## Enable Branch Protection

Settings → Branches → Add rule

- Branch name pattern: `main`
- ✓ Require a pull request before merging
- ✓ Require status checks to pass before merging:
  - `test`
  - `build`
  - `security`
- ✓ Require code reviews before merge
- ✓ Dismiss stale PR approvals when new commits are pushed

## References

- [GitHub Secrets Documentation](https://docs.github.com/en/actions/security-guides/encrypted-secrets)
- [Docker GitHub Action](https://github.com/docker/build-push-action)
- [Trivy Security Scanner](https://aquasecurity.github.io/trivy/)
