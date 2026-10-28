// src/components/Layout.tsx
import { Outlet, NavLink, useLocation } from 'react-router-dom'

const navItems = [
  { to: '/dashboard', label: 'Dashboard' },
  { to: '/products', label: 'Urunler' },
  { to: '/orders', label: 'Siparisler' },
  { to: '/invoices', label: 'Faturalar' },
  { to: '/finance', label: 'Finans' },
  { to: '/price-engine', label: 'Fiyat Motoru' },
  { to: '/categories', label: 'Kategoriler' },
  { to: '/marketplaces', label: 'Pazaryerleri' },
  { to: '/marketplace-settings', label: 'Pazaryeri Ayarlari' },
  { to: '/operations', label: 'Operasyonlar' },
  { to: '/sources', label: 'XML Kaynaklar' },
  { to: '/local-xml-sync', label: 'Local XML Sync' },
]

export default function Layout() {
  const location = useLocation()
  const activePage = navItems.find(item => location.pathname.startsWith(item.to))?.label ?? 'Yonetim'

  return (
    <div className="flex h-screen bg-[#f6f1e5] text-[#163b3c]">
      <aside className="w-60 shrink-0 bg-[#0d3b3c] border-r border-[#315859] flex flex-col shadow-xl">
        <div className="p-5 border-b border-[#315859]">
          <div className="flex items-center gap-3">
            <div className="bg-[#f2b63f] text-[#173536] font-black rounded-xl w-10 h-10 flex items-center justify-center shadow-md">P</div>
            <div>
              <div className="font-bold text-base tracking-tight text-white">Pazar.io</div>
              <div className="text-xs text-[#e8c876]">Yonetim Merkezi</div>
            </div>
          </div>
        </div>
        <nav className="flex-1 p-3 space-y-1 overflow-y-auto">
          {navItems.map(item => (
            <NavLink
              key={item.to}
              to={item.to}
              className={({ isActive }) =>
                `block px-3 py-2.5 rounded-xl text-sm transition-all ${
                  isActive
                    ? 'bg-[#f2b63f] text-[#153638] font-semibold shadow-sm'
                    : 'text-[#d9e3dc] hover:bg-[#174b4c] hover:text-white'
                }`
              }
            >
              {item.label}
            </NavLink>
          ))}
        </nav>
        <div className="p-4 border-t border-[#315859]">
          <div className="flex items-center gap-2 text-xs text-[#d9e3dc]">
            <span className="w-2 h-2 rounded-full bg-[#9eb757] shadow-[0_0_0_3px_rgba(158,183,87,0.16)]" />
            Sistem cevrimici
          </div>
          <div className="text-[10px] text-[#7fa0a0] mt-2">Pazar.io v1.0.0</div>
        </div>
      </aside>

      <div className="flex-1 min-w-0 flex flex-col">
        <header className="h-16 shrink-0 bg-[#0d3b3c] border-b border-[#315859] px-6 flex items-center justify-between text-white">
          <div>
            <div className="text-[11px] uppercase tracking-[0.18em] text-[#e8c876]">Pazar.io Admin</div>
            <div className="font-semibold">{activePage}</div>
          </div>
          <div className="flex items-center gap-3">
            <div className="hidden sm:block text-right">
              <div className="text-sm">Sistem Yoneticisi</div>
              <div className="text-xs text-[#9bb5ae]">admin</div>
            </div>
            <div className="w-9 h-9 rounded-full border border-[#d9c47e] bg-[#173f40] text-[#f2b63f] flex items-center justify-center font-bold">A</div>
          </div>
        </header>
        <main className="flex-1 overflow-auto bg-transparent">
          <Outlet />
        </main>
      </div>
    </div>
  )
}
