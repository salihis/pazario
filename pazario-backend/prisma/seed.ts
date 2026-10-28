// prisma/seed.ts

import { PrismaClient, CargoCompany, Marketplace } from '@prisma/client'
import bcrypt from 'bcrypt'
import pino from 'pino'

const prisma = new PrismaClient()
const logger = pino({ level: 'info' })
const adminEmail = process.env.ADMIN_EMAIL || process.env.ADMIN_USERNAME
const adminName = process.env.ADMIN_NAME || 'Super Admin'
const adminPassword = process.env.ADMIN_PASSWORD

async function main() {
  logger.info('Seed başlatılıyor...')

  // ─── 1. Global Minimum Fiyat ─────────────────────────────────────────────
  try {
    await prisma.globalPriceSetting.upsert({
      where: { id: '00000000-0000-0000-0000-000000000001' },
      update: {},
      create: {
        id: '00000000-0000-0000-0000-000000000001',
        minPrice: 50.00,
        currency: 'TRY',
        updatedBy: 'seed',
      },
    })
    logger.info('GlobalPriceSetting oluşturuldu')
  } catch (e) {
    logger.error({ err: e }, 'GlobalPriceSetting hatası')
  }

  // ─── 2. Kargo Firma — Pazaryeri Eşleştirmeleri (4×4 = 16 satır) ──────────
  const cargoMappings = [
    // Aras Kargo
    { cargoCompany: CargoCompany.ARAS,    marketplace: Marketplace.TRENDYOL,    marketplaceCargoCode: 'ARAS',       marketplaceCargoName: 'Aras Kargo' },
    { cargoCompany: CargoCompany.ARAS,    marketplace: Marketplace.HEPSIBURADA, marketplaceCargoCode: 'ArasKargo',  marketplaceCargoName: 'Aras Kargo' },
    { cargoCompany: CargoCompany.ARAS,    marketplace: Marketplace.N11,         marketplaceCargoCode: '10',         marketplaceCargoName: 'Aras Kargo' },
    { cargoCompany: CargoCompany.ARAS,    marketplace: Marketplace.PAZARAMA,    marketplaceCargoCode: 'ARAS',       marketplaceCargoName: 'Aras Kargo' },
    // Yurtiçi Kargo
    { cargoCompany: CargoCompany.YURTICI, marketplace: Marketplace.TRENDYOL,    marketplaceCargoCode: 'YURTICI',      marketplaceCargoName: 'Yurtiçi Kargo' },
    { cargoCompany: CargoCompany.YURTICI, marketplace: Marketplace.HEPSIBURADA, marketplaceCargoCode: 'YurticiKargo', marketplaceCargoName: 'Yurtiçi Kargo' },
    { cargoCompany: CargoCompany.YURTICI, marketplace: Marketplace.N11,         marketplaceCargoCode: '12',           marketplaceCargoName: 'Yurtiçi Kargo' },
    { cargoCompany: CargoCompany.YURTICI, marketplace: Marketplace.PAZARAMA,    marketplaceCargoCode: 'YK',           marketplaceCargoName: 'Yurtiçi Kargo' },
    // Sürat Kargo
    { cargoCompany: CargoCompany.SURAT,   marketplace: Marketplace.TRENDYOL,    marketplaceCargoCode: 'SURAT',      marketplaceCargoName: 'Sürat Kargo' },
    { cargoCompany: CargoCompany.SURAT,   marketplace: Marketplace.HEPSIBURADA, marketplaceCargoCode: 'SuratKargo', marketplaceCargoName: 'Sürat Kargo' },
    { cargoCompany: CargoCompany.SURAT,   marketplace: Marketplace.N11,         marketplaceCargoCode: '6',          marketplaceCargoName: 'Sürat Kargo' },
    { cargoCompany: CargoCompany.SURAT,   marketplace: Marketplace.PAZARAMA,    marketplaceCargoCode: 'SURAT',      marketplaceCargoName: 'Sürat Kargo' },
    // PTT Kargo
    { cargoCompany: CargoCompany.PTT,     marketplace: Marketplace.TRENDYOL,    marketplaceCargoCode: 'PTT',      marketplaceCargoName: 'PTT Kargo' },
    { cargoCompany: CargoCompany.PTT,     marketplace: Marketplace.HEPSIBURADA, marketplaceCargoCode: 'PttKargo', marketplaceCargoName: 'PTT Kargo' },
    { cargoCompany: CargoCompany.PTT,     marketplace: Marketplace.N11,         marketplaceCargoCode: '8',        marketplaceCargoName: 'PTT Kargo' },
    { cargoCompany: CargoCompany.PTT,     marketplace: Marketplace.PAZARAMA,    marketplaceCargoCode: 'PTT',      marketplaceCargoName: 'PTT Kargo' },
  ]

  try {
    for (const mapping of cargoMappings) {
      await prisma.cargoCompanyMapping.upsert({
        where: {
          cargoCompany_marketplace: {
            cargoCompany: mapping.cargoCompany,
            marketplace: mapping.marketplace,
          },
        },
        update: {},
        create: mapping,
      })
    }
    logger.info('CargoCompanyMappings oluşturuldu (16 satır)')
  } catch (e) {
    logger.error({ err: e }, 'CargoCompanyMappings hatası')
  }

  // ─── 3. Super Admin Kullanıcı ─────────────────────────────────────────────
  try {
    if (!adminEmail || !adminPassword) {
      throw new Error('ADMIN_EMAIL/ADMIN_USERNAME ve ADMIN_PASSWORD zorunlu')
    }

    const normalizedAdminEmail = adminEmail.toLowerCase()
    const passwordHash = await bcrypt.hash(adminPassword, 12)
    await prisma.user.upsert({
      where: { email: normalizedAdminEmail },
      update: {},
      create: {
        email: normalizedAdminEmail,
        name: adminName,
        passwordHash,
        role: 'SUPER_ADMIN',
      },
    })
    logger.info('Super Admin kullanıcı oluşturuldu')
  } catch (e) {
    logger.error({ err: e }, 'User hatası')
  }

  // ─── 4. Örnek XML Kaynağı ─────────────────────────────────────────────────
  try {
    await prisma.xmlSource.upsert({
      where: { id: '00000000-0000-0000-0000-000000000002' },
      update: {},
      create: {
        id: '00000000-0000-0000-0000-000000000002',
        name: 'Tedarikçi A (Örnek)',
        url: 'https://example.com/feed.xml',
        fetchTimeoutSec: 60,
        active: false, // gerçek URL ile aktifleştirilmeli
      },
    })
    logger.info('Örnek XmlSource oluşturuldu')
  } catch (e) {
    logger.error({ err: e }, 'XmlSource hatası')
  }

  // ─── 5. Test Ürünleri ─────────────────────────────────────────────────────
  try {
    const source = await prisma.xmlSource.findFirst()
    if (source) {
      const testProducts = [
        { externalId: 'TEST001', sku: 'SKU-001', title: 'Test Urun 1 - Telefon Kilifi', brand: 'TestMarka',    price: 129.99, stock: 50 },
        { externalId: 'TEST002', sku: 'SKU-002', title: 'Test Urun 2 - Sarj Kablosu',   brand: 'TestMarka',    price: 89.90,  stock: 100 },
        { externalId: 'TEST003', sku: 'SKU-003', title: 'Test Urun 3 - Powerbank',       brand: 'ElektroMarka', price: 459.00, stock: 0 },
      ]
      for (const p of testProducts) {
        await prisma.product.upsert({
          where: { sourceId_externalId: { sourceId: source.id, externalId: p.externalId } },
          update: {},
          create: {
            sourceId: source.id,
            externalId: p.externalId,
            sku: p.sku,
            title: p.title,
            brand: p.brand,
            price: p.price,
            stock: p.stock,
            currency: 'TRY',
            images: [],
            attributes: {},
            contentHash: p.externalId,
          },
        })
      }
      logger.info('Test ürünleri eklendi (3 adet)')
    }
  } catch (e) {
    logger.error({ err: e }, 'Test ürün hatası')
  }

  logger.info('Seed tamamlandı')
}

main()
  .catch((e) => {
    logger.error({ err: e }, 'Seed başarısız')
    process.exit(1)
  })
  .finally(async () => {
    await prisma.$disconnect()
  })
