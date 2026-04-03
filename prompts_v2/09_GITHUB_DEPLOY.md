# Modül 9 — GitHub Pages Deploy & CI/CD

---

## PROMPT 9.1 — GitHub Actions Workflow

```
Aşağıdaki .github/workflows/deploy.yml dosyasını yaz.

### Gereksinimler
- main branch'e her push'ta otomatik deploy
- Manuel tetikleme (workflow_dispatch)
- GitHub Pages için gerekli izinler (pages: write, id-token: write)
- Build aşamasında: HTML doğrulama + build metadata enjeksiyonu
- Deploy aşamasında: GitHub Pages'e yükle, URL'yi output olarak bas

### İki Job
1. build:
   - ubuntu-latest
   - HTML dosyaları var mı kontrol et
   - Her dosyaya build date + commit SHA ekle (</body> öncesine HTML yorum)
   - actions/configure-pages@v4
   - actions/upload-pages-artifact@v3 ile artifact yükle

2. deploy:
   - needs: build
   - environment: github-pages
   - actions/deploy-pages@v4
   - output: page_url

### Concurrency
group: "pages"
cancel-in-progress: true  → aynı anda tek deploy

### Permissions
contents: read
pages: write
id-token: write
```

---

## PROMPT 9.2 — Lokal Geliştirme ve Deploy Rehberi

```
Aşağıdaki dökümanı yaz:

### README.md İçeriği

**Proje yapısı:**
pazario-site/
├── .github/workflows/deploy.yml
├── index.html           ← Landing page
├── urun-gonderim.html   ← Ürün gönderim ekranı  
├── admin.html           ← Admin panel demo
├── 404.html             ← Hata yönlendirme
└── README.md

**Kurulum (bir kerelik):**
1. GitHub'da public repo oluştur
2. Settings → Pages → Source: GitHub Actions
3. git clone + dosyaları ekle + push

**Deploy:**
git add . && git commit -m "..." && git push
→ Actions sekmesinde otomatik çalışır (~30 saniye)

**URL formatı:**
https://{username}.github.io/{repo-name}/
https://{username}.github.io/{repo-name}/urun-gonderim.html
https://{username}.github.io/{repo-name}/admin.html

**Özel domain (opsiyonel):**
- CNAME dosyası: demo.pazar.io
- DNS: CNAME demo → {username}.github.io
- Settings → Pages → Enforce HTTPS ✓

**Lokal test:**
npx serve .          # Node.js
python3 -m http.server 3000  # Python

**Sonraki adım (v2 — React SPA):**
- Vite + React'a geçiş
- npm run build → dist/ klasörünü deploy et
- Backend API: Railway veya Render.com (Node.js)
```
