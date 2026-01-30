'use client'

import { useEffect, useState } from 'react'
import { supabase } from '@/lib/supabase'
import { useAuth } from '@/app/contexts/AuthContext'
import Link from 'next/link'

// 타입 정의
interface Product {
  id: string
  product_group: string
  product_name: string
  product_code: string
  version: string
  unit_cost: number
  channel: string | null
  shelf_life_months: number | null
}

interface ExpiringLot {
  product: Product
  lot_number: string
  daysRemaining: number
  quantity: number
  status: 'warning' | 'expired'
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

interface Warehouse {
  id: string
  name: string
  location: string | null
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

interface Transaction {
  id: string
  product_id: string
  warehouse_id: string
  type: string
  quantity: number
  channel: string | null
  note: string | null
  recorded_by: string | null
  created_at: string
  products: Product
  warehouses: Warehouse
}

export default function Home() {
  const { profile, signOut } = useAuth()
  const [products, setProducts] = useState<Product[]>([])
  const [warehouses, setWarehouses] = useState<Warehouse[]>([])
  const [inventory, setInventory] = useState<InventoryItem[]>([])
  const [transactions, setTransactions] = useState<Transaction[]>([])
  const [expiringLots, setExpiringLots] = useState<ExpiringLot[]>([])
  const [loading, setLoading] = useState(true)
  const [selectedWarehouse, setSelectedWarehouse] = useState('전체')
  const [aiReport, setAiReport] = useState<string | null>(null)
  const [reportLoading, setReportLoading] = useState(false)
  const [showReport, setShowReport] = useState(false)
  const [reportGeneratedAt, setReportGeneratedAt] = useState<string | null>(null)

  // localStorage에서 리포트 불러오기
  useEffect(() => {
    const savedReport = localStorage.getItem('ai_report')
    const savedTime = localStorage.getItem('ai_report_time')
    if (savedReport) {
      setAiReport(savedReport)
      setShowReport(true)
      setReportGeneratedAt(savedTime)
      console.log('📊 [리포트] localStorage에서 불러옴')
    }
  }, [])

  // 데이터 불러오기 + 실시간 구독
  useEffect(() => {
    fetchData()

    // 실시간 구독: inventory 테이블 변경 감지
    const channel = supabase
      .channel('realtime-inventory')
      .on('postgres_changes', {
        event: '*',
        schema: 'public',
        table: 'inventory'
      }, () => {
        fetchData()
      })
      .on('postgres_changes', {
        event: '*',
        schema: 'public',
        table: 'transactions'
      }, () => {
        fetchData()
      })
      .subscribe()

    return () => {
      supabase.removeChannel(channel)
    }
  }, [])

  async function fetchData() {
    setLoading(true)

    // 제품 목록
    const { data: productsData } = await supabase
      .from('products')
      .select('*')
      .order('created_at', { ascending: false })

    // 창고 목록
    const { data: warehousesData } = await supabase
      .from('warehouses')
      .select('*')

    // 재고 현황 (제품, 창고 정보 포함)
    const { data: inventoryData } = await supabase
      .from('inventory')
      .select(`
        *,
        products (*),
        warehouses (*)
      `)

    // 최근 입출고 기록
    const { data: transactionsData } = await supabase
      .from('transactions')
      .select(`
        *,
        products (*),
        warehouses (*)
      `)
      .order('created_at', { ascending: false })
      .limit(10)

    setProducts(productsData || [])
    setWarehouses(warehousesData || [])
    setInventory(inventoryData || [])
    setTransactions(transactionsData || [])

    // 유통기한 임박 로트 계산
    const expiring: ExpiringLot[] = []
    if (inventoryData) {
      // AI로 비소모품 분류 (한 번만 호출)
      const uniqueProductNames = [...new Set(
        inventoryData.map((item: InventoryItem) => item.products?.product_name).filter(Boolean)
      )] as string[]
      const nonPerishableSet = await classifyNonPerishableProducts(uniqueProductNames)

      inventoryData.forEach((item: InventoryItem) => {
        if (!item.lot_number || !item.products) return

        // AI가 분류한 비소모품은 유통기한 체크 안함
        const productName = item.products.product_name || ''
        if (nonPerishableSet.has(productName)) return

        const mfgDate = parseLotNumber(item.lot_number)
        if (!mfgDate) return

        const shelfLifeMonths = item.products.shelf_life_months || 24
        const expiryDate = new Date(mfgDate)
        expiryDate.setMonth(expiryDate.getMonth() + shelfLifeMonths)

        const today = new Date()
        const totalDays = shelfLifeMonths * 30
        const remainingMs = expiryDate.getTime() - today.getTime()
        const daysRemaining = Math.ceil(remainingMs / (1000 * 60 * 60 * 24))

        // 25% 임계값
        const warningThresholdDays = totalDays * 0.25

        if (daysRemaining <= 0) {
          expiring.push({
            product: item.products,
            lot_number: item.lot_number,
            daysRemaining,
            quantity: item.quantity,
            status: 'expired'
          })
        } else if (daysRemaining <= warningThresholdDays) {
          expiring.push({
            product: item.products,
            lot_number: item.lot_number,
            daysRemaining,
            quantity: item.quantity,
            status: 'warning'
          })
        }
      })
    }
    // 남은 일수 오름차순 정렬
    expiring.sort((a, b) => a.daysRemaining - b.daysRemaining)
    setExpiringLots(expiring)

    setLoading(false)
  }

  // AI 리포트 생성
  async function generateReport() {
    setReportLoading(true)
    setShowReport(true)
    setAiReport(null)

    try {
      const response = await fetch('/api/report', { method: 'POST' })
      const data = await response.json()

      if (data.error) {
        setAiReport('리포트 생성 중 오류가 발생했습니다.')
      } else {
        setAiReport(data.report)
        // localStorage에 저장
        const now = new Date().toLocaleString('ko-KR')
        localStorage.setItem('ai_report', data.report)
        localStorage.setItem('ai_report_time', now)
        setReportGeneratedAt(now)
        console.log('📊 [리포트] localStorage에 저장됨')
      }
    } catch (error) {
      console.error('AI 리포트 에러:', error)
      setAiReport('리포트 생성 중 오류가 발생했습니다.')
    } finally {
      setReportLoading(false)
    }
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
      <div className="max-w-7xl mx-auto">
        {/* 헤더 */}
        <header className="mb-8">
          <div className="flex justify-between items-center">
            <div>
              <h1 className="text-3xl font-bold text-gray-900">📦 재고관리 AI</h1>
              <p className="text-gray-600 mt-2">중소기업을 위한 간편한 재고관리 시스템</p>
            </div>
            <div className="flex items-center gap-3">
              <span className={`text-xs px-2 py-1 rounded-full ${
                profile?.role === '본사'
                  ? 'bg-blue-100 text-blue-700'
                  : 'bg-green-100 text-green-700'
              }`}>
                {profile?.role}
              </span>
              <span className="font-medium text-gray-900">{profile?.name}</span>
              <button
                onClick={signOut}
                className="text-gray-500 hover:text-red-600 text-sm border px-3 py-1.5 rounded-lg hover:border-red-300 transition"
              >
                로그아웃
              </button>
            </div>
          </div>
          <div className="flex gap-3 mt-4">
            <Link
              href="/upload"
              className="bg-purple-600 text-white px-4 py-2 rounded-lg hover:bg-purple-700 transition"
            >
              엑셀 업로드
            </Link>
            <Link
              href="/products"
              className="bg-orange-500 text-white px-4 py-2 rounded-lg hover:bg-orange-700 transition"
            >
              제품 관리
            </Link>
            <Link
              href="/transactions"
              className="bg-green-600 text-white px-4 py-2 rounded-lg hover:bg-green-700 transition"
            >
              입출고
            </Link>
            <Link
              href="/lots"
              className="bg-teal-600 text-white px-4 py-2 rounded-lg hover:bg-teal-700 transition"
            >
              로트 관리
            </Link>
          </div>
        </header>

        {/* 메인 컨텐츠 + 사이드바 레이아웃 */}
        <div className="flex gap-6">
          {/* 좌측 메인 컨텐츠 */}
          <div className="flex-1 min-w-0">
            {/* 요약 카드 */}
            <div className="grid grid-cols-1 md:grid-cols-3 gap-4 mb-6">
              <div className="bg-white rounded-lg shadow p-4">
                <h3 className="text-sm font-medium text-gray-500">총 제품 수</h3>
                <p className="text-2xl font-bold text-gray-900 mt-1">{products.length}개</p>
              </div>
              <div className="bg-white rounded-lg shadow p-4">
                <h3 className="text-sm font-medium text-gray-500">창고 수</h3>
                <p className="text-2xl font-bold text-gray-900 mt-1">{warehouses.length}개</p>
              </div>
              <div className="bg-white rounded-lg shadow p-4">
                <h3 className="text-sm font-medium text-gray-500">오늘 입출고</h3>
                <p className="text-2xl font-bold text-gray-900 mt-1">{transactions.length}건</p>
              </div>
            </div>

            {/* 유통기한 임박 경고 */}
            {expiringLots.length > 0 && (
              <div className="bg-yellow-50 border border-yellow-200 rounded-lg shadow mb-6">
                <div className="p-3 border-b border-yellow-200 flex justify-between items-center">
                  <div className="flex items-center gap-2">
                    <span className="text-yellow-600">⚠️</span>
                    <h2 className="text-sm font-semibold text-yellow-800">
                      유통기한 임박/만료 ({expiringLots.length}건)
                    </h2>
                  </div>
                  <Link href="/lots" className="text-xs text-yellow-700 hover:underline">
                    상세 →
                  </Link>
                </div>
                <div className="p-3">
                  <div className="space-y-2">
                    {expiringLots.slice(0, 3).map((lot, idx) => (
                      <div
                        key={`${lot.product.id}_${lot.lot_number}_${idx}`}
                        className={`flex items-center justify-between p-2 rounded-lg text-sm ${
                          lot.status === 'expired' ? 'bg-red-100' : 'bg-yellow-100'
                        }`}
                      >
                        <div className="flex items-center gap-2">
                          <span className={`px-1.5 py-0.5 text-xs font-medium rounded-full ${
                            lot.status === 'expired' ? 'bg-red-200 text-red-700' : 'bg-yellow-200 text-yellow-700'
                          }`}>
                            {lot.status === 'expired' ? '만료' : '임박'}
                          </span>
                          <span className="font-medium text-gray-900">{lot.product.product_name}</span>
                        </div>
                        <span className={lot.status === 'expired' ? 'text-red-600' : 'text-yellow-600'}>
                          {lot.daysRemaining <= 0 ? '만료' : `${lot.daysRemaining}일`}
                        </span>
                      </div>
                    ))}
                    {expiringLots.length > 3 && (
                      <p className="text-center text-xs text-yellow-600">외 {expiringLots.length - 3}건</p>
                    )}
                  </div>
                </div>
              </div>
            )}

            {/* 재고 현황 - 탭 + 카드 */}
            <div className="bg-white rounded-lg shadow mb-6">
              <div className="p-4 border-b flex justify-between items-center">
                <h2 className="text-lg font-semibold">재고 현황</h2>
                <div className="flex gap-1 bg-gray-100 rounded-lg p-1">
                  <button
                    onClick={() => setSelectedWarehouse('전체')}
                    className={`px-3 py-1 rounded-md text-xs font-medium transition ${
                      selectedWarehouse === '전체' ? 'bg-white shadow text-gray-900' : 'text-gray-500 hover:text-gray-700'
                    }`}
                  >
                    전체
                  </button>
                  {warehouses.map((w) => (
                    <button
                      key={w.id}
                      onClick={() => setSelectedWarehouse(w.name)}
                      className={`px-3 py-1 rounded-md text-xs font-medium transition ${
                        selectedWarehouse === w.name ? 'bg-white shadow text-gray-900' : 'text-gray-500 hover:text-gray-700'
                      }`}
                    >
                      {w.name}
                    </button>
                  ))}
                </div>
              </div>
              <div className="p-4">
                {inventory.length === 0 ? (
                  <p className="text-gray-500 text-center py-4 text-sm">등록된 재고가 없습니다.</p>
                ) : (
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                    {Object.values(
                      inventory.reduce((acc, item) => {
                        const productId = item.product_id
                        if (!acc[productId]) {
                          acc[productId] = { product: item.products, items: [] }
                        }
                        acc[productId].items.push(item)
                        return acc
                      }, {} as Record<string, { product: Product; items: InventoryItem[] }>)
                    )
                      .filter((group) => {
                        if (selectedWarehouse === '전체') return true
                        return group.items.some(item => item.warehouses?.name === selectedWarehouse)
                      })
                      .map((group) => {
                        const filteredItems = selectedWarehouse === '전체'
                          ? group.items
                          : group.items.filter(item => item.warehouses?.name === selectedWarehouse)
                        const qty = filteredItems.reduce((sum, item) => sum + item.quantity, 0)

                        return (
                          <div key={group.product?.id} className="border rounded-lg p-3 hover:shadow-sm transition">
                            <div className="flex justify-between items-center">
                              <div>
                                <h3 className="font-medium text-gray-900 text-sm">{group.product?.product_name}</h3>
                                <p className="text-xs text-gray-500">{group.product?.product_code}</p>
                              </div>
                              <span className="text-base font-bold text-blue-600">{qty.toLocaleString()}개</span>
                            </div>
                          </div>
                        )
                      })}
                  </div>
                )}
              </div>
            </div>

            {/* 최근 입출고 기록 */}
            <div className="bg-white rounded-lg shadow">
              <div className="p-4 border-b">
                <h2 className="text-lg font-semibold">최근 입출고 기록</h2>
              </div>
              <div className="p-4">
                {transactions.length === 0 ? (
                  <p className="text-gray-500 text-center py-4">
                    입출고 기록이 없습니다.
                  </p>
                ) : (
                  <div className="space-y-3">
                    {transactions.map((tx) => {
                      const isTransfer = tx.note?.includes('[이동]') || tx.note?.includes('[샘플(이동)]')
                      const displayType = isTransfer ? '이동' : tx.type

                      return (
                      <div key={tx.id} className="flex items-center justify-between border-b pb-3">
                        <div className="flex items-center gap-3">
                          <span className={`px-2 py-1 rounded-full text-xs font-medium ${
                            isTransfer
                              ? 'bg-blue-100 text-blue-800'
                              : tx.type === '입고'
                              ? 'bg-green-100 text-green-800'
                              : 'bg-red-100 text-red-800'
                          }`}>
                            {displayType}
                          </span>
                          <div>
                            <p className="font-medium text-sm">{tx.products?.product_name}</p>
                            <p className="text-xs text-gray-500">
                              {tx.warehouses?.name} {tx.channel && `→ ${tx.channel}`}
                            </p>
                          </div>
                        </div>
                        <div className="text-right">
                          <p className={`font-semibold text-sm ${
                            tx.type === '입고' ? 'text-green-600' : 'text-red-600'
                          }`}>
                            {tx.type === '입고' ? '+' : '-'}{tx.quantity.toLocaleString()}개
                          </p>
                          <p className="text-xs text-gray-500">
                            {new Date(tx.created_at).toLocaleDateString('ko-KR')}
                          </p>
                        </div>
                      </div>
                      )
                    })}
                  </div>
                )}
              </div>
            </div>
          </div>
          {/* 좌측 메인 컨텐츠 끝 */}

          {/* 우측 AI 리포트 사이드바 */}
          <div className="w-80 flex-shrink-0">
            <div className="bg-gradient-to-b from-indigo-500 to-purple-600 rounded-lg shadow sticky top-4">
              <div className="p-4">
                <div className="flex items-center gap-2 mb-3">
                  <span className="text-xl">🤖</span>
                  <div>
                    <h3 className="font-semibold text-white text-sm">AI 월간 리포트</h3>
                    <p className="text-indigo-100 text-xs">
                      {reportGeneratedAt ? `${reportGeneratedAt}` : '이번 달 현황 분석'}
                    </p>
                  </div>
                </div>
                <button
                  onClick={generateReport}
                  disabled={reportLoading}
                  className="w-full bg-white text-indigo-600 px-3 py-2 rounded-lg text-sm font-medium hover:bg-indigo-50 transition disabled:opacity-50"
                >
                  {reportLoading ? '분석 중...' : showReport ? '새로고침' : '리포트 생성'}
                </button>
              </div>

              {/* 리포트 결과 */}
              {showReport && (
                <div className="bg-white rounded-b-lg p-4 max-h-[calc(100vh-200px)] overflow-y-auto">
                  {reportLoading ? (
                    <div className="flex flex-col items-center justify-center py-8">
                      <div className="animate-spin rounded-full h-6 w-6 border-b-2 border-indigo-600"></div>
                      <span className="mt-2 text-gray-600 text-xs">분석 중...</span>
                    </div>
                  ) : aiReport ? (
                    <div className="text-sm">
                      {aiReport.split('\n').map((line, idx) => {
                        if (line.startsWith('### ')) {
                          return <h4 key={idx} className="font-semibold text-gray-900 mt-3 mb-1 text-sm">{line.replace('### ', '')}</h4>
                        } else if (line.startsWith('- ')) {
                          return <p key={idx} className="text-gray-600 text-xs ml-2 my-0.5">{line}</p>
                        } else if (line.startsWith('→')) {
                          return <p key={idx} className="text-indigo-600 text-xs font-medium ml-2 my-1">{line}</p>
                        } else if (line.trim()) {
                          return <p key={idx} className="text-gray-700 text-xs my-1">{line}</p>
                        }
                        return null
                      })}
                    </div>
                  ) : (
                    <p className="text-gray-500 text-center py-4 text-xs">리포트를 생성해주세요</p>
                  )}
                </div>
              )}
            </div>
          </div>
        </div>
        {/* 메인 컨텐츠 + 사이드바 레이아웃 끝 */}
      </div>
    </div>
  )
}
