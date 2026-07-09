// src/components/Layout.tsx
import { Outlet, NavLink } from 'react-router-dom'

const navItems = [
  { to: '/dashboard', label: 'Dashboard' },
  { to: '/products', label: 'Urunler' },
  { to: '/orders', label: 'Siparisler' },
  { to: '/finance', label: 'Finans' },
  { to: '/price-engine', label: 'Fiyat Motoru' },
  { to: '/categories', label: 'Kategoriler' },
  { to: '/marketplaces', label: 'Pazaryerleri' },
  { to: '/sources', label: 'XML Kaynaklar' },
]

export default function Layout() {
  return (
    <div className="flex h-screen bg-gray-950 text-gray-100">
      <aside className="w-56 bg-gray-900 border-r border-gray-800 flex flex-col">
        <div className="p-4 border-b border-gray-800">
          <div className="flex items-center gap-2">
            <div className="bg-orange-500 text-white font-bold rounded-lg px-2 py-1 text-sm">P</div>
            <div>
              <div className="font-bold text-sm">Pazar.io</div>
              <div className="text-xs text-gray-400">Admin Panel</div>
            </div>
          </div>
        </div>
        <nav className="flex-1 p-3 space-y-1">
          {navItems.map(item => (
            <NavLink
              key={item.to}
              to={item.to}
              className={({ isActive }) =>
                `block px-3 py-2 rounded-lg text-sm transition-colors ${
                  isActive
                    ? 'bg-blue-600 text-white'
                    : 'text-gray-400 hover:bg-gray-800 hover:text-gray-100'
                }`
              }
            >
              {item.label}
            </NavLink>
          ))}
        </nav>
        <div className="p-3 border-t border-gray-800">
          <div className="text-xs text-gray-500">v1.0.0</div>
        </div>
      </aside>

      <main className="flex-1 overflow-auto">
        <Outlet />
      </main>
    </div>
  )
}
