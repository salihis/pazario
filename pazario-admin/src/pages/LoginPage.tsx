import { FormEvent, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { api } from '../api/client'
import { saveSession } from '../auth'

export default function LoginPage() {
  const navigate = useNavigate()
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState('')
  const [isSubmitting, setSubmitting] = useState(false)

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setError('')
    setSubmitting(true)

    try {
      const response = await api.post('/auth/login', { email, password })
      saveSession(response.data.token, response.data.user)
      navigate('/dashboard', { replace: true })
    } catch {
      setError('E-posta veya sifre hatali')
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <main className="min-h-screen bg-gray-950 text-gray-100 flex items-center justify-center px-4">
      <form onSubmit={handleSubmit} className="w-full max-w-sm space-y-5">
        <div>
          <div className="inline-flex bg-orange-500 text-white font-bold rounded-lg px-2 py-1 text-sm mb-4">P</div>
          <h1 className="text-2xl font-semibold">Pazar.io Admin</h1>
          <p className="text-sm text-gray-400 mt-1">Yonetici hesabi ile giris yapin.</p>
        </div>

        {error && (
          <div className="rounded-md border border-red-700 bg-red-950 px-3 py-2 text-sm text-red-200">
            {error}
          </div>
        )}

        <label className="block">
          <span className="text-sm text-gray-300">E-posta</span>
          <input
            className="mt-1 w-full rounded-md border border-gray-700 bg-gray-900 px-3 py-2 text-sm outline-none focus:border-blue-500"
            type="email"
            autoComplete="username"
            value={email}
            onChange={event => setEmail(event.target.value)}
            required
          />
        </label>

        <label className="block">
          <span className="text-sm text-gray-300">Sifre</span>
          <input
            className="mt-1 w-full rounded-md border border-gray-700 bg-gray-900 px-3 py-2 text-sm outline-none focus:border-blue-500"
            type="password"
            autoComplete="current-password"
            value={password}
            onChange={event => setPassword(event.target.value)}
            required
          />
        </label>

        <button
          className="w-full rounded-md bg-blue-600 px-3 py-2 text-sm font-medium text-white hover:bg-blue-500 disabled:cursor-not-allowed disabled:opacity-60"
          type="submit"
          disabled={isSubmitting}
        >
          {isSubmitting ? 'Giris yapiliyor...' : 'Giris yap'}
        </button>
      </form>
    </main>
  )
}
