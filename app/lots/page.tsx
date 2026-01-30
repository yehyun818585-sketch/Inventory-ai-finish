'use client'

import { useEffect, useState } from 'react'
import { supabase } from '@/lib/supabase'
import Link from 'next/link'

interface Product {
  id: string
  product_name: string
  product_code: string
  shelf_life_months: number | null
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
  product: Product
  lot_number: string | null
  manufacture_date: Date | null
  expiry_date: Date | null
  status: 'normal' | 'warning' | 'expired' | 'unknown'
  daysRemaining: number | null
  items: {
    warehouse: Warehouse
    quantity: number
  }[]
  totalQuantity: number
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

// AI를 통해 비소모품 분류 (API 호출)
async function classifyNonPerishableProducts(productNames: string[]): Promise<Set<string>> {
  if (productNames.length === 0) return new Set()

  try {
    const response = await fetch('/api/classify-products', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ productNames })
    })

    if (response.ok) {
      const data = await response.json()
      return new Set(data.nonPerishable || [])
    }
  } catch (error) {
    console.error('제품 분류 API 에러:', error)
  }

  return new Set()
}

export default function LotsPage() {
  const [lots, setLots] = useState<LotGroup[]>([])
  const [loading, setLoading] = useState(true)
  const [filter, setFilter] = useState<'all' | 'warning' | 'expired'>('all')

  useEffect(() => {
    fetchData()
  }, [])

  async function fetchData() {
    setLoading(true)

    const { data: inventoryData } = await supabase
      .from('inventory')
      .select(`
        *,
        products (*),
        warehouses (*)
      `)

    if (!inventoryData) {
      setLots([])
      setLoading(false)
      return
    }

    // AI로 비소모품 분류 (한 번만 호출)
    const uniqueProductNames = [...new Set(
      inventoryData.map((item: InventoryItem) => item.products?.product_name).filter(Boolean)
    )] as string[]
    const nonPerishableSet = await classifyNonPerishableProducts(uniqueProductNames)

    // 제품 + 로트번호로 그룹화
    const groupMap = new Map<string, LotGroup>()

    inventoryData.forEach((item: InventoryItem) => {
      const key = `${item.product_id}_${item.lot_number || 'none'}`

      if (!groupMap.has(key)) {
        const shelfLifeMonths = item.products?.shelf_life_months || 24
        let expiryDate: Date | null = null
        let status: LotGroup['status'] = 'unknown'
        let daysRemaining: number | null = null

        const mfgDate = parseLotNumber(item.lot_number)

        // AI가 분류한 비소모품은 유통기한 계산 안함
        const productName = item.products?.product_name || ''
        const isNonPerishableProduct = nonPerishableSet.has(productName)

        if (mfgDate && !isNonPerishableProduct) {
          expiryDate = new Date(mfgDate)
          expiryDate.setMonth(expiryDate.getMonth() + shelfLifeMonths)

          const today = new Date()
          const totalDays = shelfLifeMonths * 30 // 대략적인 총 일수
          const remainingMs = expiryDate.getTime() - today.getTime()
          daysRemaining = Math.ceil(remainingMs / (1000 * 60 * 60 * 24))

          // 25% 임계값 계산
          const warningThresholdDays = totalDays * 0.25

          if (daysRemaining <= 0) {
            status = 'expired'
          } else if (daysRemaining <= warningThresholdDays) {
            status = 'warning'
          } else {
            status = 'normal'
          }
        }

        groupMap.set(key, {
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

      const group = groupMap.get(key)!
      group.items.push({
        warehouse: item.warehouses,
        quantity: item.quantity
      })
      group.totalQuantity += item.quantity
    })

    // 배열로 변환 후 정렬 (임박/만료 순으로)
    let sortedLots = Array.from(groupMap.values()).sort((a, b) => {
      // 만료 > 임박 > 정상 > 미지정 순
      const statusOrder = { expired: 0, warning: 1, normal: 2, unknown: 3 }
      if (statusOrder[a.status] !== statusOrder[b.status]) {
        return statusOrder[a.status] - statusOrder[b.status]
      }
      // 같은 상태면 남은 일수 오름차순
      if (a.daysRemaining !== null && b.daysRemaining !== null) {
        return a.daysRemaining - b.daysRemaining
      }
      return 0
    })

    setLots(sortedLots)
    setLoading(false)
  }

  const filteredLots = lots.filter(lot => {
    if (filter === 'all') return true
    if (filter === 'warning') return lot.status === 'warning' || lot.status === 'expired'
    if (filter === 'expired') return lot.status === 'expired'
    return true
  })

  const warningCount = lots.filter(l => l.status === 'warning').length
  const expiredCount = lots.filter(l => l.status === 'expired').length

  function getStatusBadge(status: LotGroup['status']) {
    switch (status) {
      case 'expired':
        return <span className="px-2 py-1 bg-red-100 text-red-700 text-xs font-medium rounded-full">만료</span>
      case 'warning':
        return <span className="px-2 py-1 bg-yellow-100 text-yellow-700 text-xs font-medium rounded-full">임박</span>
      case 'normal':
        return <span className="px-2 py-1 bg-green-100 text-green-700 text-xs font-medium rounded-full">정상</span>
      default:
        return <span className="px-2 py-1 bg-gray-100 text-gray-500 text-xs font-medium rounded-full">미지정</span>
    }
  }

  function formatDate(dateStr: string | null) {
    if (!dateStr) return '-'
    return new Date(dateStr).toLocaleDateString('ko-KR')
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
    <div className="min-h-screen bg-gray-50 p-8">
      <div className="max-w-6xl mx-auto">
        {/* 헤더 */}
        <div className="mb-8">
          <Link href="/" className="text-blue-600 hover:underline mb-2 inline-block">
            ← 대시보드로
          </Link>
          <h1 className="text-3xl font-bold text-gray-900">로트 관리</h1>
          <p className="text-gray-600 mt-1">제조일자별 재고 현황 및 유통기한 관리</p>
        </div>

        {/* 요약 카드 */}
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4 mb-8">
          <div className="bg-white rounded-lg shadow p-6">
            <h3 className="text-sm font-medium text-gray-500">총 로트 수</h3>
            <p className="text-3xl font-bold text-gray-900 mt-2">{lots.length}개</p>
          </div>
          <div
            className={`bg-white rounded-lg shadow p-6 cursor-pointer transition hover:ring-2 hover:ring-yellow-400 ${
              filter === 'warning' ? 'ring-2 ring-yellow-400' : ''
            }`}
            onClick={() => setFilter(filter === 'warning' ? 'all' : 'warning')}
          >
            <h3 className="text-sm font-medium text-yellow-600">유통기한 임박</h3>
            <p className="text-3xl font-bold text-yellow-600 mt-2">{warningCount}개</p>
            <p className="text-xs text-gray-400 mt-1">유통기한 25% 이하</p>
          </div>
          <div
            className={`bg-white rounded-lg shadow p-6 cursor-pointer transition hover:ring-2 hover:ring-red-400 ${
              filter === 'expired' ? 'ring-2 ring-red-400' : ''
            }`}
            onClick={() => setFilter(filter === 'expired' ? 'all' : 'expired')}
          >
            <h3 className="text-sm font-medium text-red-600">유통기한 만료</h3>
            <p className="text-3xl font-bold text-red-600 mt-2">{expiredCount}개</p>
          </div>
        </div>

        {/* 필터 탭 */}
        <div className="bg-white rounded-lg shadow mb-6">
          <div className="p-4 border-b flex gap-2">
            <button
              onClick={() => setFilter('all')}
              className={`px-4 py-2 rounded-lg text-sm font-medium transition ${
                filter === 'all'
                  ? 'bg-blue-600 text-white'
                  : 'bg-gray-100 text-gray-600 hover:bg-gray-200'
              }`}
            >
              전체 ({lots.length})
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
        </div>

        {/* 로트 목록 */}
        <div className="bg-white rounded-lg shadow">
          <div className="p-6 border-b">
            <h2 className="text-xl font-semibold">
              로트 현황 ({filteredLots.length}건)
            </h2>
          </div>
          <div className="p-6">
            {filteredLots.length === 0 ? (
              <p className="text-gray-500 text-center py-8">
                {filter === 'all'
                  ? '등록된 재고가 없습니다.'
                  : '해당하는 로트가 없습니다.'}
              </p>
            ) : (
              <div className="space-y-4">
                {filteredLots.map((lot, idx) => (
                  <div
                    key={`${lot.product?.id}_${lot.lot_number}_${idx}`}
                    className={`border rounded-lg p-4 transition ${
                      lot.status === 'expired'
                        ? 'border-red-200 bg-red-50'
                        : lot.status === 'warning'
                        ? 'border-yellow-200 bg-yellow-50'
                        : 'hover:shadow-md'
                    }`}
                  >
                    {/* 제품 정보 */}
                    <div className="flex justify-between items-start mb-3">
                      <div className="flex items-center gap-3">
                        {getStatusBadge(lot.status)}
                        <div>
                          <h3 className="font-semibold text-gray-900">
                            {lot.product?.product_name}
                          </h3>
                          <p className="text-sm text-gray-500">{lot.product?.product_code}</p>
                        </div>
                      </div>
                      <span className="text-lg font-bold text-blue-600">
                        {lot.totalQuantity.toLocaleString()}개
                      </span>
                    </div>

                    {/* 로트 정보 */}
                    <div className="grid grid-cols-3 gap-4 mb-3 text-sm">
                      <div>
                        <span className="text-gray-500">로트번호:</span>
                        <span className="ml-2 font-medium font-mono">{lot.lot_number || '-'}</span>
                      </div>
                      <div>
                        <span className="text-gray-500">유통기한:</span>
                        <span className="ml-2 font-medium">
                          {lot.expiry_date ? formatDate(lot.expiry_date.toISOString()) : '-'}
                        </span>
                      </div>
                      <div>
                        <span className="text-gray-500">남은 기간:</span>
                        <span className={`ml-2 font-medium ${
                          lot.status === 'expired' ? 'text-red-600' :
                          lot.status === 'warning' ? 'text-yellow-600' : ''
                        }`}>
                          {formatDaysRemaining(lot.daysRemaining)}
                        </span>
                      </div>
                    </div>

                    {/* 창고별 수량 */}
                    <div className="flex gap-2 flex-wrap">
                      {lot.items.map((item, itemIdx) => (
                        <div
                          key={itemIdx}
                          className="bg-white border rounded px-3 py-1.5 text-sm"
                        >
                          <span className="text-gray-500">{item.warehouse?.name}</span>
                          <span className="ml-2 font-medium">{item.quantity.toLocaleString()}개</span>
                        </div>
                      ))}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}
