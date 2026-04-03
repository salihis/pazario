// src/App.tsx
import { Routes, Route, Navigate } from 'react-router-dom'
import Layout from './components/layout'
import DashboardPage from './pages/DashboardPage'
import ProductsPage from './pages/ProductsPage'
import OrdersPage from './pages/OrdersPage'
import PriceEnginePage from './pages/PriceEnginePage'
import CategoryPage from './pages/CategoryPage'
import SourcesPage from './pages/SourcesPage'

export default function App() {
  return (
    <Routes>
      <Route path="/" element={<Layout />}>
        <Route index element={<Navigate to="/dashboard" replace />} />
        <Route path="dashboard" element={<DashboardPage />} />
        <Route path="products" element={<ProductsPage />} />
        <Route path="orders" element={<OrdersPage />} />
        <Route path="price-engine" element={<PriceEnginePage />} />
        <Route path="categories" element={<CategoryPage />} />
		<Route path="sources" element={<SourcesPage />} />
      </Route>
    </Routes>
  )
}