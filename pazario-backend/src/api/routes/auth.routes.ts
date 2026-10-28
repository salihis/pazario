import { Router } from 'express'
import { z } from 'zod'
import { prisma } from '../../db'
import { requireAuth, type AuthRequest } from '../middleware/auth.middleware'
import { AuthService } from '../../services/AuthService'
import { logger } from '../../utils/logger'

const router = Router()
const authService = new AuthService(prisma)

const loginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
})

router.post('/auth/login', async (req, res) => {
  const parsed = loginSchema.safeParse(req.body)
  if (!parsed.success) {
    res.status(400).json({ error: 'Email and password are required' })
    return
  }

  try {
    const result = await authService.login(parsed.data.email, parsed.data.password)
    if (!result) {
      res.status(401).json({ error: 'Invalid email or password' })
      return
    }

    res.json(result)
  } catch (error) {
    logger.error({ err: error }, 'Admin login failed')
    res.status(500).json({ error: 'Login failed' })
  }
})

router.get('/auth/me', requireAuth, async (req: AuthRequest, res) => {
  if (!req.user) {
    res.status(401).json({ error: 'Authentication required' })
    return
  }

  try {
    const user = await prisma.user.findUnique({
      where: { id: req.user.id },
      select: {
        id: true,
        email: true,
        name: true,
        role: true,
      },
    })

    if (!user) {
      res.status(401).json({ error: 'Invalid or expired token' })
      return
    }

    res.json({ user })
  } catch (error) {
    logger.error({ err: error, userId: req.user.id }, 'Admin session lookup failed')
    res.status(500).json({ error: 'Session lookup failed' })
  }
})

export default router
