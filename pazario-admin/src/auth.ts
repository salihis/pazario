const TOKEN_KEY = 'pazario.admin.token'
const USER_KEY = 'pazario.admin.user'

export interface AdminUser {
  id: string
  email: string
  name: string
  role: string
}

export function getAuthToken(): string | null {
  return localStorage.getItem(TOKEN_KEY)
}

export function getAdminUser(): AdminUser | null {
  const rawUser = localStorage.getItem(USER_KEY)
  return rawUser ? JSON.parse(rawUser) as AdminUser : null
}

export function saveSession(token: string, user: AdminUser): void {
  localStorage.setItem(TOKEN_KEY, token)
  localStorage.setItem(USER_KEY, JSON.stringify(user))
}

export function clearSession(): void {
  localStorage.removeItem(TOKEN_KEY)
  localStorage.removeItem(USER_KEY)
}

export function isAuthenticated(): boolean {
  return Boolean(getAuthToken())
}
