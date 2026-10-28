import { PrismaClient } from '@prisma/client'
import bcrypt from 'bcrypt'
import pino from 'pino'

const prisma = new PrismaClient()
const logger = pino({ level: process.env.LOG_LEVEL || 'info' })

const adminEmail = process.env.ADMIN_EMAIL || process.env.ADMIN_USERNAME
const adminName = process.env.ADMIN_NAME || adminEmail
const adminPassword = process.env.ADMIN_PASSWORD

async function main() {
  if (!adminEmail || !adminPassword || !adminName) {
    throw new Error('ADMIN_EMAIL/ADMIN_USERNAME, ADMIN_NAME ve ADMIN_PASSWORD zorunlu')
  }

  const existingAdmin = await prisma.user.findFirst({
    where: {
      role: {
        in: ['SUPER_ADMIN', 'ADMIN'],
      },
    },
  })

  if (existingAdmin) {
    throw new Error(`Aktif admin zaten var: ${existingAdmin.email}`)
  }

  const normalizedEmail = adminEmail.trim().toLowerCase()
  const passwordHash = await bcrypt.hash(adminPassword, 12)

  const admin = await prisma.user.create({
    data: {
      email: normalizedEmail,
      name: adminName.trim(),
      passwordHash,
      role: 'SUPER_ADMIN',
    },
  })

  logger.info({ userId: admin.id, email: admin.email }, 'Ilk admin kullanicisi olusturuldu')
}

main()
  .catch(error => {
    logger.error({ err: error }, 'Ilk admin kullanicisi olusturulamadi')
    process.exit(1)
  })
  .finally(async () => {
    await prisma.$disconnect()
  })
