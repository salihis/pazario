// src/api/client.ts
import axios from 'axios'
import { clearSession, getAuthToken } from '../auth'

const apiBaseUrl = import.meta.env.VITE_API_BASE_URL || '/api'

export const api = axios.create({
  baseURL: apiBaseUrl,
  timeout: 30000,
  headers: { 'Content-Type': 'application/json' },
})

api.interceptors.request.use(config => {
  const token = getAuthToken()
  if (token) {
    config.headers.Authorization = `Bearer ${token}`
  }
  return config
})

api.interceptors.response.use(
  res => res,
  err => {
    const status = err.response?.status
    if (status === 401 && window.location.pathname !== '/login') {
      clearSession()
      window.location.assign('/login')
    }
    if (status === 429) {
      const retryAfter = err.response?.headers['retry-after']
      if (retryAfter) {
        return new Promise(resolve =>
          setTimeout(() => resolve(api.request(err.config)), parseInt(retryAfter) * 1000)
        )
      }
    }
    return Promise.reject(err)
  }
)
