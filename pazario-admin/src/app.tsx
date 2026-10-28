// src/App.tsx
import { Routes, Route, Navigate } from 'react-router-dom'
import { ReactNode, useEffect, useState } from 'react'
import { clearSession, getAuthToken, saveSession } from './auth'
import { api } from './api/client'
import Layout from './components/layout'
import DashboardPage from './pages/DashboardPage'
import ProductsPage from './pages/ProductsPage'
import OrdersPage from './pages/OrdersPage'
import PriceEnginePage from './pages/PriceEnginePage'
import CategoryPage from './pages/CategoryPage'
import SourcesPage from './pages/SourcesPage'
import MarketplacesPage from './pages/MarketplacesPage'
import MarketplaceSettingsPage from './pages/MarketplaceSettingsPage'
import LocalXmlSyncPage from './pages/LocalXmlSyncPage'
import FinancePage from './pages/FinancePage'
import LoginPage from './pages/LoginPage'
import OperationsPage from './pages/OperationsPage'
import InvoicesPage from './pages/InvoicesPage'

function RequireAuth({ children }: { children: ReactNode }) {
  const [status, setStatus] = useState<'checking' | 'allowed' | 'denied'>('checking')

  useEffect(() => {
    const token = getAuthToken()
    if (!token) {
      setStatus('denied')
      return
    }

    api.get('/auth/me')
      .then(response => {
        saveSession(token, response.data.user)
        setStatus('allowed')
      })
      .catch(() => {
        clearSession()
        setStatus('denied')
      })
  }, [])

  if (status === 'checking') {
    return (
      <main className="min-h-screen bg-gray-950 text-gray-400 flex items-center justify-center">
        Oturum kontrol ediliyor...
      </main>
    )
  }

  return status === 'allowed' ? children : <Navigate to="/login" replace />
}

export default function App() {
  return (
    <Routes>
      <Route path="/login" element={<LoginPage />} />
      <Route path="/" element={<RequireAuth><Layout /></RequireAuth>}>
        <Route index element={<Navigate to="/dashboard" replace />} />
        <Route path="dashboard" element={<DashboardPage />} />
        <Route path="products" element={<ProductsPage />} />
        <Route path="orders" element={<OrdersPage />} />
        <Route path="invoices" element={<InvoicesPage />} />
        <Route path="price-engine" element={<PriceEnginePage />} />
        <Route path="finance" element={<FinancePage />} />
        <Route path="categories" element={<CategoryPage />} />
        <Route path="marketplaces" element={<MarketplacesPage />} />
        <Route path="marketplace-settings" element={<MarketplaceSettingsPage />} />
        <Route path="local-xml-sync" element={<LocalXmlSyncPage />} />
        <Route path="operations" element={<OperationsPage />} />
		<Route path="sources" element={<SourcesPage />} />
      </Route>
    </Routes>
  )
}
