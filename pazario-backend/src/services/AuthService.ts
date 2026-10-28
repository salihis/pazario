import { PrismaClient, UserRole } from '@prisma/client'
import bcrypt from 'bcrypt'
import jwt from 'jsonwebtoken'
import type { SignOptions } from 'jsonwebtoken'
import { env } from '../config/env'
import { logger } from '../utils/logger'

export interface LoginResult {
  token: string
  user: {
    id: string
    email: string
    name: string
    role: UserRole
  }
}

export class AuthService {
  constructor(private readonly prisma: PrismaClient) {}

  async login(email: string, password: string): Promise<LoginResult | null> {
    const normalizedEmail = email.trim().toLowerCase()
    logger.info({ email: normalizedEmail }, 'Admin login attempt')

    const user = await this.prisma.user.findUnique({
      where: { email: normalizedEmail },
    })

    if (!user) {
      logger.warn({ email: normalizedEmail }, 'Admin login failed: user not found')
      return null
    }

    const isPasswordValid = await bcrypt.compare(password, user.passwordHash)
    if (!isPasswordValid) {
      logger.warn({ userId: user.id, email: normalizedEmail }, 'Admin login failed: invalid password')
      return null
    }

    const signOptions: SignOptions = {
      algorithm: 'RS256',
      expiresIn: env.JWT_EXPIRES_IN as SignOptions['expiresIn'],
    }

    const token = jwt.sign(
      {
        id: user.id,
        email: user.email,
        role: user.role,
      },
      env.JWT_PRIVATE_KEY,
      signOptions,
    )

    logger.info({ userId: user.id, email: normalizedEmail }, 'Admin login succeeded')

    return {
      token,
      user: {
        id: user.id,
        email: user.email,
        name: user.name,
        role: user.role,
      },
    }
  }
}
