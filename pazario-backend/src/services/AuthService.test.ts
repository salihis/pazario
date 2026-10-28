import bcrypt from 'bcrypt'
import jwt from 'jsonwebtoken'
import { describe, expect, it, vi } from 'vitest'
import { AuthService } from './AuthService'

vi.mock('../config/env', () => ({
  env: {
    JWT_PRIVATE_KEY: 'test-private-key',
    JWT_EXPIRES_IN: '1h',
  },
}))

vi.mock('jsonwebtoken', () => ({
  default: {
    sign: vi.fn().mockReturnValue('signed-test-token'),
  },
}))

describe('AuthService', () => {
  it('returns a JWT and user payload for valid credentials', async () => {
    const passwordHash = await bcrypt.hash('strong-password', 12)
    const prisma = {
      user: {
        findUnique: vi.fn().mockResolvedValue({
          id: '7bd0252e-5dc4-4969-a42a-ea85a3e1d3ee',
          email: 'admin@example.com',
          name: 'Admin',
          passwordHash,
          role: 'SUPER_ADMIN',
        }),
      },
    }

    const result = await new AuthService(prisma as never).login(' Admin@Example.com ', 'strong-password')

    expect(result).toEqual({
      token: 'signed-test-token',
      user: {
        id: '7bd0252e-5dc4-4969-a42a-ea85a3e1d3ee',
        email: 'admin@example.com',
        name: 'Admin',
        role: 'SUPER_ADMIN',
      },
    })
    expect(jwt.sign).toHaveBeenCalledWith(
      {
        id: '7bd0252e-5dc4-4969-a42a-ea85a3e1d3ee',
        email: 'admin@example.com',
        role: 'SUPER_ADMIN',
      },
      'test-private-key',
      {
        algorithm: 'RS256',
        expiresIn: '1h',
      },
    )
    expect(prisma.user.findUnique).toHaveBeenCalledWith({ where: { email: 'admin@example.com' } })
  })

  it('returns null for invalid credentials', async () => {
    const passwordHash = await bcrypt.hash('strong-password', 12)
    const prisma = {
      user: {
        findUnique: vi.fn().mockResolvedValue({
          id: '7bd0252e-5dc4-4969-a42a-ea85a3e1d3ee',
          email: 'admin@example.com',
          name: 'Admin',
          passwordHash,
          role: 'SUPER_ADMIN',
        }),
      },
    }

    const result = await new AuthService(prisma as never).login('admin@example.com', 'wrong-password')

    expect(result).toBeNull()
  })
})
