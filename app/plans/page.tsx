'use client'

import { useEffect, useState } from 'react'
import { supabase } from '@/lib/supabase'
import { useAuth } from '@/app/contexts/AuthContext'
import Navbar from '@/app/components/Navbar'

interface Product {
  id: string
  product_name: string
  product_code: string
  unit_cost: number
}

interface PlanStockOption {
  product_id: string
  product_name: string
  product_code: string
  unit_cost: number        // 이 옵션의 원가
  stock_type: '일반' | '기획용'
  available_qty: number    // 현재 재고량
}

interface PlanItem {
  id?: string
  product_id: string
  stock_type?: '일반' | '기획용'
  quantity: number
  unit_cost: number
  product?: Product
  products?: Product
}

interface Plan {
  id: string
  name: string
  channel: string
  commission_rate: number
  event_discount_rate: number
  selling_price: number
  target_margin_rate: number
  assembly_cost: number
  total_cost: number
  is_active: boolean
  created_at: string
  plan_items?: PlanItem[]
}

// 정산 계산 함수
function calcSettlement(
  sellingPrice: number,
  commissionRate: number,
  eventDiscountRate: number,
  totalCost: number
) {
  const commission = sellingPrice * (commissionRate / 100)
  const eventDiscount = sellingPrice * (eventDiscountRate / 100)
  const netRevenue = sellingPrice - commission - eventDiscount
  const profit = netRevenue - totalCost
  const marginRate = sellingPrice > 0 ? (profit / sellingPrice) * 100 : 0
  return { commission, eventDiscount, netRevenue, profit, marginRate }
}

// 역산: 목표 마진율 달성을 위한 최소 판매가
function calcMinSellingPrice(
  totalCost: number,
  commissionRate: number,
  eventDiscountRate: number,
  targetMarginRate: number
) {
  // netRevenue = price * (1 - commission% - eventDiscount%)
  // profit = netRevenue - totalCost = price * (1 - c - e) - totalCost
  // marginRate = profit / price = (1 - c - e) - totalCost/price
  // targetMargin = (1 - c - e) - totalCost/price
  // totalCost/price = (1 - c - e) - targetMargin
  // price = totalCost / ((1 - c - e) - targetMargin)
  const c = commissionRate / 100
  const e = eventDiscountRate / 100
  const t = targetMarginRate / 100
  const denominator = (1 - c - e) - t
  if (denominator <= 0) return null
  return Math.ceil(totalCost / denominator)
}

// 역산: 현재 판매가에서 목표 마진 확보를 위한 최대 원가
function calcMaxCost(
  sellingPrice: number,
  commissionRate: number,
  eventDiscountRate: number,
  targetMarginRate: number
) {
  const c = commissionRate / 100
  const e = eventDiscountRate / 100
  const t = targetMarginRate / 100
  const netRevenue = sellingPrice * (1 - c - e)
  const maxCost = netRevenue - sellingPrice * t
  return Math.floor(maxCost)
}

export default function PlansPage() {
  const { profile } = useAuth()
  const [plans, setPlans] = useState<Plan[]>([])
  const [products, setProducts] = useState<Product[]>([])
  const [stockOptions, setStockOptions] = useState<PlanStockOption[]>([])
  const [loading, setLoading] = useState(true)
  const [showForm, setShowForm] = useState(false)
  const [expandedPlan, setExpandedPlan] = useState<string | null>(null)

  const [formData, setFormData] = useState({
    name: '',
    channel: '',
    commission_rate: 0,
    event_discount_rate: 0,
    selling_price: 0,
    target_margin_rate: 20,
    assembly_cost: 0,
  })
  const [planItems, setPlanItems] = useState<PlanItem[]>([
    { product_id: '', stock_type: '일반', quantity: 1, unit_cost: 0 }
  ])

  useEffect(() => {
    fetchData()
  }, [profile?.company_id])

  async function fetchData() {
    if (!profile?.company_id) return
    setLoading(true)

    const [{ data: plansData }, { data: productsData }, { data: invData }] = await Promise.all([
      supabase
        .from('product_plans')
        .select('*')
        .eq('company_id', profile.company_id)
        .order('created_at', { ascending: false }),
      supabase
        .from('products')
        .select('id, product_name, product_code, unit_cost')
        .eq('company_id', profile.company_id)
        .eq('is_active', true),
      supabase
        .from('inventory')
        .select('product_id, quantity, stock_type, lot_unit_cost, products(product_name, product_code, unit_cost)')
        .eq('company_id', profile.company_id)
        .eq('stock_type', '기획용')
        .gt('quantity', 0),
    ])

    const prodList = (productsData || []) as Product[]

    // plan_items를 plan_id 목록으로 필터링해서 별도 조회
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const planIds = (plansData || []).map((p: any) => p.id)
    const { data: planItemsData } = planIds.length > 0
      ? await supabase.from('plan_items').select('id, plan_id, product_id, quantity, unit_cost').in('plan_id', planIds)
      : { data: [] }

    // plan_items를 plan별로 매핑
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const itemsByPlan: Record<string, PlanItem[]> = {}
    ;(planItemsData || []).forEach((item: any) => {
      if (!itemsByPlan[item.plan_id]) itemsByPlan[item.plan_id] = []
      itemsByPlan[item.plan_id].push({
        id: item.id,
        product_id: item.product_id,
        quantity: item.quantity,
        unit_cost: item.unit_cost,
      })
    })

    // plans에 plan_items 합치기
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const plansWithItems = (plansData || []).map((plan: any) => ({
      ...plan,
      plan_items: itemsByPlan[plan.id] || []
    }))

    setPlans(plansWithItems)
    setProducts(prodList)

    // 기획용 재고를 제품별로 집계해서 옵션 생성
    const planOptions: PlanStockOption[] = []

    // 일반 옵션 (모든 제품)
    prodList.forEach(p => {
      planOptions.push({
        product_id: p.id,
        product_name: p.product_name,
        product_code: p.product_code,
        unit_cost: p.unit_cost,
        stock_type: '일반',
        available_qty: 0
      })
    })

    // 기획용 옵션 (재고 있는 것만, 제품별 집계)
    const planInvMap: Record<string, { qty: number; cost: number }> = {}
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ;(invData || []).forEach((inv: any) => {
      const pid = inv.product_id
      if (!planInvMap[pid]) planInvMap[pid] = { qty: 0, cost: inv.lot_unit_cost || inv.products?.unit_cost || 0 }
      planInvMap[pid].qty += inv.quantity
    })

    Object.entries(planInvMap).forEach(([pid, { qty, cost }]) => {
      const prod = prodList.find(p => p.id === pid)
      if (!prod) return
      planOptions.push({
        product_id: pid,
        product_name: prod.product_name,
        product_code: prod.product_code,
        unit_cost: cost,
        stock_type: '기획용',
        available_qty: qty
      })
    })

    setStockOptions(planOptions)
    setLoading(false)
  }

  function calcTotalCost(items: PlanItem[], assemblyCost: number) {
    return items.reduce((sum, item) => sum + item.unit_cost * item.quantity, 0) + assemblyCost
  }

  function handleProductSelect(index: number, compositeKey: string) {
    // compositeKey = "product_id:stock_type"
    const [productId, stockType] = compositeKey.split(':') as [string, '일반' | '기획용']
    const option = stockOptions.find(o => o.product_id === productId && o.stock_type === stockType)
    const updated = [...planItems]
    updated[index] = {
      ...updated[index],
      product_id: productId,
      stock_type: stockType,
      unit_cost: option?.unit_cost || 0
    }
    setPlanItems(updated)
  }

  function handleItemChange(index: number, field: keyof PlanItem, value: string | number) {
    const updated = [...planItems]
    updated[index] = { ...updated[index], [field]: value }
    setPlanItems(updated)
  }

  function addItem() {
    setPlanItems([...planItems, { product_id: '', stock_type: '일반', quantity: 1, unit_cost: 0 }])
  }

  function removeItem(index: number) {
    setPlanItems(planItems.filter((_, i) => i !== index))
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    const validItems = planItems.filter(item => item.product_id)
    if (validItems.length === 0) {
      alert('구성품을 최소 1개 이상 추가해주세요.')
      return
    }

    const totalCost = calcTotalCost(validItems, formData.assembly_cost)

    const { data: planData, error: planError } = await supabase
      .from('product_plans')
      .insert([{
        name: formData.name,
        channel: formData.channel,
        commission_rate: formData.commission_rate / 100,
        event_discount_rate: formData.event_discount_rate / 100,
        selling_price: formData.selling_price,
        target_margin_rate: formData.target_margin_rate / 100,
        assembly_cost: formData.assembly_cost,
        total_cost: totalCost,
        company_id: profile?.company_id
      }])
      .select('id')
      .single()

    if (planError || !planData) {
      alert('저장 실패: ' + planError?.message)
      return
    }

    const { error: itemsError } = await supabase.from('plan_items').insert(
      validItems.map(item => ({
        plan_id: planData.id,
        product_id: item.product_id,
        quantity: item.quantity,
        unit_cost: item.unit_cost
      }))
    )
    if (itemsError) {
      alert('구성품 저장 실패: ' + itemsError.message)
      return
    }

    setFormData({ name: '', channel: '', commission_rate: 0, event_discount_rate: 0, selling_price: 0, target_margin_rate: 20, assembly_cost: 0 })
    setPlanItems([{ product_id: '', quantity: 1, unit_cost: 0 }])
    setShowForm(false)
    fetchData()
  }

  async function toggleActive(id: string, current: boolean) {
    await supabase.from('product_plans').update({ is_active: !current }).eq('id', id)
    fetchData()
  }

  async function deletePlan(id: string, name: string) {
    if (!confirm(`"${name}" 기획을 삭제하시겠습니까?\n구성품(BOM) 데이터도 함께 삭제됩니다.`)) return
    await supabase.from('plan_items').delete().eq('plan_id', id)
    await supabase.from('product_plans').delete().eq('id', id)
    fetchData()
  }

  // 폼 미리보기 계산
  const validItems = planItems.filter(i => i.product_id)
  const previewCost = calcTotalCost(validItems, formData.assembly_cost)
  const preview = calcSettlement(formData.selling_price, formData.commission_rate, formData.event_discount_rate, previewCost)
  const minPrice = calcMinSellingPrice(previewCost, formData.commission_rate, formData.event_discount_rate, formData.target_margin_rate)
  const maxCost = formData.selling_price > 0 ? calcMaxCost(formData.selling_price, formData.commission_rate, formData.event_discount_rate, formData.target_margin_rate) : null

  if (loading) return (
    <div className="min-h-screen flex items-center justify-center">
      <p className="text-gray-500">로딩 중...</p>
    </div>
  )

  return (
    <>
      <Navbar />
      <div className="min-h-screen bg-slate-50 pt-24 md:pt-20 p-4 md:p-6">
      <div className="max-w-5xl mx-auto">
        {/* 헤더 */}
        <div className="flex justify-between items-center mb-6">
          <div>
            <h1 className="text-2xl font-bold text-gray-900">기획 관리</h1>
            <p className="text-sm text-gray-500 mt-1">채널별 기획세트 구성 · 원가 · 정산 시뮬레이션</p>
          </div>
          <button
            onClick={() => setShowForm(!showForm)}
            className="bg-blue-600 text-white px-5 py-2.5 rounded-lg hover:bg-blue-700 transition text-sm font-medium"
          >
            {showForm ? '취소' : '+ 새 기획 등록'}
          </button>
        </div>

        {/* 등록 폼 */}
        {showForm && (
          <div className="bg-white rounded-xl shadow p-6 mb-6">
            <h2 className="text-lg font-semibold mb-5">새 기획 등록</h2>
            <form onSubmit={handleSubmit} className="space-y-6">

              {/* 기본 정보 */}
              <div>
                <h3 className="text-sm font-semibold text-gray-500 uppercase tracking-wide mb-3">기획 기본 정보</h3>
                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-1">기획명 *</label>
                    <input type="text" required placeholder="예: 올리브영 10월 1+1 기획"
                      value={formData.name}
                      onChange={e => setFormData({ ...formData, name: e.target.value })}
                      className="w-full border rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500" />
                  </div>
                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-1">채널 *</label>
                    <input type="text" required placeholder="예: 올리브영, 홈쇼핑, 자사몰"
                      value={formData.channel}
                      onChange={e => setFormData({ ...formData, channel: e.target.value })}
                      className="w-full border rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500" />
                  </div>
                </div>
              </div>

              {/* 구성품 */}
              <div>
                <div className="flex justify-between items-center mb-3">
                  <h3 className="text-sm font-semibold text-gray-500 uppercase tracking-wide">구성품 (BOM)</h3>
                  <button type="button" onClick={addItem} className="text-blue-600 text-sm hover:underline">+ 구성품 추가</button>
                </div>
                <div className="space-y-2">
                  {planItems.map((item, index) => (
                    <div key={index} className="flex gap-2 items-center">
                      <select
                        value={item.product_id ? `${item.product_id}:${item.stock_type || '일반'}` : ''}
                        onChange={e => handleProductSelect(index, e.target.value)}
                        className="flex-1 border rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500">
                        <option value="">제품 선택</option>
                        <optgroup label="일반 재고">
                          {stockOptions.filter(o => o.stock_type === '일반').map(o => (
                            <option key={`${o.product_id}:일반`} value={`${o.product_id}:일반`}>
                              {o.product_name} ({o.product_code}) — {o.unit_cost.toLocaleString()}원
                            </option>
                          ))}
                        </optgroup>
                        {stockOptions.some(o => o.stock_type === '기획용') && (
                          <optgroup label="기획용 재고">
                            {stockOptions.filter(o => o.stock_type === '기획용').map(o => (
                              <option key={`${o.product_id}:기획용`} value={`${o.product_id}:기획용`}>
                                {o.product_name} ({o.product_code}) — {o.unit_cost.toLocaleString()}원 (재고 {o.available_qty.toLocaleString()}개)
                              </option>
                            ))}
                          </optgroup>
                        )}
                      </select>
                      <span className="text-sm text-gray-400">×</span>
                      <input type="number" min="1" value={item.quantity}
                        onChange={e => handleItemChange(index, 'quantity', Number(e.target.value))}
                        className="w-16 border rounded-lg px-2 py-2 text-sm text-center focus:outline-none focus:ring-2 focus:ring-blue-500" />
                      <span className="text-sm text-gray-600 w-24 text-right whitespace-nowrap">
                        {(item.unit_cost * item.quantity).toLocaleString()}원
                      </span>
                      {planItems.length > 1 && (
                        <button type="button" onClick={() => removeItem(index)} className="text-red-400 hover:text-red-600 text-xl leading-none">×</button>
                      )}
                    </div>
                  ))}
                </div>
                <div className="mt-3 grid grid-cols-2 gap-4">
                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-1">공임비 / 간접비 (원)</label>
                    <input type="number" min="0" placeholder="예: 500"
                      value={formData.assembly_cost}
                      onChange={e => setFormData({ ...formData, assembly_cost: Number(e.target.value) })}
                      className="w-full border rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500" />
                  </div>
                  <div className="flex items-end">
                    <div className="bg-gray-100 rounded-lg px-4 py-2 text-sm w-full">
                      <span className="text-gray-500">총 출고원가</span>
                      <span className="float-right font-bold text-gray-900">{previewCost.toLocaleString()}원</span>
                    </div>
                  </div>
                </div>
              </div>

              {/* 정산 시뮬레이터 */}
              <div>
                <h3 className="text-sm font-semibold text-gray-500 uppercase tracking-wide mb-3">정산 시뮬레이터</h3>
                <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-4">
                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-1">소비자 판매가 (원)</label>
                    <input type="number" min="0" placeholder="예: 15000"
                      value={formData.selling_price || ''}
                      onChange={e => setFormData({ ...formData, selling_price: Number(e.target.value) })}
                      className="w-full border rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500" />
                  </div>
                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-1">채널 수수료율 (%)</label>
                    <input type="number" min="0" max="100" placeholder="예: 35"
                      value={formData.commission_rate || ''}
                      onChange={e => setFormData({ ...formData, commission_rate: Number(e.target.value) })}
                      className="w-full border rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500" />
                  </div>
                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-1">행사 할인 분담율 (%)</label>
                    <input type="number" min="0" max="100" placeholder="예: 10"
                      value={formData.event_discount_rate || ''}
                      onChange={e => setFormData({ ...formData, event_discount_rate: Number(e.target.value) })}
                      className="w-full border rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500" />
                  </div>
                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-1">목표 마진율 (%)</label>
                    <input type="number" min="0" max="100" placeholder="예: 20"
                      value={formData.target_margin_rate || ''}
                      onChange={e => setFormData({ ...formData, target_margin_rate: Number(e.target.value) })}
                      className="w-full border rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500" />
                  </div>
                </div>

                {/* 정산 결과 */}
                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                  {/* 정산 내역 */}
                  <div className="bg-gray-50 rounded-lg p-4 text-sm space-y-1.5">
                    <div className="font-semibold text-gray-700 mb-2">정산 내역</div>
                    <div className="flex justify-between text-gray-700">
                      <span>소비자 판매가</span>
                      <span className="font-medium">{formData.selling_price.toLocaleString()}원</span>
                    </div>
                    <div className="flex justify-between text-red-500">
                      <span>(-) 채널 수수료 {formData.commission_rate}%</span>
                      <span>-{preview.commission.toLocaleString()}원</span>
                    </div>
                    <div className="flex justify-between text-orange-500">
                      <span>(-) 행사 분담 {formData.event_discount_rate}%</span>
                      <span>-{preview.eventDiscount.toLocaleString()}원</span>
                    </div>
                    <div className="flex justify-between font-semibold text-gray-800 border-t pt-1.5">
                      <span>순매출(실수령액)</span>
                      <span>{preview.netRevenue.toLocaleString()}원</span>
                    </div>
                    <div className="flex justify-between text-gray-600">
                      <span>(-) 총 출고원가</span>
                      <span>-{previewCost.toLocaleString()}원</span>
                    </div>
                    <div className={`flex justify-between font-bold border-t pt-1.5 ${preview.profit >= 0 ? 'text-blue-700' : 'text-red-600'}`}>
                      <span>영업이익</span>
                      <span>{preview.profit.toLocaleString()}원 ({preview.marginRate.toFixed(1)}%)</span>
                    </div>
                    {preview.profit < 0 && (
                      <div className="mt-2 text-xs text-red-500 bg-red-50 rounded p-2">
                        ⚠️ 현재 구조에서는 판매할수록 손해입니다
                      </div>
                    )}
                  </div>

                  {/* 역산 결과 */}
                  <div className="bg-blue-50 rounded-lg p-4 text-sm space-y-3">
                    <div className="font-semibold text-blue-800 mb-2">역산 — 목표 마진 {formData.target_margin_rate}% 달성하려면</div>
                    <div>
                      <div className="text-gray-500 text-xs mb-1">최소 판매가</div>
                      <div className="text-lg font-bold text-blue-700">
                        {minPrice !== null ? `${minPrice.toLocaleString()}원 이상` : '—'}
                      </div>
                      {minPrice !== null && formData.selling_price > 0 && (
                        <div className={`text-xs mt-0.5 ${formData.selling_price >= minPrice ? 'text-green-600' : 'text-red-500'}`}>
                          {formData.selling_price >= minPrice
                            ? `✓ 현재 판매가 달성 가능`
                            : `✗ ${(minPrice - formData.selling_price).toLocaleString()}원 부족`}
                        </div>
                      )}
                    </div>
                    <div className="border-t border-blue-200 pt-3">
                      <div className="text-gray-500 text-xs mb-1">최대 허용 원가 (현재 판매가 기준)</div>
                      <div className="text-lg font-bold text-blue-700">
                        {maxCost !== null && maxCost > 0 ? `${maxCost.toLocaleString()}원 이하` : '—'}
                      </div>
                      {maxCost !== null && maxCost > 0 && (
                        <div className={`text-xs mt-0.5 ${previewCost <= maxCost ? 'text-green-600' : 'text-red-500'}`}>
                          {previewCost <= maxCost
                            ? `✓ 현재 원가 적정 (여유 ${(maxCost - previewCost).toLocaleString()}원)`
                            : `✗ 원가 ${(previewCost - maxCost).toLocaleString()}원 초과`}
                        </div>
                      )}
                    </div>
                  </div>
                </div>
              </div>

              <button type="submit"
                className="w-full bg-green-600 text-white py-2.5 rounded-lg hover:bg-green-700 transition font-medium text-sm">
                기획 저장
              </button>
            </form>
          </div>
        )}

        {/* 기획 목록 */}
        {plans.length === 0 ? (
          <div className="bg-white rounded-xl shadow p-12 text-center text-gray-400">
            <p className="text-lg mb-1">등록된 기획이 없습니다</p>
            <p className="text-sm">위 버튼을 눌러 채널별 기획세트를 등록해보세요</p>
          </div>
        ) : (
          <div className="space-y-4">
            {plans.map(plan => {
              const commission = plan.total_cost * plan.commission_rate
              const eventDiscount = plan.selling_price * (plan.event_discount_rate || 0)
              const netRevenue = plan.selling_price - plan.selling_price * plan.commission_rate - eventDiscount
              const profit = netRevenue - plan.total_cost
              const marginRate = plan.selling_price > 0 ? (profit / plan.selling_price) * 100 : 0
              const isExpanded = expandedPlan === plan.id

              return (
                <div key={plan.id} className={`bg-white rounded-xl shadow overflow-hidden ${!plan.is_active ? 'opacity-60' : ''}`}>
                  <div className="p-5 cursor-pointer hover:bg-gray-50 transition"
                    onClick={() => setExpandedPlan(isExpanded ? null : plan.id)}>
                    <div className="flex items-start justify-between">
                      <div>
                        <div className="flex items-center gap-2 flex-wrap">
                          <h3 className="font-semibold text-gray-900">{plan.name}</h3>
                          <span className="bg-blue-100 text-blue-700 text-xs px-2 py-0.5 rounded-full">{plan.channel}</span>
                          {!plan.is_active && <span className="bg-gray-100 text-gray-500 text-xs px-2 py-0.5 rounded-full">비활성</span>}
                          {plan.selling_price > 0 && (
                            <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${profit >= 0 ? 'bg-green-100 text-green-700' : 'bg-red-100 text-red-600'}`}>
                              {profit >= 0 ? `마진 ${marginRate.toFixed(1)}%` : '적자'}
                            </span>
                          )}
                        </div>
                        <div className="flex gap-3 mt-1 text-sm text-gray-500 flex-wrap">
                          <span>구성품 {plan.plan_items?.length || 0}종</span>
                          <span>수수료 {(plan.commission_rate * 100).toFixed(0)}%</span>
                          {plan.event_discount_rate > 0 && <span>행사분담 {(plan.event_discount_rate * 100).toFixed(0)}%</span>}
                          <span>공임비 {plan.assembly_cost.toLocaleString()}원</span>
                        </div>
                      </div>
                      <div className="text-right shrink-0 ml-4">
                        <div className="text-xs text-gray-400">출고원가</div>
                        <div className="text-lg font-bold text-gray-900">{plan.total_cost.toLocaleString()}원</div>
                        {plan.selling_price > 0 && (
                          <>
                            <div className="text-xs text-gray-500">판매가 {plan.selling_price.toLocaleString()}원</div>
                            <div className={`text-sm font-semibold ${profit >= 0 ? 'text-blue-600' : 'text-red-500'}`}>
                              영업이익 {profit.toLocaleString()}원
                            </div>
                          </>
                        )}
                      </div>
                    </div>
                    <div className="text-xs text-gray-400 mt-2">{isExpanded ? '▲ 접기' : '▼ 상세 보기'}</div>
                  </div>

                  {isExpanded && (
                    <div className="border-t px-5 pb-5">
                      <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mt-4">
                        {/* 구성품 */}
                        <div>
                          <div className="text-sm font-medium text-gray-700 mb-2">구성품 (BOM)</div>
                          <table className="w-full text-sm">
                            <thead>
                              <tr className="text-gray-400 border-b text-xs">
                                <th className="text-left pb-1.5">제품</th>
                                <th className="text-center pb-1.5">수량</th>
                                <th className="text-right pb-1.5">소계</th>
                              </tr>
                            </thead>
                            <tbody>
                              {(plan.plan_items || []).map((item, i) => {
                                const prod = products.find(p => p.id === item.product_id)
                                return (
                                <tr key={i} className="border-b last:border-0">
                                  <td className="py-1.5">
                                    <div className="font-medium text-gray-800">
                                      {prod?.product_name || item.products?.product_name || '-'}
                                    </div>
                                    <div className="text-xs text-gray-400">{item.unit_cost.toLocaleString()}원/개</div>
                                  </td>
                                  <td className="text-center py-1.5 text-gray-600">× {item.quantity}</td>
                                  <td className="text-right py-1.5 font-medium">{(item.unit_cost * item.quantity).toLocaleString()}원</td>
                                </tr>
                                )})}
                              <tr className="text-gray-500 text-xs">
                                <td className="py-1.5">공임비</td><td></td>
                                <td className="text-right py-1.5">{plan.assembly_cost.toLocaleString()}원</td>
                              </tr>
                              <tr className="font-semibold border-t">
                                <td className="py-1.5">총 출고원가</td><td></td>
                                <td className="text-right py-1.5">{plan.total_cost.toLocaleString()}원</td>
                              </tr>
                            </tbody>
                          </table>
                        </div>

                        {/* 정산 내역 */}
                        {plan.selling_price > 0 && (
                          <div>
                            <div className="text-sm font-medium text-gray-700 mb-2">정산 내역</div>
                            <div className="bg-gray-50 rounded-lg p-3 text-sm space-y-1.5">
                              <div className="flex justify-between text-gray-700">
                                <span>소비자 판매가</span>
                                <span className="font-medium">{plan.selling_price.toLocaleString()}원</span>
                              </div>
                              <div className="flex justify-between text-red-500">
                                <span>(-) 수수료 {(plan.commission_rate * 100).toFixed(0)}%</span>
                                <span>-{(plan.selling_price * plan.commission_rate).toLocaleString()}원</span>
                              </div>
                              {plan.event_discount_rate > 0 && (
                                <div className="flex justify-between text-orange-500">
                                  <span>(-) 행사분담 {(plan.event_discount_rate * 100).toFixed(0)}%</span>
                                  <span>-{eventDiscount.toLocaleString()}원</span>
                                </div>
                              )}
                              <div className="flex justify-between font-medium text-gray-800 border-t pt-1.5">
                                <span>순매출(실수령액)</span>
                                <span>{netRevenue.toLocaleString()}원</span>
                              </div>
                              <div className="flex justify-between text-gray-600">
                                <span>(-) 총 출고원가</span>
                                <span>-{plan.total_cost.toLocaleString()}원</span>
                              </div>
                              <div className={`flex justify-between font-bold border-t pt-1.5 ${profit >= 0 ? 'text-blue-700' : 'text-red-600'}`}>
                                <span>영업이익</span>
                                <span>{profit.toLocaleString()}원 ({marginRate.toFixed(1)}%)</span>
                              </div>
                              {profit < 0 && (
                                <div className="text-xs text-red-500 bg-red-50 rounded p-2 mt-1">
                                  ⚠️ 판매할수록 손해인 구조입니다
                                </div>
                              )}
                            </div>
                          </div>
                        )}
                      </div>

                      <div className="flex justify-between mt-4">
                        <button onClick={() => deletePlan(plan.id, plan.name)}
                          className="text-sm px-4 py-1.5 rounded-lg border border-red-200 text-red-500 hover:bg-red-50 transition">
                          삭제
                        </button>
                        <button onClick={() => toggleActive(plan.id, plan.is_active)}
                          className={`text-sm px-4 py-1.5 rounded-lg border transition ${plan.is_active ? 'border-gray-300 text-gray-600 hover:bg-gray-50' : 'border-blue-300 text-blue-600 hover:bg-blue-50'}`}>
                          {plan.is_active ? '비활성화' : '활성화'}
                        </button>
                      </div>
                    </div>
                  )}
                </div>
              )
            })}
          </div>
        )}
      </div>
    </div>
    </>
  )
}
