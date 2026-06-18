'use client'

import { useState, useEffect } from 'react'
import { supabase } from '@/lib/supabase'
import { useAuth } from '@/app/contexts/AuthContext'
import Navbar from '@/app/components/Navbar'
import {
  BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer,
  PieChart, Pie, Cell, Legend
} from 'recharts'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type InventoryItem = any

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Transaction = any

interface ExpiringLot {
  productName: string
  lotNumber: string
  quantity: number
  daysLeft: number
  status: 'warning' | 'expired'
  warehouseName: string
  unitCost: number
}

interface ReportStats {
  totalStock: number
  stockByWarehouse: Record<string, number>
  totalOutbound: number
  outboundByChannel: Record<string, number>
  warehouseCount: number
  productCount: number
  monthLabel: string
  noOutboundDaysCount: number
  expiringCount: number
  orderRecommendationCount: number
}

interface KpiData {
  expiryLossAmount: number      // 폐기 예상 손실액
  urgentOrderDays: number       // 발주 긴급 제품 최소 소진일
  urgentOrderCount: number      // 발주 긴급 제품 수
  bestChannelName: string       // 최고 마진 채널명
  bestChannelMargin: number     // 최고 마진율
}

const PIE_COLORS = ['#3b82f6', '#10b981', '#f59e0b', '#ef4444', '#8b5cf6', '#06b6d4', '#f97316']

function parseLotDate(lotNumber: string): Date | null {
  if (!lotNumber || lotNumber.length < 6) return null
  const yy = parseInt(lotNumber.substring(0, 2))
  const mm = parseInt(lotNumber.substring(2, 4)) - 1
  const dd = parseInt(lotNumber.substring(4, 6))
  if (isNaN(yy) || isNaN(mm) || isNaN(dd)) return null
  return new Date(2000 + yy, mm, dd)
}

export default function ReportPage() {
  const { profile } = useAuth()
  const [loading, setLoading] = useState(false)
  const [report, setReport] = useState<string | null>(null)
  const [stats, setStats] = useState<ReportStats | null>(null)
  const [expiringLots, setExpiringLots] = useState<ExpiringLot[]>([])
  const [warehouseChartData, setWarehouseChartData] = useState<{ name: string; 재고: number }[]>([])
  const [channelChartData, setChannelChartData] = useState<{ name: string; 출고: number }[]>([])
  const [generated, setGenerated] = useState(false)
  const [kpi, setKpi] = useState<KpiData | null>(null)

  useEffect(() => {
    if (!profile?.company_id) return
    prefetchChartData()
  }, [profile?.company_id])

  useEffect(() => {
    if (!profile?.company_id) return

    const channel = supabase
      .channel(`report-realtime-${profile.company_id}`)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'inventory' }, () => prefetchChartData())
      .subscribe()

    return () => { supabase.removeChannel(channel) }
  }, [profile?.company_id]) // eslint-disable-line react-hooks/exhaustive-deps

  async function prefetchChartData() {
    if (!profile?.company_id) return

    const [{ data: inventoryData }, { data: warehouseData }] = await Promise.all([
      supabase
        .from('inventory')
        .select('quantity, lot_number, products(product_name, product_code, product_group, shelf_life_months), warehouses(name)')
        .eq('company_id', profile.company_id),
      supabase
        .from('warehouses')
        .select('name')
        .eq('company_id', profile.company_id)
    ])

    if (!inventoryData) return

    // 창고별 재고 차트 데이터
    const stockByWarehouse: Record<string, number> = {}
    inventoryData.forEach((item: InventoryItem) => {
      const w = item.warehouses?.name || '미지정'
      stockByWarehouse[w] = (stockByWarehouse[w] || 0) + item.quantity
    })
    setWarehouseChartData(
      Object.entries(stockByWarehouse).map(([name, 재고]) => ({ name, 재고 }))
    )

    void warehouseData
  }

  async function generateReport() {
    if (!profile?.company_id) return
    setLoading(true)
    setReport(null)
    setStats(null)

    try {
      // 회사 설정
      const { data: companyData } = await supabase
        .from('companies')
        .select('default_shelf_life_months, shelf_life_warning_ratio')
        .eq('id', profile.company_id)
        .single()
      const shelfLife = companyData?.default_shelf_life_months || 24
      const warningRatio = companyData?.shelf_life_warning_ratio || 0.25

      // 재고 + 트랜잭션 + 창고
      const [{ data: inventoryData }, { data: txData }, { data: warehouseData }] = await Promise.all([
        supabase
          .from('inventory')
          .select('quantity, lot_number, products(product_name, product_code, product_group, shelf_life_months, unit_cost, track_expiry), warehouses(name)')
          .eq('company_id', profile.company_id),
        supabase
          .from('transactions')
          .select('type, quantity, channel, created_at, products(product_name)')
          .eq('company_id', profile.company_id)
          .order('created_at', { ascending: false })
          .limit(500),
        supabase
          .from('warehouses')
          .select('name')
          .eq('company_id', profile.company_id)
      ])

      const inventory = (inventoryData || []) as InventoryItem[]
      const transactions = (txData || []) as Transaction[]
      const warehouses = (warehouseData || []) as { name: string }[]

      // 임박 로트 계산
      const today = new Date()
      const computed: ExpiringLot[] = []
      inventory.forEach(item => {
        if (item.products?.track_expiry === false) return
        if (!item.lot_number) return
        const mfgDate = parseLotDate(item.lot_number)
        if (!mfgDate) return
        const sl = item.products?.shelf_life_months || shelfLife
        const expiry = new Date(mfgDate)
        expiry.setMonth(expiry.getMonth() + sl)
        const daysLeft = Math.ceil((expiry.getTime() - today.getTime()) / 86400000)
        const threshold = sl * 30 * warningRatio
        const unitCost = item.products?.unit_cost || 0
        if (daysLeft <= 0) {
          computed.push({ productName: item.products?.product_name, lotNumber: item.lot_number, quantity: item.quantity, daysLeft, status: 'expired', warehouseName: item.warehouses?.name, unitCost })
        } else if (daysLeft <= threshold) {
          computed.push({ productName: item.products?.product_name, lotNumber: item.lot_number, quantity: item.quantity, daysLeft, status: 'warning', warehouseName: item.warehouses?.name, unitCost })
        }
      })
      computed.sort((a, b) => a.daysLeft - b.daysLeft)
      setExpiringLots(computed)

      // ── KPI 1: 폐기 예상 손실액 ──────────────────────────────────────
      const expiryLossAmount = computed.reduce((sum, lot) => sum + lot.quantity * lot.unitCost, 0)

      // ── KPI 2: 발주 긴급 제품 (30일 소진 예상 기준) ──────────────────
      const stockByProduct: Record<string, { name: string; qty: number }> = {}
      inventory.forEach(item => {
        const key = item.products?.product_name
        if (!key) return
        if (!stockByProduct[key]) stockByProduct[key] = { name: key, qty: 0 }
        stockByProduct[key].qty += item.quantity
      })
      const thirtyDaysAgo = new Date(today.getTime() - 30 * 86400000)
      const outboundByProduct: Record<string, number> = {}
      transactions
        .filter(t => t.type === '출고' && new Date(t.created_at) >= thirtyDaysAgo)
        .forEach(t => {
          const pname = t.products?.product_name
          if (!pname) return
          outboundByProduct[pname] = (outboundByProduct[pname] || 0) + t.quantity
        })
      const urgentProducts: { name: string; daysLeft: number }[] = []
      Object.entries(stockByProduct).forEach(([, { name, qty }]) => {
        const outbound30d = outboundByProduct[name] || 0
        if (outbound30d === 0) return
        const dailyRate = outbound30d / 30
        const daysLeft = Math.floor(qty / dailyRate)
        if (daysLeft < 30) urgentProducts.push({ name, daysLeft })
      })
      urgentProducts.sort((a, b) => a.daysLeft - b.daysLeft)
      const urgentOrderCount = urgentProducts.length
      const urgentOrderDays = urgentProducts.length > 0 ? urgentProducts[0].daysLeft : 999

      // ── KPI 3: 최고 마진 채널 (기획세트 기준) ────────────────────────
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const { data: plansData } = await supabase
        .from('product_plans')
        .select('name, channel, selling_price, commission_rate, event_discount_rate, assembly_cost, plan_items(quantity, products(unit_cost))')
        .eq('company_id', profile.company_id)
      let bestChannelName = '-'
      let bestChannelMargin = -Infinity
      if (plansData && plansData.length > 0) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        plansData.forEach((plan: any) => {
          if (!plan.selling_price || plan.selling_price === 0) return
          const netRevenue = plan.selling_price * (1 - (plan.commission_rate || 0) - (plan.event_discount_rate || 0))
          const bomCost = (plan.plan_items || []).reduce((sum: number, item: any) => {
            return sum + (item.quantity || 0) * (item.products?.unit_cost || 0)
          }, 0)
          const totalCost = bomCost + (plan.assembly_cost || 0)
          if (totalCost === 0) return
          const margin = (netRevenue - totalCost) / plan.selling_price
          if (margin > bestChannelMargin) {
            bestChannelMargin = margin
            bestChannelName = plan.channel || plan.name
          }
        })
      }
      if (bestChannelMargin === -Infinity) bestChannelMargin = 0

      setKpi({ expiryLossAmount, urgentOrderDays, urgentOrderCount, bestChannelName, bestChannelMargin })

      // 창고별 재고 차트
      const stockByWarehouse: Record<string, number> = {}
      inventory.forEach(item => {
        const w = item.warehouses?.name || '미지정'
        stockByWarehouse[w] = (stockByWarehouse[w] || 0) + item.quantity
      })
      setWarehouseChartData(
        Object.entries(stockByWarehouse).map(([name, 재고]) => ({ name, 재고 }))
      )

      // 채널별 출고 차트 (이번 달)
      const monthStart = new Date(today.getFullYear(), today.getMonth(), 1)
      const outboundByChannel: Record<string, number> = {}
      transactions
        .filter(t => t.type === '출고' && new Date(t.created_at) >= monthStart)
        .forEach(t => {
          const ch = t.channel || '기타'
          outboundByChannel[ch] = (outboundByChannel[ch] || 0) + t.quantity
        })
      setChannelChartData(
        Object.entries(outboundByChannel).map(([name, 출고]) => ({ name, 출고 }))
      )

      // API 호출
      const res = await fetch('/api/report', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          inventory: inventory.map(i => ({
            quantity: i.quantity,
            lot_number: i.lot_number,
            product_name: i.products?.product_name,
            product_code: i.products?.product_code,
            product_group: i.products?.product_group,
            shelf_life_months: i.products?.shelf_life_months,
            warehouse_name: i.warehouses?.name,
            track_expiry: i.products?.track_expiry !== false
          })),
          transactions: transactions.map(t => ({
            type: t.type,
            quantity: t.quantity,
            channel: t.channel,
            created_at: t.created_at,
            product_name: t.products?.product_name
          })),
          warehouses,
          expiringLots: computed
        })
      })

      const result = await res.json()
      setReport(result.report || '리포트 생성 실패')
      setStats(result.stats || null)
      setGenerated(true)
    } catch (err) {
      console.error(err)
      setReport('오류가 발생했습니다. 다시 시도해주세요.')
    } finally {
      setLoading(false)
    }
  }

  function renderReport(text: string) {
    return text.split('\n').map((line, i) => {
      if (line.startsWith('### ')) {
        return <h3 key={i} className="text-xs font-bold text-gray-800 mt-3 mb-1">{line.replace('### ', '')}</h3>
      }
      if (line.startsWith('## ')) {
        return <h2 key={i} className="text-sm font-bold text-gray-900 mt-3 mb-1">{line.replace('## ', '')}</h2>
      }
      if (line.startsWith('**') && line.endsWith('**')) {
        return <p key={i} className="text-xs font-semibold text-gray-800 mt-1">{line.replace(/\*\*/g, '')}</p>
      }
      if (line.startsWith('- ') || line.startsWith('* ')) {
        const content = line.slice(2)
        const isWarning = content.includes('→ 권고')
        return (
          <li key={i} className={`ml-3 list-disc text-xs ${isWarning ? 'text-orange-600 font-medium' : 'text-gray-700'}`}>
            {content}
          </li>
        )
      }
      if (line.trim() === '') return <div key={i} className="h-0.5" />
      return <p key={i} className="text-xs text-gray-700">{line}</p>
    })
  }

  return (
    <>
      <Navbar />
      <div className="min-h-screen bg-slate-50 pt-28 md:pt-20 p-3 md:p-6">
      <div className="max-w-5xl mx-auto">

        {/* Header */}
        <div className="mb-4">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <h1 className="text-xl font-bold text-gray-900">AI 분석 리포트</h1>
              <p className="text-gray-500 text-sm mt-0.5">재고 현황을 AI가 분석해 인사이트를 제공합니다</p>
            </div>
            <button
              onClick={generateReport}
              disabled={loading}
              className="bg-blue-600 text-white px-3 py-1.5 md:px-5 md:py-2 text-sm rounded-lg font-medium hover:bg-blue-700 disabled:opacity-50 transition flex items-center gap-1.5 shrink-0"
            >
              {loading ? (
                <>
                  <svg className="animate-spin w-5 h-5" viewBox="0 0 24 24" fill="none">
                    <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"/>
                    <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"/>
                  </svg>
                  분석 중...
                </>
              ) : (
                <>
                  <span>AI 리포트 생성</span>
                </>
              )}
            </button>
          </div>
        </div>

        {/* 차트 섹션 (항상 표시) */}
        {warehouseChartData.length > 0 && (
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3 mb-3">

            {/* 창고별 재고 */}
            <div className="bg-white rounded-xl shadow p-3">
              <h3 className="text-xs font-semibold text-gray-700 mb-2">창고별 재고 현황</h3>
              <ResponsiveContainer width="100%" height={150}>
                <BarChart data={warehouseChartData} margin={{ top: 3, right: 8, left: 0, bottom: 3 }}>
                  <CartesianGrid strokeDasharray="3 3" />
                  <XAxis dataKey="name" tick={{ fontSize: 10 }} />
                  <YAxis tick={{ fontSize: 10 }} />
                  <Tooltip formatter={(v) => [`${Number(v).toLocaleString()}개`, '재고']} />
                  <Bar dataKey="재고" fill="#3b82f6" radius={[3, 3, 0, 0]} />
                </BarChart>
              </ResponsiveContainer>
            </div>

            {/* 채널별 출고 (리포트 생성 후) */}
            {generated && channelChartData.length > 0 ? (
              <div className="bg-white rounded-xl shadow p-3">
                <h3 className="text-xs font-semibold text-gray-700 mb-2">이번 달 채널별 출고</h3>
                <ResponsiveContainer width="100%" height={150}>
                  <PieChart>
                    <Pie data={channelChartData} dataKey="출고" nameKey="name" cx="50%" cy="50%" outerRadius={55} label={({ name, percent }) => `${name} ${((percent ?? 0) * 100).toFixed(0)}%`}>
                      {channelChartData.map((_, idx) => (
                        <Cell key={idx} fill={PIE_COLORS[idx % PIE_COLORS.length]} />
                      ))}
                    </Pie>
                    <Tooltip formatter={(v) => [`${Number(v).toLocaleString()}개`, '출고']} />
                    <Legend wrapperStyle={{ fontSize: 10 }} />
                  </PieChart>
                </ResponsiveContainer>
              </div>
            ) : generated && channelChartData.length === 0 ? (
              <div className="bg-white rounded-xl shadow p-3 flex items-center justify-center text-gray-400 text-xs">
                이번 달 출고 데이터 없음
              </div>
            ) : (
              <div className="bg-white rounded-xl shadow p-3 flex flex-col items-center justify-center text-gray-400 gap-1">
                <span className="text-2xl">📊</span>
                <p className="text-xs text-center">AI 리포트 생성 후<br />채널별 출고 차트가 표시됩니다</p>
              </div>
            )}
          </div>
        )}

        {/* KPI 카드 (리포트 생성 후) */}
        {kpi && (
          <div className="grid grid-cols-3 gap-2 mb-3">
            {/* 폐기 예상 손실액 */}
            <div className="bg-white rounded-lg shadow p-2.5 border-l-4 border-red-400">
              <p className="text-xs font-semibold text-red-500 mb-0.5 leading-tight">폐기 손실</p>
              <p className="text-sm font-bold text-gray-900 leading-tight">
                {kpi.expiryLossAmount > 0
                  ? `${Math.round(kpi.expiryLossAmount / 10000).toLocaleString()}만원`
                  : '없음'}
              </p>
              <p className="text-xs text-gray-400 mt-0.5 leading-tight">
                {kpi.expiryLossAmount > 0 ? `임박/만료×원가` : '임박 없음'}
              </p>
            </div>

            {/* 발주 긴급 */}
            <div className={`bg-white rounded-lg shadow p-2.5 border-l-4 ${kpi.urgentOrderCount > 0 ? 'border-amber-400' : 'border-green-400'}`}>
              <p className={`text-xs font-semibold mb-0.5 leading-tight ${kpi.urgentOrderCount > 0 ? 'text-amber-500' : 'text-green-500'}`}>발주 긴급</p>
              <p className="text-sm font-bold text-gray-900 leading-tight">
                {kpi.urgentOrderCount > 0 ? `${kpi.urgentOrderCount}품목` : '이상없음'}
              </p>
              <p className="text-xs text-gray-400 mt-0.5 leading-tight">
                {kpi.urgentOrderCount > 0 ? `D-${kpi.urgentOrderDays}일` : '30일↑ 안전'}
              </p>
            </div>

            {/* 최고 마진 채널 */}
            <div className="bg-white rounded-lg shadow p-2.5 border-l-4 border-blue-400">
              <p className="text-xs font-semibold text-blue-500 mb-0.5 leading-tight">마진채널</p>
              <p className="text-sm font-bold text-gray-900 leading-tight truncate">
                {kpi.bestChannelName !== '-' ? kpi.bestChannelName : '기획없음'}
              </p>
              <p className="text-xs text-gray-400 mt-0.5 leading-tight">
                {kpi.bestChannelMargin > 0 ? `${(kpi.bestChannelMargin * 100).toFixed(1)}%` : '데이터부족'}
              </p>
            </div>
          </div>
        )}

        {/* Stats 카드 (리포트 생성 후) */}
        {stats && (
          <div className="grid grid-cols-4 gap-2 mb-3">
            <div className="bg-white rounded-lg shadow p-2">
              <p className="text-xs text-gray-500 leading-tight">총 재고</p>
              <p className="text-base font-bold text-gray-900">{stats.totalStock.toLocaleString()}</p>
              <p className="text-xs text-gray-400">개</p>
            </div>
            <div className="bg-white rounded-lg shadow p-2">
              <p className="text-xs text-gray-500 leading-tight">{stats.monthLabel} 출고</p>
              <p className="text-base font-bold text-blue-600">{stats.totalOutbound.toLocaleString()}</p>
              <p className="text-xs text-gray-400">개</p>
            </div>
            <div className="bg-white rounded-lg shadow p-2">
              <p className="text-xs text-gray-500 leading-tight">임박/만료</p>
              <p className={`text-base font-bold ${stats.expiringCount > 0 ? 'text-red-500' : 'text-green-500'}`}>
                {stats.expiringCount}
              </p>
              <p className="text-xs text-gray-400">로트</p>
            </div>
            <div className="bg-white rounded-lg shadow p-2">
              <p className="text-xs text-gray-500 leading-tight">발주 권고</p>
              <p className={`text-base font-bold ${stats.orderRecommendationCount > 0 ? 'text-amber-500' : 'text-green-500'}`}>
                {stats.orderRecommendationCount}
              </p>
              <p className="text-xs text-gray-400">품목</p>
            </div>
          </div>
        )}

        <div className="grid grid-cols-1 md:grid-cols-3 gap-3">

          {/* AI 리포트 텍스트 */}
          <div className="md:col-span-2">
            {loading ? (
              <div className="bg-white rounded-xl shadow p-6 flex flex-col items-center justify-center gap-3 min-h-[200px]">
                <svg className="animate-spin w-7 h-7 text-blue-500" viewBox="0 0 24 24" fill="none">
                  <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"/>
                  <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"/>
                </svg>
                <p className="text-gray-500 text-sm">AI가 분석 중입니다...</p>
              </div>
            ) : report ? (
              <div className="bg-white rounded-xl shadow p-3">
                <div className="flex items-center gap-2 mb-2 pb-2 border-b">
                  <span className="text-blue-600 text-sm font-bold">AI</span>
                  <h2 className="text-sm font-bold text-gray-900">AI 분석 리포트</h2>
                  <span className="ml-auto text-xs text-gray-400">{new Date().toLocaleDateString('ko-KR')}</span>
                </div>
                <div className="space-y-0.5 leading-snug">
                  {renderReport(report)}
                </div>
              </div>
            ) : (
              <div className="bg-white rounded-xl shadow p-5 flex flex-col items-center justify-center gap-3 min-h-[200px] text-center">
                <span className="text-4xl">📋</span>
                <h3 className="text-sm font-semibold text-gray-700">AI 리포트를 생성하세요</h3>
                <p className="text-gray-400 text-xs">
                  재고 현황, 유통기한 임박 상품,<br />
                  이번 달 출고 현황을 AI가 분석합니다
                </p>
                <button
                  onClick={generateReport}
                  className="mt-1 bg-blue-600 text-white px-4 py-1.5 rounded-lg text-sm font-medium hover:bg-blue-700 transition"
                >
                  리포트 생성하기
                </button>
              </div>
            )}
          </div>

          {/* 임박 상품 목록 */}
          <div className="bg-white rounded-xl shadow p-3">
            <h3 className="text-xs font-semibold text-gray-800 mb-2 flex items-center gap-1.5">
              <span>유통기한 임박/만료</span>
              {expiringLots.length > 0 && (
                <span className="bg-red-100 text-red-600 text-xs px-1.5 py-0.5 rounded-full font-medium">
                  {expiringLots.length}건
                </span>
              )}
            </h3>
            {expiringLots.length === 0 && !generated ? (
              <p className="text-gray-400 text-xs text-center py-6">리포트 생성 후 표시됩니다</p>
            ) : expiringLots.length === 0 ? (
              <div className="text-center py-6">
                <p className="text-green-500 text-lg mb-1">✓</p>
                <p className="text-gray-500 text-xs">임박/만료 상품 없음</p>
              </div>
            ) : (
              <div className="space-y-1.5 max-h-[400px] overflow-y-auto">
                {expiringLots.map((lot, idx) => (
                  <div key={idx} className={`p-2 rounded-lg border ${
                    lot.status === 'expired'
                      ? 'bg-red-50 border-red-200'
                      : 'bg-orange-50 border-orange-200'
                  }`}>
                    <div className="flex items-start justify-between gap-1">
                      <div className="min-w-0">
                        <p className="text-xs font-medium text-gray-800 truncate">{lot.productName}</p>
                        <p className="text-xs text-gray-400">{lot.lotNumber} · {lot.warehouseName}</p>
                      </div>
                      <div className="text-right shrink-0">
                        <span className={`text-xs font-bold px-1.5 py-0.5 rounded-full ${
                          lot.status === 'expired'
                            ? 'bg-red-100 text-red-700'
                            : 'bg-orange-100 text-orange-700'
                        }`}>
                          {lot.status === 'expired' ? '만료' : `D-${lot.daysLeft}`}
                        </span>
                        <p className="text-xs text-gray-400 mt-0.5">{lot.quantity.toLocaleString()}개</p>
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>

      </div>
    </div>
    </>
  )
}
