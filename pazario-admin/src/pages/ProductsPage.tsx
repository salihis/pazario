import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { api } from '../api/client'

interface Product {
  id: string
  sku: string
  title: string
  brand: string | null
  categoryRaw: string | null
  price: number
  stock: number
  images: string[]
  updatedAt: string
}

interface ProductsResponse {
  data: Product[]
  meta: { total: number; page: number; limit: number }
}

const MARKETPLACES = ['TRENDYOL', 'HEPSIBURADA', 'N11', 'PAZARAMA']

export default function ProductsPage() {
  const [page, setPage] = useState(1)
  const [search, setSearch] = useState('')
  const [searchInput, setSearchInput] = useState('')
  const limit = 25

  const { data, isLoading } = useQuery<ProductsResponse>({
    queryKey: ['products', page, search],
    queryFn: () =>
      api.get('/products', {
        params: { page, limit, search: search || undefined },
      }).then(r => r.data),
  })

  const totalPages = data ? Math.ceil(data.meta.total / limit) : 1

  const handleSearch = () => setSearch(searchInput)

  return (
    <div className="p-6">
      {/* Header */}
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-bold">Urunler</h1>
          <p className="text-gray-400 text-sm mt-1">
            {data?.meta.total ?? 0} urun
          </p>
        </div>
      </div>

      {/* Filter Bar */}
      <div className="flex gap-3 mb-4">
        <input
          type="text"
          placeholder="SKU, urun adi ara..."
          value={searchInput}
          onChange={e => setSearchInput(e.target.value)}
          onKeyDown={e => e.key === 'Enter' && handleSearch()}
          className="flex-1 bg-gray-900 border border-gray-700 rounded-lg px-4 py-2 text-sm text-gray-100 placeholder-gray-500 focus:outline-none focus:border-blue-500"
        />
        <button
          onClick={handleSearch}
          className="bg-blue-600 hover:bg-blue-700 text-white px-4 py-2 rounded-lg text-sm font-medium transition-colors"
        >
          Ara
        </button>
        {search && (
          <button
            onClick={() => { setSearch(''); setSearchInput('') }}
            className="bg-gray-700 hover:bg-gray-600 text-white px-4 py-2 rounded-lg text-sm transition-colors"
          >
            Temizle
          </button>
        )}
      </div>

      {/* Table */}
      <div className="bg-gray-900 rounded-xl border border-gray-800 overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-gray-800 text-gray-400 text-xs uppercase">
                <th className="text-left px-4 py-3">Gorsel</th>
                <th className="text-left px-4 py-3">Urun</th>
                <th className="text-left px-4 py-3">SKU</th>
                <th className="text-left px-4 py-3">Marka</th>
                <th className="text-right px-4 py-3">Fiyat</th>
                <th className="text-right px-4 py-3">Stok</th>
                <th className="text-left px-4 py-3">Pazaryerleri</th>
              </tr>
            </thead>
            <tbody>
              {isLoading ? (
                <tr>
                  <td colSpan={7} className="text-center py-12 text-gray-500">
                    Yukleniyor...
                  </td>
                </tr>
              ) : data?.data.length === 0 ? (
                <tr>
                  <td colSpan={7} className="text-center py-12 text-gray-500">
                    Urun bulunamadi
                  </td>
                </tr>
              ) : (
                data?.data.map(product => (
                  <tr
                    key={product.id}
                    className="border-b border-gray-800/50 hover:bg-gray-800/30 transition-colors"
                  >
                    {/* Gorsel */}
                    <td className="px-4 py-3">
                      {product.images[0] ? (
                        <img
                          src={product.images[0]}
                          alt={product.title}
                          className="w-10 h-10 object-cover rounded-lg bg-gray-800"
                          onError={e => { (e.target as HTMLImageElement).style.display = 'none' }}
                        />
                      ) : (
                        <div className="w-10 h-10 bg-gray-800 rounded-lg flex items-center justify-center text-gray-600 text-xs">
                          YOK
                        </div>
                      )}
                    </td>

                    {/* Urun Adi */}
                    <td className="px-4 py-3">
                      <div className="font-medium text-gray-100 line-clamp-1 max-w-xs">
                        {product.title}
                      </div>
                      {product.categoryRaw && (
                        <div className="text-xs text-gray-500 mt-0.5 line-clamp-1">
                          {product.categoryRaw}
                        </div>
                      )}
                    </td>

                    {/* SKU */}
                    <td className="px-4 py-3">
                      <span className="font-mono text-xs text-gray-400 bg-gray-800 px-2 py-1 rounded">
                        {product.sku}
                      </span>
                    </td>

                    {/* Marka */}
                    <td className="px-4 py-3 text-gray-400 text-xs">
                      {product.brand ?? '-'}
                    </td>

                    {/* Fiyat */}
                    <td className="px-4 py-3 text-right">
                      <span className="font-medium text-green-400">
                        {Number(product.price).toLocaleString('tr-TR', {
                          minimumFractionDigits: 2,
                          maximumFractionDigits: 2,
                        })} TL
                      </span>
                    </td>

                    {/* Stok */}
                    <td className="px-4 py-3 text-right">
                      <span className={`font-medium ${product.stock === 0 ? 'text-red-400' : 'text-gray-300'}`}>
                        {product.stock}
                      </span>
                    </td>

                    {/* Pazaryerleri */}
                    <td className="px-4 py-3">
                      <div className="flex gap-1">
                        {MARKETPLACES.map(mp => (
                          <span
                            key={mp}
                            className="text-xs px-1.5 py-0.5 rounded bg-gray-800 text-gray-500"
                            title={mp}
                          >
                            {mp.slice(0, 2)}
                          </span>
                        ))}
                      </div>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>

        {/* Pagination */}
        {data && data.meta.total > limit && (
          <div className="flex items-center justify-between px-4 py-3 border-t border-gray-800">
            <span className="text-xs text-gray-500">
              {(page - 1) * limit + 1} - {Math.min(page * limit, data.meta.total)} / {data.meta.total}
            </span>
            <div className="flex gap-2">
              <button
                onClick={() => setPage(p => Math.max(1, p - 1))}
                disabled={page === 1}
                className="px-3 py-1 rounded bg-gray-800 text-gray-400 text-xs disabled:opacity-40 hover:bg-gray-700 transition-colors"
              >
                Onceki
              </button>
              <span className="px-3 py-1 text-xs text-gray-400">
                {page} / {totalPages}
              </span>
              <button
                onClick={() => setPage(p => Math.min(totalPages, p + 1))}
                disabled={page === totalPages}
                className="px-3 py-1 rounded bg-gray-800 text-gray-400 text-xs disabled:opacity-40 hover:bg-gray-700 transition-colors"
              >
                Sonraki
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}