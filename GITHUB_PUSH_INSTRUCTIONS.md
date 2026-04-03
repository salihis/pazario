# GitHub Push Instructions

## Step 1: Create Repository
1. Go to https://github.com/new
2. **Repository name:** `pazario`
3. **Description:** "XML to Marketplace Integration Platform"
4. **Visibility:** Public (GitHub Actions is free for public repos)
5. **Initialize with:** NONE (keep empty)
6. Click **Create repository**

## Step 2: Push to GitHub

Replace `YOUR_USERNAME` with your GitHub username:

```bash
# Add remote
git remote add origin https://github.com/YOUR_USERNAME/pazario.git

# Rename branch to main
git branch -M main

# Push
git push -u origin main
```

## Alternative: If you already pushed to master
```bash
# If remote already exists:
git remote remove origin
git remote add origin https://github.com/YOUR_USERNAME/pazario.git
git branch -M main
git push -u origin main
```

## Using SSH (if you have SSH keys configured)
```bash
git remote add origin git@github.com:YOUR_USERNAME/pazario.git
git branch -M main
git push -u origin main
```

## Step 3: After Push Succeeds
1. Go to https://github.com/YOUR_USERNAME/pazario
2. Check that all 122 files are there
3. GitHub Actions should auto-detect `.github/workflows/ci.yml`
4. Wait 2-3 minutes for first test run

## Step 4: Setup GitHub Secrets
1. Go to repo **Settings** → **Secrets and variables** → **Actions**
2. Click **New repository secret**
3. Add secrets from `GITHUB_SECRETS_SETUP.sh`:
   - DATABASE_URL_PROD
   - REDIS_URL_PROD
   - JWT_SECRET
   - ... (14 more)

## Verify CI/CD
- Go to **Actions** tab
- Should see "CI" workflow running
- Wait for green checkmark ✅

---

**Once push is complete, tell me and we'll proceed to local production deployment.**
