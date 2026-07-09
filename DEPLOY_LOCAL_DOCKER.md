# Pazario Docker VPS Deploy

Bu kurulum lokal Docker yapisini tek VPS uzerinde ayni mantikla calistirir.

## Sunucu Hazirligi

Ubuntu 22.04/24.04 bir VPS uzerinde:

```bash
sudo apt update
sudo apt install -y ca-certificates curl git
sudo install -m 0755 -d /etc/apt/keyrings
sudo curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
sudo chmod a+r /etc/apt/keyrings/docker.asc
echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/ubuntu $(. /etc/os-release && echo "$VERSION_CODENAME") stable" | sudo tee /etc/apt/sources.list.d/docker.list > /dev/null
sudo apt update
sudo apt install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
sudo usermod -aG docker $USER
```

Oturumu kapatip tekrar ac.

## Projeyi Yukleme

```bash
git clone <REPO_URL> /opt/pazario
cd /opt/pazario
cp .env.deploy.example .env.deploy
nano .env.deploy
```

`.env.deploy` icinde sifreleri ve pazaryeri API bilgilerini doldur.
`public.pem` dosyasi proje kokunde bulunmali; backend JWT dogrulama anahtarini bu dosyadan okur.

## Calistirma

```bash
docker compose -f docker-compose.deploy.yml --env-file .env.deploy up -d --build
docker compose -f docker-compose.deploy.yml --env-file .env.deploy ps
```

## Kontrol

```bash
curl http://localhost/health
curl http://localhost/api
docker compose -f docker-compose.deploy.yml --env-file .env.deploy logs -f backend
```

Tarayicida:

```text
http://SUNUCU_IP
```

## Domain

DNS panelinde:

```text
pazario.tr      A   SUNUCU_IP
www.pazario.tr  A   SUNUCU_IP
```

DNS oturduktan sonra `http://pazario.tr` admin paneli, `http://pazario.tr/api` backend API olarak calisir.

## SSL

Test ortaminda once HTTP ile dogrula. SSL icin en pratik yol Cloudflare proxy veya sunucuda Certbot eklemektir.
