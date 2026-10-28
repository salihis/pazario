import { useMemo, useState } from 'react'

type AttributeValue = { id: string; name: string }

export type MarketplaceAttributeField = {
  attributeId: string
  attributeName: string
  attributeType: 'dropdown' | 'multi_select' | 'free_text' | 'number' | 'boolean' | 'color' | string
  isMandatory: boolean
  allowCustomValue: boolean
  values: AttributeValue[]
  currentValue: string | string[] | boolean | null
  validationError?: string | null
  systemManaged?: boolean
}

interface MarketplaceAttributeSectionsProps {
  marketplace: string
  attributes: MarketplaceAttributeField[]
  values: Record<string, string>
  onChange: (attributeId: string, value: string) => void
  emptyMessage?: string
  mandatoryOnly?: boolean
}

function normalizeText(value: string) {
  return value
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/\u0131/g, 'i')
    .toLowerCase()
}

function isManufacturerImporter(name: string) {
  const text = normalizeText(name)
  return [
    'uretici',
    'ureticisi',
    'birincil ithalatci',
    'ikincil ithalatci',
    'ucuncul ithalatci',
    'ithalatci',
  ].some(term => text.includes(term))
}

function isCoreTrendyolAttribute(name: string) {
  const text = normalizeText(name)
  return [
    'beden',
    'yas grubu',
    'cinsiyet',
    'web color',
    'renk',
    'kumas tipi',
    'dokuma tipi',
    'bel',
    'boy',
    'siluet',
    'cep',
    'kapama',
    'persona',
    'koleksiyon',
    'sezon',
    'yikama',
    'paket',
    'urun tipi',
    'urun detayi',
    'surdurulebilirlik',
    'mensei',
    'ek ozellik',
  ].some(term => text.includes(term))
}

function isColorAttribute(attr: MarketplaceAttributeField) {
  const text = normalizeText(attr.attributeName)
  return attr.attributeType === 'color' || text.includes('renk') || text.includes('web color')
}

function SearchableSelect({
  attr,
  value,
  options,
  onChange,
}: {
  attr: MarketplaceAttributeField
  value: string
  options: AttributeValue[]
  onChange: (attributeId: string, nextValue: string) => void
}) {
  const [query, setQuery] = useState('')
  const selectedOption = options.find(option => option.id === value || option.name === value)
  const normalizedQuery = normalizeText(query)
  const filteredOptions = useMemo(() => {
    const filtered = normalizedQuery
      ? options.filter(option => normalizeText(option.name).includes(normalizedQuery))
      : options
    const limited = filtered.slice(0, 250)
    if (selectedOption && !limited.some(option => option.id === selectedOption.id)) {
      return [selectedOption, ...limited]
    }
    return limited
  }, [normalizedQuery, options, selectedOption])
  const showSearch = options.length > 25

  return (
    <div className="space-y-2">
      {showSearch && (
        <div>
          <input
            value={query}
            onChange={e => setQuery(e.target.value)}
            placeholder={`${attr.attributeName} ara...`}
            className="w-full bg-gray-950 border border-gray-800 rounded-xl px-3 py-2 text-xs text-gray-100 placeholder-gray-500 focus:outline-none focus:border-blue-500"
          />
          <div className="mt-1 text-[11px] text-gray-500">
            {normalizedQuery
              ? `${filteredOptions.length} secenek gosteriliyor`
              : `${options.length} pazaryeri secenegi`}
          </div>
        </div>
      )}
      <select
        value={value}
        onChange={e => onChange(attr.attributeId, e.target.value)}
        className="w-full bg-gray-950 border border-gray-700 rounded-xl px-3 py-2.5 text-sm text-gray-100 focus:outline-none focus:border-blue-500"
      >
        <option value="">Seciniz</option>
        {filteredOptions.map(option => (
          <option key={option.id} value={option.id}>{option.name}</option>
        ))}
        {options.length === 0 && isColorAttribute(attr) && (
          <option value="" disabled>Renk secenegi bekleniyor</option>
        )}
      </select>
    </div>
  )
}

function getAttributeGroup(attributeName: string, isMandatory: boolean) {
  if (isManufacturerImporter(attributeName)) return 'Üretici / İthalatçı Bilgileri'
  if (isCoreTrendyolAttribute(attributeName)) return 'Temel Ürün Bilgileri'
  return isMandatory ? 'Zorunlu Alanlar' : 'Opsiyonel Alanlar'
}

function groupOrder(title: string) {
  switch (title) {
    case 'Zorunlu Alanlar':
      return 0
    case 'Temel Ürün Bilgileri':
      return 1
    case 'Üretici / İthalatçı Bilgileri':
      return 2
    case 'Opsiyonel Alanlar':
      return 3
    default:
      return 4
  }
}

function renderField(
  attr: MarketplaceAttributeField,
  value: string,
  onChange: (attributeId: string, nextValue: string) => void
) {
  if (attr.systemManaged) {
    return (
      <input
        value={value}
        readOnly
        aria-label={`${attr.attributeName} sistem tarafindan dolduruldu`}
        className="w-full cursor-not-allowed bg-gray-950/60 border border-gray-800 rounded-xl px-3 py-2.5 text-sm text-gray-300"
      />
    )
  }

  const hasMarketplaceValues = attr.values.length > 0
  const isSelectLike = attr.attributeType === 'dropdown'
    || attr.attributeType === 'multi_select'
    || attr.attributeType === 'color'
    || (isColorAttribute(attr) && hasMarketplaceValues)
  const canFallbackToText = isSelectLike && !hasMarketplaceValues && attr.allowCustomValue

  if (attr.attributeType === 'boolean') {
    return (
      <select
        value={value}
        onChange={e => onChange(attr.attributeId, e.target.value)}
        className="w-full bg-gray-950 border border-gray-700 rounded-xl px-3 py-2.5 text-sm text-gray-100 focus:outline-none focus:border-blue-500"
      >
        <option value="">Seciniz</option>
        <option value="true">Evet</option>
        <option value="false">Hayir</option>
      </select>
    )
  }

  if (attr.attributeType === 'number') {
    return (
      <input
        type="number"
        value={value}
        onChange={e => onChange(attr.attributeId, e.target.value)}
        placeholder={attr.isMandatory ? 'Zorunlu alan' : 'Opsiyonel'}
        className="w-full bg-gray-950 border border-gray-700 rounded-xl px-3 py-2.5 text-sm text-gray-100 placeholder-gray-500 focus:outline-none focus:border-blue-500"
      />
    )
  }

  if (isSelectLike && !canFallbackToText) {
    const baseOptions = attr.values.length > 0 ? attr.values : []
    const options = value && !baseOptions.some(option => option.id === value || option.name === value)
      ? [{ id: value, name: value }, ...baseOptions]
      : baseOptions
    return (
      <SearchableSelect attr={attr} value={value} options={options} onChange={onChange} />
    )
  }

  if (canFallbackToText) {
    return (
      <input
        value={value}
        onChange={e => onChange(attr.attributeId, e.target.value)}
        placeholder={attr.isMandatory ? `${attr.attributeName} girin` : 'Opsiyonel'}
        className="w-full bg-gray-950 border border-gray-700 rounded-xl px-3 py-2.5 text-sm text-gray-100 placeholder-gray-500 focus:outline-none focus:border-blue-500"
      />
    )
  }

  return (
    <input
      value={value}
      onChange={e => onChange(attr.attributeId, e.target.value)}
      placeholder={attr.isMandatory ? 'Zorunlu alan' : 'Opsiyonel'}
      className="w-full bg-gray-950 border border-gray-700 rounded-xl px-3 py-2.5 text-sm text-gray-100 placeholder-gray-500 focus:outline-none focus:border-blue-500"
    />
  )
}

export default function MarketplaceAttributeSections({
  marketplace,
  attributes,
  values,
  onChange,
  emptyMessage = 'Bu kategori icin ozellik bulunamadi.',
  mandatoryOnly = false,
}: MarketplaceAttributeSectionsProps) {
  const visibleAttributes = mandatoryOnly ? attributes.filter(attr => attr.isMandatory) : attributes

  if (!visibleAttributes.length) {
    return (
      <div className="rounded-2xl border border-gray-800 bg-gray-950/70 px-4 py-5 text-sm text-gray-500">
        {mandatoryOnly ? 'Bu kategori icin zorunlu ozellik bulunamadi.' : emptyMessage}
      </div>
    )
  }

  const ordered = visibleAttributes
    .slice()
    .sort((a, b) => Number(b.isMandatory) - Number(a.isMandatory) || a.attributeName.localeCompare(b.attributeName, 'tr'))

  const sections = ordered.reduce<Record<string, MarketplaceAttributeField[]>>((acc, attr) => {
    const section = marketplace === 'TRENDYOL'
      ? getAttributeGroup(attr.attributeName, attr.isMandatory)
      : (attr.isMandatory ? 'Zorunlu Alanlar' : 'Opsiyonel Alanlar')
    acc[section] = [...(acc[section] ?? []), attr]
    return acc
  }, {})

  const sectionEntries = Object.entries(sections).sort((a, b) => groupOrder(a[0]) - groupOrder(b[0]))

  return (
    <div className="space-y-4">
      {sectionEntries.map(([title, fields]) => (
        <section key={title} className="rounded-2xl border border-gray-800 bg-gray-950/70 overflow-hidden">
          <div className="flex items-center justify-between gap-3 px-4 py-3 border-b border-gray-800">
            <div className="min-w-0">
              <div className="text-sm font-semibold text-gray-100">{title}</div>
              <div className="text-xs text-gray-500 mt-0.5">
                {title === 'Zorunlu Alanlar'
                  ? 'Bu alanlar gonderim ve onay icin gereklidir.'
                  : title === 'Temel Ürün Bilgileri'
                    ? 'Beden, renk, cinsiyet, yas grubu ve benzeri alanlar.'
                    : title === 'Üretici / İthalatçı Bilgileri'
                      ? 'Uretici ve ithalatci bilgilerinin eksiksiz tutulmasi beklenir.'
                      : 'Ek alanlar ihtiyaca gore doldurulabilir.'}
              </div>
            </div>
            <span className="flex-shrink-0 rounded-full border border-gray-700 bg-gray-900 px-2.5 py-1 text-[11px] font-medium text-gray-300">
              {fields.length}
            </span>
          </div>

          <div className="grid grid-cols-1 lg:grid-cols-2 gap-3 p-4">
            {fields.map(attr => {
              const current = values[attr.attributeId] ?? ''
              return (
                <div key={attr.attributeId} className="rounded-2xl border border-gray-800 bg-gray-900/80 p-3 shadow-sm shadow-black/10">
                  <div className="flex items-start justify-between gap-3 mb-2">
                    <label className="text-sm font-medium text-gray-200 leading-tight">
                      {attr.attributeName}
                      {attr.isMandatory && <span className="ml-1 text-red-400">*</span>}
                    </label>
                    <span className={`shrink-0 rounded-full px-2 py-0.5 text-[11px] ${attr.isMandatory ? 'bg-red-900/40 text-red-200' : 'bg-gray-800 text-gray-300'}`}>
                      {attr.systemManaged ? 'otomatik' : attr.attributeType}
                    </span>
                  </div>
                  {renderField(attr, current, onChange)}
                  {attr.validationError && (
                    <div className="mt-2 text-xs text-red-300">{attr.validationError}</div>
                  )}
                </div>
              )
            })}
          </div>
        </section>
      ))}
    </div>
  )
}
