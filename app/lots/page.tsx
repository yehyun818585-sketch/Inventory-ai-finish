'use client'

import { useEffect, useState } from 'react'
import { supabase } from '@/lib/supabase'
import { useAuth } from '@/app/contexts/AuthContext'
import Navbar from '@/app/components/Navbar'

interface Product {
  id: string
  product_name: string
  product_code: string
  shelf_life_months: number | null
  track_expiry: boolean
}

interface Warehouse {
  id: string
  name: string
}

interface InventoryItem {
  id: string
  product_id: string
  warehouse_id: string
  quantity: number
  lot_number: string | null
  products: Product
  warehouses: Warehouse
}

interface LotGroup {
  lot_number: string | null
  manufacture_date: Date | null
  expiry_date: Date | null
  status: 'normal' | 'warning' | 'expired' | 'unknown'
  daysRemaining: number | null
  items: {
    id: string
    warehouse: Warehouse
    quantity: number
  }[]
  totalQuantity: number
}

// 제품 단위로 묶는 상위 그룹
interface ProductGroup {
  product: Product
  lots: LotGroup[]
  totalQuantity: number
  worstStatus: LotGroup['status'] // 가장 위험한 상태
}

// 로트번호에서 제조일자 추출 (YYMMDD-NN → Date)
function parseLotNumber(lotNumber: string | null): Date | null {
  if (!lotNumber || lotNumber.length < 6) return null

  const yy = parseInt(lotNumber.substring(0, 2))
  const mm = parseInt(lotNumber.substring(2, 4)) - 1 // 월은 0부터 시작
  const dd = parseInt(lotNumber.substring(4, 6))

  if (isNaN(yy) || isNaN(mm) || isNaN(dd)) return null

  const year = 2000 + yy
  return new Date(year, mm, dd)
}

// 상태 우선순위 (숫자가 낮을수록 위험)
const STATUS_ORDER = { expired: 0, warning: 1, normal: 2, unknown: 3 } as const

function getWorstStatus(lots: LotGroup[]): LotGroup['status'] {
  let worst: LotGroup['status'] = 'unknown'
  for (const lot of lots) {
    if (STATUS_ORDER[lot.status] < STATUS_ORDER[worst]) {
      worst = lot.status
    }
  }
  return worst
}

interface ReviewNeededLot {
  productName: string
  productCode: string
  lotNumber: string
  totalQuantity: number
  warehouses: { name: string; quantity: number }[]
  inventoryIds: string[]
}

export default function LotsPage() {
  const { profile } = useAuth()
  const [productGroups, setProductGroups] = useState<ProductGroup[]>([])
  const [reviewNeededLots, setReviewNeededLots] = useState<ReviewNeededLot[]>([])
  const [loading, setLoading] = useState(true)
  const [filter, setFilter] = useState<'all' | 'warning' | 'expired'>('all')
  const [expandedProducts, setExpandedProducts] = useState<Set<string>>(new Set())
  const [search, setSearch] = useState('')
  const [companyShelfLife, setCompanyShelfLife] = useState(24)
  const [companyWarningRatio, setCompanyWarningRatio] = useState(0.25)
  const [editingLot, setEditingLot] = useState<{ key: string; value: string } | null>(null)
  const [savingLot, setSavingLot] = useState(false)

  useEffect(() => {
    fetchData()
  }, [profile?.company_id]) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!profile?.company_id) return

    const channel = supabase
      .channel(`lots-realtime-${profile.company_id}`)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'inventory' }, () => fetchData())
      .on('postgres_changes', { event: '*', schema: 'public', table: 'products' }, () => fetchData())
      .subscribe()

    return () => { supabase.removeChannel(channel) }
  }, [profile?.company_id]) // eslint-disable-line react-hooks/exhaustive-deps

  function toggleProduct(productId: string) {
    setExpandedProducts(prev => {
      const next = new Set(prev)
      if (next.has(productId)) {
        next.delete(productId)
      } else {
        next.add(productId)
      }
      return next
    })
  }

  async function saveLotNumber(lot: ReviewNeededLot, newValue: string) {
    const trimmed = newValue.trim()
    if (!trimmed || trimmed === lot.lotNumber) { setEditingLot(null); return }
    setSavingLot(true)
    const { error } = await supabase
      .from('inventory')
      .update({ lot_number: trimmed })
      .in('id', lot.inventoryIds)
    setSavingLot(false)
    if (!error) {
      setEditingLot(null)
      fetchData()
    } else {
      console.error('로트번호 수정 실패:', error)
    }
  }

  async function fetchData() {
    if (!profile?.company_id) return
    setLoading(true)

    // 회사 설정 불러오기
    const { data: companyData } = await supabase
      .from('companies')
      .select('default_shelf_life_months, shelf_life_warning_ratio')
      .eq('id', profile.company_id)
      .single()
    const shelfLife = companyData?.default_shelf_life_months || 24
    const warningRatio = companyData?.shelf_life_warning_ratio || 0.25
    setCompanyShelfLife(shelfLife)
    setCompanyWarningRatio(warningRatio)

    const { data: inventoryData } = await supabase
      .from('inventory')
      .select(`
        *,
        products (*),
        warehouses (*)
      `)
      .eq('company_id', profile.company_id)

    if (!inventoryData) {
      setProductGroups([])
      setLoading(false)
      return
    }

    // 1단계: 제품+로트번호로 로트 그룹 생성
    const lotMap = new Map<string, LotGroup & { product: Product }>()

    inventoryData.forEach((item: InventoryItem) => {
      const key = `${item.product_id}_${item.lot_number || 'none'}`

      if (!lotMap.has(key)) {
        const shelfLifeMonths = item.products?.shelf_life_months || shelfLife
        let expiryDate: Date | null = null
        let status: LotGroup['status'] = 'unknown'
        let daysRemaining: number | null = null

        const mfgDate = parseLotNumber(item.lot_number)
        const trackExpiry = item.products?.track_expiry !== false

        if (mfgDate && trackExpiry) {
          expiryDate = new Date(mfgDate)
          expiryDate.setMonth(expiryDate.getMonth() + shelfLifeMonths)

          const today = new Date()
          const totalDays = shelfLifeMonths * 30
          const remainingMs = expiryDate.getTime() - today.getTime()
          daysRemaining = Math.ceil(remainingMs / (1000 * 60 * 60 * 24))

          const warningThresholdDays = totalDays * warningRatio

          if (item.lot_number?.startsWith('250')) {
          }

          if (daysRemaining <= 0) {
            status = 'expired'
          } else if (daysRemaining <= warningThresholdDays) {
            status = 'warning'
          } else {
            status = 'normal'
          }
        }

        lotMap.set(key, {
          product: item.products,
          lot_number: item.lot_number,
          manufacture_date: mfgDate,
          expiry_date: expiryDate,
          status,
          daysRemaining,
          items: [],
          totalQuantity: 0
        })
      }

      const group = lotMap.get(key)!
      group.items.push({
        id: item.id,
        warehouse: item.warehouses,
        quantity: item.quantity
      })
      group.totalQuantity += item.quantity
    })

    // 2단계: 제품 단위로 상위 그룹 생성
    const productMap = new Map<string, ProductGroup>()

    lotMap.forEach((lotWithProduct) => {
      const productId = lotWithProduct.product?.id
      if (!productId) return

      if (!productMap.has(productId)) {
        productMap.set(productId, {
          product: lotWithProduct.product,
          lots: [],
          totalQuantity: 0,
          worstStatus: 'unknown'
        })
      }

      const productGroup = productMap.get(productId)!
      const { product: _product, ...lotOnly } = lotWithProduct
      productGroup.lots.push(lotOnly)
      productGroup.totalQuantity += lotOnly.totalQuantity
    })

    // 각 제품 그룹 내 로트 정렬 (만료→임박→정상→미지정, 같은 상태면 남은 일수 오름차순)
    productMap.forEach((group) => {
      group.lots.sort((a, b) => {
        if (STATUS_ORDER[a.status] !== STATUS_ORDER[b.status]) {
          return STATUS_ORDER[a.status] - STATUS_ORDER[b.status]
        }
        if (a.daysRemaining !== null && b.daysRemaining !== null) {
          return a.daysRemaining - b.daysRemaining
        }
        return 0
      })
      group.worstStatus = getWorstStatus(group.lots)
    })

    // 제품 그룹 정렬 (위험한 제품이 위로)
    const sorted = Array.from(productMap.values()).sort((a, b) => {
      if (STATUS_ORDER[a.worstStatus] !== STATUS_ORDER[b.worstStatus]) {
        return STATUS_ORDER[a.worstStatus] - STATUS_ORDER[b.worstStatus]
      }
      return a.product.product_name.localeCompare(b.product.product_name)
    })

    setProductGroups(sorted)

    // 유통기한 확인 필요: track_expiry=true인데 lot_number가 YYMMDD 형식이 아닌 항목
    const reviewMap = new Map<string, ReviewNeededLot>()
    inventoryData.forEach((item: InventoryItem) => {
      const trackExpiry = item.products?.track_expiry !== false
      const lotNum = item.lot_number
      if (!trackExpiry || !lotNum) return
      if (parseLotNumber(lotNum) !== null) return // 정상 형식이면 제외

      const key = `${item.product_id}_${lotNum}`
      if (!reviewMap.has(key)) {
        reviewMap.set(key, {
          productName: item.products?.product_name || '',
          productCode: item.products?.product_code || '',
          lotNumber: lotNum,
          totalQuantity: 0,
          warehouses: [],
          inventoryIds: []
        })
      }
      const r = reviewMap.get(key)!
      r.totalQuantity += item.quantity
      r.warehouses.push({ name: item.warehouses?.name || '-', quantity: item.quantity })
      r.inventoryIds.push(item.id)
    })
    setReviewNeededLots(Array.from(reviewMap.values()))

    // 임박/만료 로트가 있는 제품은 기본 펼침
    const autoExpand = new Set<string>()
    sorted.forEach((group) => {
      if (group.worstStatus === 'expired' || group.worstStatus === 'warning') {
        autoExpand.add(group.product.id)
      }
    })
    setExpandedProducts(autoExpand)

    setLoading(false)
  }

  // 전체 로트 수 계산
  const totalLotCount = productGroups.reduce((sum, g) => sum + g.lots.length, 0)
  const warningCount = productGroups.reduce(
    (sum, g) => sum + g.lots.filter(l => l.status === 'warning').length, 0
  )
  const expiredCount = productGroups.reduce(
    (sum, g) => sum + g.lots.filter(l => l.status === 'expired').length, 0
  )

  // 필터 + 검색 적용
  const filteredGroups = productGroups
    .filter(group => {
      if (!search) return true
      return group.product.product_name.toLowerCase().includes(search.toLowerCase()) ||
        group.product.product_code.toLowerCase().includes(search.toLowerCase())
    })
    .map(group => {
      if (filter === 'all') return group
      const filteredLots = group.lots.filter(lot => {
        if (filter === 'warning') return lot.status === 'warning' || lot.status === 'expired'
        if (filter === 'expired') return lot.status === 'expired'
        return true
      })
      if (filteredLots.length === 0) return null
      return { ...group, lots: filteredLots }
    })
    .filter((g): g is ProductGroup => g !== null)

  function getStatusBadge(status: LotGroup['status']) {
    switch (status) {
      case 'expired':
        return <span className="px-2 py-0.5 bg-red-100 text-red-700 text-xs font-medium rounded-full">만료</span>
      case 'warning':
        return <span className="px-2 py-0.5 bg-yellow-100 text-yellow-700 text-xs font-medium rounded-full">임박</span>
      case 'normal':
        return <span className="px-2 py-0.5 bg-green-100 text-green-700 text-xs font-medium rounded-full">정상</span>
      default:
        return <span className="px-2 py-0.5 bg-gray-100 text-gray-500 text-xs font-medium rounded-full">미지정</span>
    }
  }

  function getProductStatusIndicator(status: LotGroup['status']) {
    switch (status) {
      case 'expired':
        return <span className="w-2.5 h-2.5 rounded-full bg-red-500 flex-shrink-0" />
      case 'warning':
        return <span className="w-2.5 h-2.5 rounded-full bg-yellow-500 flex-shrink-0" />
      case 'normal':
        return <span className="w-2.5 h-2.5 rounded-full bg-green-500 flex-shrink-0" />
      default:
        return <span className="w-2.5 h-2.5 rounded-full bg-gray-400 flex-shrink-0" />
    }
  }

  function formatDate(date: Date | null) {
    if (!date) return '-'
    return date.toLocaleDateString('ko-KR')
  }

  function formatDaysRemaining(days: number | null) {
    if (days === null) return '-'
    if (days <= 0) return '만료됨'
    if (days < 30) return `${days}일`
    const months = Math.floor(days / 30)
    return `약 ${months}개월`
  }

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <p className="text-xl">로딩 중...</p>
      </div>
    )
  }

  return (
    <>
      <Navbar />
      <div className="min-h-screen bg-slate-50 pt-28 md:pt-20 p-4 md:p-8">
      <div className="max-w-6xl mx-auto">
        {/* 헤더 */}
        <div className="mb-8">
          <h1 className="text-2xl font-bold text-gray-900">로트 관리</h1>
          <p className="text-gray-500 mt-1">제품별 로트 현황 및 유통기한 관리</p>
        </div>

        {/* 요약 카드 */}
        <div className="grid grid-cols-2 md:grid-cols-4 gap-2 mb-3">
          <div className="bg-white rounded-lg shadow p-2.5 md:p-4">
            <h3 className="text-xs font-semibold text-gray-400 uppercase tracking-wide mb-0.5">제품 수</h3>
            <p className="text-xl md:text-2xl font-bold text-gray-900">{productGroups.length}</p>
            <p className="text-xs text-gray-400">개</p>
          </div>
          <div className="bg-white rounded-lg shadow p-2.5 md:p-4">
            <h3 className="text-xs font-semibold text-gray-400 uppercase tracking-wide mb-0.5">총 로트 수</h3>
            <p className="text-xl md:text-2xl font-bold text-gray-900">{totalLotCount}</p>
            <p className="text-xs text-gray-400">개</p>
          </div>
          <div
            className={`bg-white rounded-lg shadow p-2.5 md:p-4 cursor-pointer transition hover:ring-2 hover:ring-yellow-400 ${
              filter === 'warning' ? 'ring-2 ring-yellow-400' : ''
            }`}
            onClick={() => setFilter(filter === 'warning' ? 'all' : 'warning')}
          >
            <h3 className="text-xs font-semibold text-yellow-500 uppercase tracking-wide mb-0.5">유통기한 임박</h3>
            <p className="text-xl md:text-2xl font-bold text-yellow-600">{warningCount}</p>
            <p className="text-xs text-gray-400">로트 주의 필요</p>
          </div>
          <div
            className={`bg-white rounded-lg shadow p-2.5 md:p-4 cursor-pointer transition hover:ring-2 hover:ring-red-400 ${
              filter === 'expired' ? 'ring-2 ring-red-400' : ''
            }`}
            onClick={() => setFilter(filter === 'expired' ? 'all' : 'expired')}
          >
            <h3 className="text-xs font-semibold text-red-400 uppercase tracking-wide mb-0.5">유통기한 만료</h3>
            <p className="text-xl md:text-2xl font-bold text-red-600">{expiredCount}</p>
            <p className="text-xs text-gray-400">만료 처리 필요</p>
          </div>
        </div>

        {/* 유통기한 확인 필요 섹션 */}
        {reviewNeededLots.length > 0 && (
          <div className="bg-orange-50 border border-orange-300 rounded-lg p-4 mb-4">
            <h2 className="text-sm font-semibold text-orange-800 mb-1">
              ⚠️ 유통기한 확인 필요 ({reviewNeededLots.length}건)
            </h2>
            <p className="text-xs text-orange-600 mb-3">
              유통기한 관리 대상이지만 로트번호가 YYMMDD 형식이 아니어서 자동 계산 불가 — 로트번호를 올바른 형식으로 수정하거나 직접 확인하세요.
            </p>
            <div className="space-y-2">
              {reviewNeededLots.map((r, i) => {
                const editKey = `${r.productCode}_${r.lotNumber}`
                const isEditing = editingLot?.key === editKey
                return (
                  <div key={i} className="bg-white border border-orange-200 rounded px-3 py-2.5">
                    <div className="flex items-center justify-between flex-wrap gap-2">
                      {/* 왼쪽: 제품명 + 로트번호 (보기/수정) */}
                      <div className="flex items-center gap-2 flex-wrap min-w-0">
                        <span className="font-medium text-sm text-gray-800">{r.productName}</span>
                        <span className="text-xs text-gray-400">{r.productCode}</span>
                        {isEditing ? (
                          <div className="flex items-center gap-1">
                            <input
                              autoFocus
                              value={editingLot!.value}
                              onChange={e => setEditingLot({ key: editKey, value: e.target.value })}
                              onKeyDown={e => {
                                if (e.key === 'Enter') saveLotNumber(r, editingLot!.value)
                                if (e.key === 'Escape') setEditingLot(null)
                              }}
                              placeholder="YYMMDD-NN"
                              className="font-mono text-xs border border-orange-300 rounded px-2 py-0.5 w-28 focus:outline-none focus:ring-2 focus:ring-orange-400"
                            />
                            <button
                              onClick={() => saveLotNumber(r, editingLot!.value)}
                              disabled={savingLot}
                              className="text-xs px-2 py-0.5 bg-orange-500 text-white rounded hover:bg-orange-600 transition disabled:opacity-50"
                            >
                              {savingLot ? '...' : '저장'}
                            </button>
                            <button
                              onClick={() => setEditingLot(null)}
                              className="text-xs px-2 py-0.5 bg-gray-100 text-gray-600 rounded hover:bg-gray-200 transition"
                            >
                              취소
                            </button>
                          </div>
                        ) : (
                          <span className="font-mono text-xs bg-orange-100 text-orange-700 px-1.5 py-0.5 rounded">{r.lotNumber}</span>
                        )}
                      </div>
                      {/* 오른쪽: 창고별 수량 + 수정 버튼 */}
                      <div className="flex items-center gap-1.5 flex-wrap shrink-0">
                        {r.warehouses.map((w, j) => (
                          <span key={j} className="text-xs text-gray-500 bg-gray-100 px-2 py-0.5 rounded">
                            {w.name} {w.quantity.toLocaleString()}개
                          </span>
                        ))}
                        <span className="text-xs font-bold text-gray-700">총 {r.totalQuantity.toLocaleString()}개</span>
                        {!isEditing && (
                          <button
                            onClick={() => setEditingLot({ key: editKey, value: r.lotNumber })}
                            className="text-xs px-2.5 py-1 bg-orange-100 text-orange-700 hover:bg-orange-200 rounded transition font-medium"
                          >
                            수정
                          </button>
                        )}
                      </div>
                    </div>
                  </div>
                )
              })}
            </div>
          </div>
        )}

        {/* 필터 탭 + 검색 */}
        <div className="bg-white rounded-lg shadow mb-6">
          <div className="p-4 border-b flex items-center gap-3 flex-wrap">
            <div className="flex gap-2">
              <button
                onClick={() => setFilter('all')}
                className={`px-4 py-2 rounded-lg text-sm font-medium transition ${
                  filter === 'all'
                    ? 'bg-blue-600 text-white'
                    : 'bg-gray-100 text-gray-600 hover:bg-gray-200'
                }`}
              >
                전체 ({totalLotCount})
              </button>
              <button
                onClick={() => setFilter('warning')}
                className={`px-4 py-2 rounded-lg text-sm font-medium transition ${
                  filter === 'warning'
                    ? 'bg-yellow-500 text-white'
                    : 'bg-gray-100 text-gray-600 hover:bg-gray-200'
                }`}
              >
                임박/만료 ({warningCount + expiredCount})
              </button>
              <button
                onClick={() => setFilter('expired')}
                className={`px-4 py-2 rounded-lg text-sm font-medium transition ${
                  filter === 'expired'
                    ? 'bg-red-600 text-white'
                    : 'bg-gray-100 text-gray-600 hover:bg-gray-200'
                }`}
              >
                만료 ({expiredCount})
              </button>
            </div>
            <input
              type="text"
              placeholder="제품명 검색..."
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="ml-auto border rounded-lg px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-blue-400 w-48"
            />
          </div>
        </div>

        {/* 제품별 로트 목록 */}
        <div className="space-y-3">
          {filteredGroups.length === 0 ? (
            <div className="bg-white rounded-lg shadow p-8">
              <p className="text-gray-500 text-center">
                {filter === 'all'
                  ? '등록된 재고가 없습니다.'
                  : '해당하는 로트가 없습니다.'}
              </p>
            </div>
          ) : (
            filteredGroups.map((group) => {
              const isExpanded = expandedProducts.has(group.product.id)

              return (
                <div key={group.product.id} className="bg-white rounded-lg shadow overflow-hidden">
                  {/* 제품 헤더 (클릭으로 펼침/접힘) */}
                  <button
                    onClick={() => toggleProduct(group.product.id)}
                    className="w-full px-3 py-2.5 flex items-center justify-between hover:bg-gray-50 transition"
                  >
                    <div className="flex items-center gap-2">
                      {getProductStatusIndicator(group.worstStatus)}
                      <span className={`text-xs transition-transform duration-200 ${isExpanded ? 'rotate-90' : ''}`}>▶</span>
                      <div className="text-left">
                        <h3 className="font-medium text-sm text-gray-900">{group.product.product_name}</h3>
                        <p className="text-xs text-gray-400">{group.product.product_code} · {group.lots.length}개 로트</p>
                      </div>
                    </div>
                    <span className="text-sm font-bold text-blue-600">
                      {group.totalQuantity.toLocaleString()}개
                    </span>
                  </button>

                  {/* 하위 로트 목록 */}
                  {isExpanded && (
                    <div className="border-t bg-gray-50">
                      {group.lots.map((lot, idx) => (
                        <div
                          key={`${lot.lot_number || 'none'}_${idx}`}
                          className={`px-3 py-2 border-b last:border-b-0 ${
                            lot.status === 'expired'
                              ? 'bg-red-50'
                              : lot.status === 'warning'
                              ? 'bg-yellow-50'
                              : 'bg-white'
                          }`}
                        >
                          <div className="flex items-center justify-between mb-1">
                            <div className="flex items-center gap-2">
                              {getStatusBadge(lot.status)}
                              <span className="font-mono font-medium text-xs text-gray-800">
                                {lot.lot_number || '(로트 미지정)'}
                              </span>
                            </div>
                            <span className="font-semibold text-xs text-gray-700">
                              {lot.totalQuantity.toLocaleString()}개
                            </span>
                          </div>

                          <div className="flex items-center gap-3 text-xs text-gray-500 flex-wrap">
                            <div>
                              <span>제조일:</span>
                              <span className="ml-1 text-gray-700">{formatDate(lot.manufacture_date)}</span>
                            </div>
                            <div>
                              <span>유통기한:</span>
                              <span className="ml-1 text-gray-700">{formatDate(lot.expiry_date)}</span>
                            </div>
                            <div>
                              <span>남은 기간:</span>
                              <span className={`ml-1 font-medium ${
                                lot.status === 'expired' ? 'text-red-600' :
                                lot.status === 'warning' ? 'text-yellow-600' : 'text-gray-700'
                              }`}>
                                {formatDaysRemaining(lot.daysRemaining)}
                              </span>
                            </div>
                          </div>

                          {/* 창고별 수량 */}
                          <div className="mt-1 flex gap-1.5 flex-wrap">
                            {lot.items.map((item, itemIdx) => (
                              <div
                                key={itemIdx}
                                className="bg-white border rounded px-2.5 py-1 text-xs"
                              >
                                <span className="text-gray-500">{item.warehouse?.name}</span>
                                <span className="ml-1.5 font-medium text-gray-700">{item.quantity.toLocaleString()}개</span>
                              </div>
                            ))}
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              )
            })
          )}
        </div>
      </div>
    </div>
    </>
  )
}
