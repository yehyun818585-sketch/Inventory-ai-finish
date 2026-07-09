'use client'

import { useEffect, useState, useRef } from 'react'
import Link from 'next/link'
import { supabase } from '@/lib/supabase'
import { useAuth } from '@/app/contexts/AuthContext'
import Navbar from '@/app/components/Navbar'
import {
  getInboundReconciliation,
  getOutboundReconciliation,
  getTransferReconciliation,
  getInboundEvidenceExceptions,
  getOutboundEvidenceExceptions,
  classifyMissing
} from '@/lib/reconciliation'

// ── 타입 ────────────────────────────────────────────────
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
  type: string
  quantity: number
  channel: string | null
  note: string | null
  created_at: string
  products: Product
  warehouses: Warehouse
}

interface AiBriefing {
  urgentProduct: string | null
  urgentDays: number | null
  expiryLoss: number
  bestChannel: string | null
  bestMargin: number
}

// ── 유틸 ────────────────────────────────────────────────
function parseLotNumber(lot: string | null): Date | null {
  if (!lot || lot.length < 6) return null
  const yy = parseInt(lot.substring(0, 2))
  const mm = parseInt(lot.substring(2, 4)) - 1
  const dd = parseInt(lot.substring(4, 6))
  if (isNaN(yy) || isNaN(mm) || isNaN(dd)) return null
  return new Date(2000 + yy, mm, dd)
}

const RECENT_COMMANDS_KEY = 'inventory-ai-recent-commands'
function getRecentCommands(): string[] {
  try {
    const raw = localStorage.getItem(RECENT_COMMANDS_KEY)
    return raw ? JSON.parse(raw) : []
  } catch { return [] }
}
function saveRecentCommand(cmd: string) {
  const prev = getRecentCommands().filter(c => c !== cmd)
  const next = [cmd, ...prev].slice(0, 5)
  localStorage.setItem(RECENT_COMMANDS_KEY, JSON.stringify(next))
}

// ── 컴포넌트 ────────────────────────────────────────────
export default function Home() {
  const { profile } = useAuth()

  const [products, setProducts] = useState<Product[]>([])
  const [warehouses, setWarehouses] = useState<Warehouse[]>([])
  const [inventory, setInventory] = useState<InventoryItem[]>([])
  const [transactions, setTransactions] = useState<Transaction[]>([])
  const [todayCount, setTodayCount] = useState(0)
  const [expiringCount, setExpiringCount] = useState(0)
  const [loading, setLoading] = useState(true)
  const [selectedWarehouse, setSelectedWarehouse] = useState('전체')
  const [inventorySearch, setInventorySearch] = useState('')
  const [briefing, setBriefing] = useState<AiBriefing | null>(null)
  const [actionAlerts, setActionAlerts] = useState({ overdueCount: 0, evidenceCount: 0 })

  // Command bar
  const [command, setCommand] = useState('')
  const [recentCmds, setRecentCmds] = useState<string[]>([])
  const [toast, setToast] = useState<string | null>(null)
  const commandInputRef = useRef<HTMLInputElement>(null)

  // 임박 알림
  useEffect(() => {
    if (!profile?.company_id) return
    checkExpiryAlert(profile.company_id)
  }, [profile?.company_id])

  // 결재 대사 예외 알림
  useEffect(() => {
    if (!profile?.company_id) return
    checkReconciliationAlert(profile.company_id)
  }, [profile?.company_id])

  useEffect(() => {
    if (!profile?.company_id) return
    fetchData()
    loadActionAlerts(profile.company_id)
    setRecentCmds(getRecentCommands())
  }, [profile?.company_id])

  useEffect(() => {
    if (!profile?.company_id) return
    const ch = supabase
      .channel(`home-realtime-${profile.company_id}`)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'inventory' }, fetchData)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'transactions' }, fetchData)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'products' }, fetchData)
      .subscribe()
    return () => { supabase.removeChannel(ch) }
  }, [profile?.company_id])

  async function checkExpiryAlert(companyId: string) {
    const { data } = await supabase.from('companies').select('last_expiry_alert_at').eq('id', companyId).single()
    const lastSent = data?.last_expiry_alert_at
    if (lastSent && (new Date().getTime() - new Date(lastSent).getTime()) < 24 * 60 * 60 * 1000) return
    const res = await fetch('/api/check-expiry-alert', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ company_id: companyId })
    })
    const result = await res.json()
    if (result.sent) {
      await supabase.from('companies').update({ last_expiry_alert_at: new Date().toISOString() }).eq('id', companyId)
    }
  }

  async function checkReconciliationAlert(companyId: string) {
    const { data } = await supabase.from('companies').select('last_reconciliation_alert_at').eq('id', companyId).single()
    const lastSent = data?.last_reconciliation_alert_at
    if (lastSent && (new Date().getTime() - new Date(lastSent).getTime()) < 24 * 60 * 60 * 1000) return
    const res = await fetch('/api/check-reconciliation-alert', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ company_id: companyId })
    })
    const result = await res.json()
    if (result.sent) {
      await supabase.from('companies').update({ last_reconciliation_alert_at: new Date().toISOString() }).eq('id', companyId)
    }
  }

  // 대시보드 진입 시마다 "조치 필요" 배너용 카운트 계산 (기한초과 미기록/미달 + 증빙 미첨부/불일치)
  async function loadActionAlerts(companyId: string) {
    const [{ data: companyData }, inbound, outbound, transfer, inboundEvidence, outboundEvidence] = await Promise.all([
      supabase.from('companies').select('reconciliation_grace_days, outbound_grace_days').eq('id', companyId).single(),
      getInboundReconciliation(companyId),
      getOutboundReconciliation(companyId),
      getTransferReconciliation(companyId),
      getInboundEvidenceExceptions(companyId),
      getOutboundEvidenceExceptions(companyId)
    ])
    const graceBySource = {
      default: companyData?.reconciliation_grace_days ?? 3,
      outbound: companyData?.outbound_grace_days ?? 0
    }
    const allMissing = [
      ...inbound.progress.map(p => ({ ...p, source: '입고' as const })),
      ...outbound.progress.map(p => ({ ...p, source: '출고' as const })),
      ...transfer.progress.map(p => ({ ...p, source: '이동' as const }))
    ].filter(p => p.remaining_qty > 0)
    const overdueCount = allMissing.filter(m => classifyMissing(m, graceBySource) === 'overdue').length
    const evidenceCount = inboundEvidence.length + outboundEvidence.exceptions.length
    setActionAlerts({ overdueCount, evidenceCount })
  }

  async function fetchData() {
    if (!profile?.company_id) return
    setLoading(true)
    const cid = profile.company_id

    const [
      { data: productsData },
      { data: warehousesData },
      { data: inventoryData },
      { data: txData },
      { count: todayTxCount },
      { data: companyData },
      { data: plansData }
    ] = await Promise.all([
      supabase.from('products').select('*').eq('company_id', cid).eq('is_active', true),
      supabase.from('warehouses').select('*').eq('company_id', cid),
      supabase.from('inventory').select('*, products(*), warehouses(*)').eq('company_id', cid),
      supabase.from('transactions').select('*, products(*), warehouses(*)').eq('company_id', cid).order('created_at', { ascending: false }).limit(10),
      supabase.from('transactions').select('*', { count: 'exact', head: true }).eq('company_id', cid).gte('created_at', new Date(new Date().setHours(0, 0, 0, 0)).toISOString()),
      supabase.from('companies').select('default_shelf_life_months, shelf_life_warning_ratio').eq('id', cid).single(),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      supabase.from('product_plans').select('name, channel, selling_price, commission_rate, event_discount_rate, assembly_cost, plan_items(quantity, products(unit_cost))').eq('company_id', cid) as any
    ])

    const inv = (inventoryData || []) as InventoryItem[]
    const txs = (txData || []) as Transaction[]
    setProducts(productsData || [])
    setWarehouses(warehousesData || [])
    setInventory(inv)
    setTransactions(txs)
    setTodayCount(todayTxCount || 0)

    const shelfLife = companyData?.default_shelf_life_months || 24
    const warningRatio = companyData?.shelf_life_warning_ratio || 0.25
    const today = new Date()

    // 임박 로트 계산
    let expCount = 0
    let expiryLoss = 0
    inv.forEach(item => {
      if (!item.lot_number || !item.products) return
      const mfg = parseLotNumber(item.lot_number)
      if (!mfg) return
      const sl = item.products.shelf_life_months || shelfLife
      const expiry = new Date(mfg)
      expiry.setMonth(expiry.getMonth() + sl)
      const daysLeft = Math.ceil((expiry.getTime() - today.getTime()) / 86400000)
      const threshold = sl * 30 * warningRatio
      if (daysLeft <= threshold) {
        expCount++
        expiryLoss += item.quantity * (item.products.unit_cost || 0)
      }
    })
    setExpiringCount(expCount)

    // 발주 긴급 계산 (30일 소진율)
    const thirtyDaysAgo = new Date(today.getTime() - 30 * 86400000)
    const stockByProduct: Record<string, { name: string; qty: number }> = {}
    inv.forEach(item => {
      const k = item.products?.product_name
      if (!k) return
      if (!stockByProduct[k]) stockByProduct[k] = { name: k, qty: 0 }
      stockByProduct[k].qty += item.quantity
    })

    const [{ data: allTx }] = await Promise.all([
      supabase.from('transactions').select('type, quantity, products(product_name)').eq('company_id', cid).eq('type', '출고').gte('created_at', thirtyDaysAgo.toISOString())
    ])
    const outboundByProduct: Record<string, number> = {}
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ;(allTx || []).forEach((t: any) => {
      const pname = t.products?.product_name
      if (!pname) return
      outboundByProduct[pname] = (outboundByProduct[pname] || 0) + t.quantity
    })

    let urgentProduct: string | null = null
    let urgentDays: number | null = null
    Object.entries(stockByProduct).forEach(([, { name, qty }]) => {
      const out30 = outboundByProduct[name] || 0
      if (out30 === 0) return
      const days = Math.floor(qty / (out30 / 30))
      if (days < 30 && (urgentDays === null || days < urgentDays)) {
        urgentDays = days
        urgentProduct = name
      }
    })

    // 최고 마진 채널
    let bestChannel: string | null = null
    let bestMargin = -Infinity
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ;(plansData || []).forEach((plan: any) => {
      if (!plan.selling_price) return
      const net = plan.selling_price * (1 - (plan.commission_rate || 0) - (plan.event_discount_rate || 0))
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const bom = (plan.plan_items || []).reduce((s: number, i: any) => s + (i.quantity || 0) * (i.products?.unit_cost || 0), 0)
      const cost = bom + (plan.assembly_cost || 0)
      if (cost === 0) return
      const margin = (net - cost) / plan.selling_price
      if (margin > bestMargin) { bestMargin = margin; bestChannel = plan.channel || plan.name }
    })

    setBriefing({
      urgentProduct,
      urgentDays,
      expiryLoss,
      bestChannel,
      bestMargin: bestMargin === -Infinity ? 0 : bestMargin
    })

    setLoading(false)
  }

  // ── Command bar 제출 ─────────────────────────────────
  function handleCommandSubmit(e: React.FormEvent) {
    e.preventDefault()
    const cmd = command.trim()
    if (!cmd) return

    saveRecentCommand(cmd)
    setRecentCmds(getRecentCommands())
    setCommand('')

    // Toast 표시
    setToast('🤖 AI가 처리 중입니다...')
    setTimeout(() => setToast(null), 3000)

    // ChatWidget 열기 + 메시지 전송
    window.dispatchEvent(new CustomEvent('open-chat', { detail: { message: cmd } }))
  }

  // ── 재고 그룹핑 ─────────────────────────────────────
  const inventoryGroups = Object.values(
    inventory.reduce((acc, item) => {
      const pid = item.product_id
      if (!acc[pid]) acc[pid] = { product: item.products, items: [] }
      acc[pid].items.push(item)
      return acc
    }, {} as Record<string, { product: Product; items: InventoryItem[] }>)
  ).filter(g => {
    const matchW = selectedWarehouse === '전체' || g.items.some(i => i.warehouses?.name === selectedWarehouse)
    const matchS = !inventorySearch ||
      g.product?.product_name?.toLowerCase().includes(inventorySearch.toLowerCase()) ||
      g.product?.product_code?.toLowerCase().includes(inventorySearch.toLowerCase())
    return matchW && matchS
  })

  if (loading) {
    return (
      <>
        <Navbar />
        <div className="min-h-screen flex items-center justify-center pt-14 bg-slate-50">
          <div className="flex flex-col items-center gap-3">
            <svg className="animate-spin w-8 h-8 text-blue-500" viewBox="0 0 24 24" fill="none">
              <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"/>
              <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"/>
            </svg>
            <p className="text-gray-500 text-sm">데이터 불러오는 중...</p>
          </div>
        </div>
      </>
    )
  }

  return (
    <>
      <Navbar />
      <div className="min-h-screen bg-slate-50 pt-24 md:pt-20">
        <div className="max-w-7xl mx-auto px-6 py-8">

          {/* ── KPI 카드 4개 ── */}
          <div className="grid grid-cols-2 md:grid-cols-4 gap-2 mb-3">
            <div className="bg-white rounded-lg shadow-sm p-2.5 md:p-4 border border-gray-100">
              <p className="text-xs font-semibold text-gray-400 uppercase tracking-wide mb-0.5">총 제품</p>
              <p className="text-xl md:text-2xl font-bold text-gray-900">{products.length}</p>
              <p className="text-xs text-gray-400">개 등록됨</p>
            </div>
            <div className="bg-white rounded-lg shadow-sm p-2.5 md:p-4 border border-gray-100">
              <p className="text-xs font-semibold text-gray-400 uppercase tracking-wide mb-0.5">창고</p>
              <p className="text-xl md:text-2xl font-bold text-gray-900">{warehouses.length}</p>
              <p className="text-xs text-gray-400">개 운영 중</p>
            </div>
            <div className="bg-white rounded-lg shadow-sm p-2.5 md:p-4 border border-gray-100">
              <p className="text-xs font-semibold text-gray-400 uppercase tracking-wide mb-0.5">오늘 입출고</p>
              <p className="text-xl md:text-2xl font-bold text-blue-600">{todayCount}</p>
              <p className="text-xs text-gray-400">건 처리됨</p>
            </div>
            <div className={`rounded-lg shadow-sm p-2.5 md:p-4 border ${expiringCount > 0 ? 'bg-red-50 border-red-200' : 'bg-white border-gray-100'}`}>
              <p className={`text-xs font-semibold uppercase tracking-wide mb-0.5 ${expiringCount > 0 ? 'text-red-400' : 'text-gray-400'}`}>유통기한 임박</p>
              <p className={`text-xl md:text-2xl font-bold ${expiringCount > 0 ? 'text-red-600' : 'text-emerald-500'}`}>
                {expiringCount > 0 ? expiringCount : '없음'}
              </p>
              <p className={`text-xs ${expiringCount > 0 ? 'text-red-400' : 'text-gray-400'}`}>
                {expiringCount > 0 ? '로트 주의 필요' : '정상'}
              </p>
            </div>
          </div>

          {/* ── AI 운영 브리핑 ── */}
          {briefing && (
            <div className="bg-gradient-to-r from-blue-50 to-indigo-50 border border-blue-200 rounded-xl p-3 md:p-5 mb-4">
              <div className="flex items-center gap-2 mb-3">
                <span className="text-blue-600 font-bold text-sm">🤖 AI 운영 브리핑</span>
                <span className="text-xs text-blue-400">{new Date().toLocaleDateString('ko-KR')} 기준</span>
              </div>
              <div className="flex flex-col gap-1.5">
                {briefing.urgentProduct && briefing.urgentDays !== null ? (
                  <div className="flex items-center gap-2 text-sm">
                    <span className="text-amber-500 font-bold">⚠️</span>
                    <span className="text-gray-700">
                      <span className="font-semibold text-gray-900">{briefing.urgentProduct}</span>
                      {' '}재고 소진 예상 <span className="font-bold text-amber-600">D-{briefing.urgentDays}일</span>
                      {' '}&mdash; 발주 검토 필요
                    </span>
                  </div>
                ) : (
                  <div className="flex items-center gap-2 text-sm">
                    <span className="text-emerald-500 font-bold">✅</span>
                    <span className="text-gray-600">30일 이내 품절 예상 제품 없음</span>
                  </div>
                )}
                {briefing.expiryLoss > 0 ? (
                  <div className="flex items-center gap-2 text-sm">
                    <span className="text-red-500 font-bold">🔴</span>
                    <span className="text-gray-700">
                      폐기 예상 손실 <span className="font-bold text-red-600">{Math.round(briefing.expiryLoss / 10000).toLocaleString()}만원</span>
                      {' '}&mdash; 임박/만료 재고 × 원가
                    </span>
                  </div>
                ) : (
                  <div className="flex items-center gap-2 text-sm">
                    <span className="text-emerald-500 font-bold">✅</span>
                    <span className="text-gray-600">폐기 예상 손실 없음</span>
                  </div>
                )}
                {briefing.bestChannel && briefing.bestMargin > 0 ? (
                  <div className="flex items-center gap-2 text-sm">
                    <span className="text-blue-500 font-bold">💡</span>
                    <span className="text-gray-700">
                      최고 마진 채널 <span className="font-bold text-blue-700">{briefing.bestChannel}</span>
                      {' '}<span className="text-blue-600">{(briefing.bestMargin * 100).toFixed(1)}%</span>
                      {' '}&mdash; 기획세트 기준
                    </span>
                  </div>
                ) : (
                  <div className="flex items-center gap-2 text-sm">
                    <span className="text-gray-400">💡</span>
                    <span className="text-gray-400">기획세트 원가 데이터 입력 후 마진 분석 가능</span>
                  </div>
                )}
              </div>
            </div>
          )}

          {/* ── AI 커맨드 바 ── */}
          <div className="bg-white border border-gray-200 rounded-xl p-3 md:p-5 mb-4 shadow-sm">
            <p className="text-xs font-semibold text-gray-400 uppercase tracking-wide mb-3">💬 AI에게 바로 명령하세요</p>
            <form onSubmit={handleCommandSubmit} className="flex gap-3">
              <input
                ref={commandInputRef}
                type="text"
                value={command}
                onChange={e => setCommand(e.target.value)}
                placeholder="예: 쿠션 축축 기획 300개 올리브영 출고해줘"
                className="flex-1 border border-gray-200 rounded-xl px-4 py-3 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent bg-slate-50"
              />
              <button
                type="submit"
                disabled={!command.trim()}
                className="bg-blue-600 text-white px-5 py-3 rounded-xl text-sm font-medium hover:bg-blue-700 disabled:opacity-40 disabled:cursor-not-allowed transition"
              >
                전송
              </button>
            </form>
            {recentCmds.length > 0 && (
              <div className="flex flex-wrap gap-2 mt-3">
                {recentCmds.map((cmd, i) => (
                  <button
                    key={i}
                    onClick={() => setCommand(cmd)}
                    className="text-xs bg-slate-100 hover:bg-blue-50 hover:text-blue-600 text-gray-500 px-3 py-1.5 rounded-full transition"
                  >
                    {cmd}
                  </button>
                ))}
              </div>
            )}
          </div>

          {/* ── 재고 현황 + 최근 입출고 ── */}
          <div className="grid grid-cols-1 lg:grid-cols-5 gap-3 md:gap-6">

            {/* 재고 현황 */}
            <div className="lg:col-span-3 bg-white rounded-xl shadow-sm border border-gray-100">
              <div className="p-3 md:p-5 border-b border-gray-100 flex items-center gap-2">
                <h2 className="text-base font-semibold text-gray-900 shrink-0">재고 현황</h2>
                <input
                  type="text"
                  placeholder="제품명 검색..."
                  value={inventorySearch}
                  onChange={e => setInventorySearch(e.target.value)}
                  className="flex-1 border border-gray-200 rounded-lg px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-blue-400 bg-slate-50"
                />
                <div className="flex gap-1 bg-slate-100 rounded-lg p-1 shrink-0">
                  <button
                    onClick={() => setSelectedWarehouse('전체')}
                    className={`px-3 py-1 rounded-md text-xs font-medium transition ${selectedWarehouse === '전체' ? 'bg-white shadow text-gray-900' : 'text-gray-500 hover:text-gray-700'}`}
                  >
                    전체
                  </button>
                  {warehouses.map(w => (
                    <button
                      key={w.id}
                      onClick={() => setSelectedWarehouse(w.name)}
                      className={`px-3 py-1 rounded-md text-xs font-medium transition ${selectedWarehouse === w.name ? 'bg-white shadow text-gray-900' : 'text-gray-500 hover:text-gray-700'}`}
                    >
                      {w.name}
                    </button>
                  ))}
                </div>
              </div>
              <div className="p-3 md:p-5">
                {inventoryGroups.length === 0 ? (
                  <p className="text-gray-400 text-xs text-center py-6">등록된 재고가 없습니다.</p>
                ) : (
                  <div className="grid grid-cols-2 gap-2">
                    {inventoryGroups.map(group => {
                      const filtered = selectedWarehouse === '전체'
                        ? group.items
                        : group.items.filter(i => i.warehouses?.name === selectedWarehouse)
                      const qty = filtered.reduce((sum, i) => sum + i.quantity, 0)
                      return (
                        <div key={group.product?.id} className="flex items-center justify-between border border-gray-100 rounded-lg px-2.5 py-2 hover:border-blue-200 hover:bg-blue-50/30 transition">
                          <div className="min-w-0">
                            <p className="text-xs font-medium text-gray-900 truncate">{group.product?.product_name}</p>
                            <p className="text-xs text-gray-400">{group.product?.product_code}</p>
                          </div>
                          <span className="text-sm font-bold text-blue-600 shrink-0 ml-1">{qty.toLocaleString()}<span className="text-xs font-normal text-gray-400">개</span></span>
                        </div>
                      )
                    })}
                  </div>
                )}
              </div>
            </div>

            {/* 최근 입출고 */}
            <div className="lg:col-span-2 bg-white rounded-xl shadow-sm border border-gray-100">
              <div className="p-3 md:p-5 border-b border-gray-100">
                <h2 className="text-sm font-semibold text-gray-900">최근 입출고</h2>
              </div>
              <div className="p-3 md:p-5">
                {transactions.length === 0 ? (
                  <p className="text-gray-400 text-sm text-center py-8">입출고 기록이 없습니다.</p>
                ) : (
                  <div className="space-y-2">
                    {transactions.map(tx => {
                      const isTransfer = tx.type === '이동' || tx.note?.includes('[이동]')
                      const displayType = isTransfer ? '이동' : tx.type
                      return (
                        <div key={tx.id} className="flex items-center gap-2">
                          <span className={`shrink-0 text-xs font-semibold px-1.5 py-0.5 rounded ${
                            isTransfer ? 'bg-blue-100 text-blue-700'
                            : tx.type === '입고' ? 'bg-emerald-100 text-emerald-700'
                            : 'bg-red-100 text-red-700'
                          }`}>
                            {displayType}
                          </span>
                          <div className="flex-1 min-w-0">
                            <p className="text-xs font-medium text-gray-900 truncate">{tx.products?.product_name}</p>
                            <p className="text-xs text-gray-400 truncate">
                              {tx.channel || tx.warehouses?.name || '-'}
                            </p>
                          </div>
                          <div className="text-right shrink-0">
                            <p className={`text-xs font-bold ${
                              isTransfer ? 'text-blue-600'
                              : tx.type === '입고' ? 'text-emerald-600'
                              : 'text-red-600'
                            }`}>
                              {isTransfer ? '↔' : tx.type === '입고' ? '+' : '-'}{tx.quantity.toLocaleString()}
                            </p>
                            <p className="text-xs text-gray-400">{new Date(tx.created_at).toLocaleDateString('ko-KR')}</p>
                          </div>
                        </div>
                      )
                    })}
                  </div>
                )}
              </div>
            </div>

            {/* 조치 필요 배너 (최근 입출고 아래, 같은 열) */}
            {(actionAlerts.overdueCount > 0 || actionAlerts.evidenceCount > 0) && (
              <div className="lg:col-start-4 lg:col-span-2 bg-red-50 border border-red-200 rounded-xl p-3 md:p-5">
                <h2 className="text-sm font-semibold text-red-700 mb-2">⚠️ 조치 필요</h2>
                <div className="flex flex-col gap-1.5 text-sm">
                  {actionAlerts.overdueCount > 0 && (
                    <p className="text-red-700">
                      기한 초과 미기록/미달 <span className="font-bold">{actionAlerts.overdueCount}건</span>
                    </p>
                  )}
                  {actionAlerts.evidenceCount > 0 && (
                    <p className="text-red-700">
                      증빙 미첨부/불일치 <span className="font-bold">{actionAlerts.evidenceCount}건</span>
                    </p>
                  )}
                </div>
                <Link href="/exceptions" className="inline-block text-xs text-red-700 underline mt-2">
                  예외리스트에서 확인하기 →
                </Link>
              </div>
            )}

          </div>
        </div>
      </div>

      {/* ── Toast ── */}
      {toast && (
        <div className="fixed bottom-24 left-1/2 -translate-x-1/2 bg-gray-900 text-white text-sm px-5 py-3 rounded-xl shadow-lg z-50 animate-fade-in">
          {toast}
        </div>
      )}
    </>
  )
}
