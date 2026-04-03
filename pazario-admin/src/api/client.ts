// src/api/client.ts
import axios from 'axios'

export const api = axios.create({
  baseURL: 'http://localhost:3000/api',
  timeout: 30000,
  headers: { 'Content-Type': 'application/json' },
})

api.interceptors.response.use(
  res => res,
  err => {
    const status = err.response?.status
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