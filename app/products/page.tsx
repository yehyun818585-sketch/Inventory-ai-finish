'use client'

import { useEffect, useState } from 'react'
import { supabase } from '@/lib/supabase'
import { useAuth } from '@/app/contexts/AuthContext'
import Navbar from '@/app/components/Navbar'

interface Product {
  id: string
  product_group: string
  product_name: string
  product_code: string
  version: string
  unit_cost: number
  channel: string | null
  is_active: boolean
  track_expiry: boolean
  created_at: string
}

// 일괄 OFF 시 제외 대상 키워드 (세트/기획 가능성)
const SET_KEYWORDS = ['기획', '세트', '증정', '콜라보', '한정판', '에디션', '패키지', '선물', '기프트']

function hasSetKeyword(name: string): boolean {
  const lower = name.toLowerCase()
  return SET_KEYWORDS.some(kw => lower.includes(kw))
}

interface BulkPreview {
  groupName: string
  targetValue: boolean
  willChange: Product[]
  excluded: Product[]  // 키워드로 보호된 항목 (bulk OFF 시에만 발생)
}

export default function ProductsPage() {
  const { profile } = useAuth()
  const [products, setProducts] = useState<Product[]>([])
  const [loading, setLoading] = useState(true)
  const [showForm, setShowForm] = useState(false)
  const [editingCost, setEditingCost] = useState<{ id: string; value: string } | null>(null)
  const [bulkPreview, setBulkPreview] = useState<BulkPreview | null>(null)
  const [bulkApplying, setBulkApplying] = useState(false)

  const [formData, setFormData] = useState({
    product_group: '',
    product_name: '',
    product_code: '',
    version: '일반',
    unit_cost: 0,
    channel: ''
  })

  useEffect(() => {
    fetchProducts()
  }, [profile?.company_id]) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!profile?.company_id) return
    const channel = supabase
      .channel(`products-realtime-${profile.company_id}`)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'products' }, () => fetchProducts())
      .subscribe()
    return () => { supabase.removeChannel(channel) }
  }, [profile?.company_id]) // eslint-disable-line react-hooks/exhaustive-deps

  async function fetchProducts() {
    if (!profile?.company_id) return
    setLoading(true)
    const { data } = await supabase
      .from('products')
      .select('*')
      .eq('company_id', profile.company_id)
      .order('product_group', { ascending: true })
    setProducts(data || [])
    setLoading(false)
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    const { error } = await supabase.from('products').insert([{
      ...formData,
      unit_cost: Number(formData.unit_cost),
      company_id: profile?.company_id,
      track_expiry: true
    }])
    if (error) { alert('등록 실패: ' + error.message); return }
    alert('제품이 등록되었습니다!')
    setFormData({ product_group: '', product_name: '', product_code: '', version: '일반', unit_cost: 0, channel: '' })
    setShowForm(false)
    fetchProducts()
  }

  async function saveUnitCost(id: string, value: string) {
    const cost = Number(value)
    if (isNaN(cost) || cost < 0) return
    await supabase.from('products').update({ unit_cost: cost }).eq('id', id)
    setEditingCost(null)
    fetchProducts()
  }

  async function toggleActive(id: string, current: boolean) {
    const { error } = await supabase.from('products').update({ is_active: !current }).eq('id', id)
    if (error) { alert('상태 변경 실패: ' + error.message); return }
    fetchProducts()
  }

  async function toggleTrackExpiry(id: string, current: boolean) {
    const { error } = await supabase.from('products').update({ track_expiry: !current }).eq('id', id)
    if (error) { alert('유통기한 관리 변경 실패: ' + error.message); return }
    fetchProducts()
  }

  function prepareBulkToggle(groupName: string, targetValue: boolean, groupProds: Product[]) {
    const needsChange = groupProds.filter(p => p.track_expiry !== targetValue)

    let willChange: Product[]
    let excluded: Product[]

    if (!targetValue) {
      // 일괄 OFF: 세트/기획 키워드 포함 제품은 제외
      willChange = needsChange.filter(p => !hasSetKeyword(p.product_name))
      excluded = needsChange.filter(p => hasSetKeyword(p.product_name))
    } else {
      // 일괄 ON: 제외 없음
      willChange = needsChange
      excluded = []
    }

    setBulkPreview({ groupName, targetValue, willChange, excluded })
  }

  async function executeBulkToggle() {
    if (!bulkPreview) return
    if (bulkPreview.willChange.length === 0) { setBulkPreview(null); return }

    setBulkApplying(true)
    const { error } = await supabase
      .from('products')
      .update({ track_expiry: bulkPreview.targetValue })
      .in('id', bulkPreview.willChange.map(p => p.id))
    setBulkApplying(false)
    setBulkPreview(null)

    if (error) { alert('일괄 변경 실패: ' + error.message); return }
    fetchProducts()
  }

  // 제품군별 그룹핑
  const grouped = products.reduce<Record<string, Product[]>>((acc, p) => {
    const g = p.product_group || '(제품군 없음)'
    if (!acc[g]) acc[g] = []
    acc[g].push(p)
    return acc
  }, {})
  const groupNames = Object.keys(grouped).sort()

  if (loading) {
    return <div className="min-h-screen flex items-center justify-center"><p className="text-xl">로딩 중...</p></div>
  }

  return (
    <>
      <Navbar />
      <div className="min-h-screen bg-slate-50 pt-28 md:pt-20 p-4 md:p-8">
      <div className="max-w-6xl mx-auto">

        {/* 헤더 */}
        <div className="flex flex-wrap justify-between items-start gap-3 mb-6">
          <div>
            <h1 className="text-xl font-bold text-gray-900">제품 관리</h1>
            <p className="text-xs text-gray-400 mt-0.5">총 {products.length}개 · {groupNames.length}개 제품군</p>
          </div>
          <button
            onClick={() => setShowForm(!showForm)}
            className="bg-blue-600 text-white px-3 py-1.5 md:px-5 md:py-2 text-sm rounded-lg hover:bg-blue-700 transition shrink-0"
          >
            {showForm ? '취소' : '+ 제품 등록'}
          </button>
        </div>

        {/* 등록 폼 */}
        {showForm && (
          <div className="bg-white rounded-lg shadow p-6 mb-6">
            <h2 className="text-lg font-semibold mb-4">새 제품 등록</h2>
            <form onSubmit={handleSubmit} className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">제품군 *</label>
                <input type="text" required placeholder="예: 쿠션, 핸드크림"
                  value={formData.product_group}
                  onChange={(e) => setFormData({...formData, product_group: e.target.value})}
                  className="w-full border rounded-lg px-4 py-2 focus:outline-none focus:ring-2 focus:ring-blue-500"
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">제품명 *</label>
                <input type="text" required placeholder="예: 쿠션 A"
                  value={formData.product_name}
                  onChange={(e) => setFormData({...formData, product_name: e.target.value})}
                  className="w-full border rounded-lg px-4 py-2 focus:outline-none focus:ring-2 focus:ring-blue-500"
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">품번 *</label>
                <input type="text" required placeholder="예: CUSH-A-01"
                  value={formData.product_code}
                  onChange={(e) => setFormData({...formData, product_code: e.target.value})}
                  className="w-full border rounded-lg px-4 py-2 focus:outline-none focus:ring-2 focus:ring-blue-500"
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">버전</label>
                <select value={formData.version}
                  onChange={(e) => setFormData({...formData, version: e.target.value})}
                  className="w-full border rounded-lg px-4 py-2 focus:outline-none focus:ring-2 focus:ring-blue-500"
                >
                  <option value="일반">일반</option>
                  <option value="홈쇼핑용">홈쇼핑용</option>
                  <option value="라이브커머스용">라이브커머스용</option>
                </select>
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">원가 (원)</label>
                <input type="number" placeholder="예: 5000"
                  value={formData.unit_cost}
                  onChange={(e) => setFormData({...formData, unit_cost: Number(e.target.value)})}
                  className="w-full border rounded-lg px-4 py-2 focus:outline-none focus:ring-2 focus:ring-blue-500"
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">주요 판매 채널</label>
                <input type="text" placeholder="예: 올리브영"
                  value={formData.channel}
                  onChange={(e) => setFormData({...formData, channel: e.target.value})}
                  className="w-full border rounded-lg px-4 py-2 focus:outline-none focus:ring-2 focus:ring-blue-500"
                />
              </div>
              <div className="md:col-span-2">
                <button type="submit" className="w-full bg-green-600 text-white py-3 rounded-lg hover:bg-green-700 transition font-medium">
                  등록하기
                </button>
              </div>
            </form>
          </div>
        )}

        {/* 일괄 변경 확인 모달 */}
        {bulkPreview && (
          <div className="fixed inset-0 bg-black bg-opacity-40 flex items-center justify-center z-50 p-4">
            <div className="bg-white rounded-xl shadow-xl p-6 max-w-md w-full">
              <h3 className="font-bold text-gray-900 mb-4 text-base">일괄 변경 확인</h3>

              <div className="rounded-lg border p-4 mb-4 text-sm space-y-3">
                {bulkPreview.willChange.length > 0 ? (
                  <p className="text-gray-800">
                    <span className="font-semibold">{bulkPreview.groupName}</span> 제품군 중{' '}
                    <span className="font-bold text-blue-700">{bulkPreview.willChange.length}개</span>를 유통기한 관리{' '}
                    <span className={`font-bold ${bulkPreview.targetValue ? 'text-blue-600' : 'text-gray-500'}`}>
                      {bulkPreview.targetValue ? 'ON' : 'OFF'}
                    </span>으로 변경합니다.
                  </p>
                ) : (
                  <p className="text-gray-500">변경할 제품이 없습니다.</p>
                )}

                {bulkPreview.excluded.length > 0 && (
                  <div className="bg-orange-50 border border-orange-200 rounded px-3 py-2">
                    <p className="text-orange-800 font-medium text-xs mb-1">
                      세트/기획 가능성으로 {bulkPreview.excluded.length}개 제외:
                    </p>
                    <p className="text-orange-700 text-xs">
                      {bulkPreview.excluded.map(p => p.product_name).join(', ')}
                    </p>
                    <p className="text-orange-500 text-xs mt-1">※ 개별 토글로 직접 변경 가능</p>
                  </div>
                )}

                {bulkPreview.willChange.length > 0 && (
                  <div>
                    <p className="text-xs text-gray-500 mb-1">변경 대상:</p>
                    <div className="flex flex-wrap gap-1">
                      {bulkPreview.willChange.map(p => (
                        <span key={p.id} className="text-xs bg-gray-100 text-gray-700 px-2 py-0.5 rounded">
                          {p.product_name}
                        </span>
                      ))}
                    </div>
                  </div>
                )}
              </div>

              <div className="flex gap-3">
                <button
                  onClick={() => setBulkPreview(null)}
                  className="flex-1 px-4 py-2 border rounded-lg text-sm hover:bg-gray-50 transition"
                >
                  취소
                </button>
                <button
                  onClick={executeBulkToggle}
                  disabled={bulkApplying || bulkPreview.willChange.length === 0}
                  className="flex-1 px-4 py-2 bg-blue-600 text-white rounded-lg text-sm font-medium hover:bg-blue-700 transition disabled:opacity-50"
                >
                  {bulkApplying ? '적용 중...' : '적용'}
                </button>
              </div>
            </div>
          </div>
        )}

        {/* 제품군별 목록 */}
        {products.length === 0 ? (
          <div className="bg-white rounded-lg shadow p-8">
            <p className="text-gray-500 text-center">등록된 제품이 없습니다.</p>
          </div>
        ) : (
          <div className="space-y-4">
            {groupNames.map(groupName => {
              const groupProds = grouped[groupName]
              const onCount = groupProds.filter(p => p.track_expiry).length
              const offCount = groupProds.length - onCount

              return (
                <div key={groupName} className="bg-white rounded-lg shadow overflow-hidden">
                  {/* 제품군 헤더 */}
                  <div className="px-4 py-3 bg-gray-50 border-b flex items-center justify-between gap-2">
                    <div className="flex items-center gap-2 min-w-0">
                      <span className="font-semibold text-gray-800 text-sm">{groupName}</span>
                      <span className="text-xs text-gray-400 shrink-0">{groupProds.length}개</span>
                      {onCount > 0 && (
                        <span className="text-xs bg-blue-100 text-blue-700 px-1.5 py-0.5 rounded shrink-0">ON {onCount}</span>
                      )}
                      {offCount > 0 && (
                        <span className="text-xs bg-gray-200 text-gray-500 px-1.5 py-0.5 rounded shrink-0">OFF {offCount}</span>
                      )}
                    </div>
                    <div className="flex items-center gap-1.5 shrink-0">
                      <span className="text-xs text-gray-400 hidden sm:inline">일괄</span>
                      <button
                        onClick={() => prepareBulkToggle(groupName, true, groupProds)}
                        className="text-xs px-2.5 py-1 rounded bg-blue-100 text-blue-700 hover:bg-blue-200 transition font-medium"
                      >
                        전체 ON
                      </button>
                      <button
                        onClick={() => prepareBulkToggle(groupName, false, groupProds)}
                        className="text-xs px-2.5 py-1 rounded bg-gray-100 text-gray-600 hover:bg-gray-200 transition font-medium"
                      >
                        전체 OFF
                      </button>
                    </div>
                  </div>

                  {/* 모바일 */}
                  <div className="md:hidden divide-y">
                    {groupProds.map(product => (
                      <div key={product.id} className={`flex items-center justify-between px-4 py-2.5 ${!product.is_active ? 'opacity-50' : ''}`}>
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center gap-1">
                            <span className="font-medium text-sm text-gray-900 truncate">{product.product_name}</span>
                            {hasSetKeyword(product.product_name) && (
                              <span className="text-orange-400 text-xs shrink-0" title="세트/기획 가능성">⚠</span>
                            )}
                          </div>
                          <div className="text-xs text-gray-400 mt-0.5">{product.product_code}</div>
                        </div>
                        <div className="flex items-center gap-1.5 shrink-0 ml-2">
                          <button
                            onClick={() => toggleTrackExpiry(product.id, product.track_expiry)}
                            className={`text-xs px-2 py-0.5 rounded font-medium ${product.track_expiry ? 'bg-blue-100 text-blue-800' : 'bg-gray-100 text-gray-500'}`}
                          >
                            {product.track_expiry ? 'ON' : 'OFF'}
                          </button>
                          <button
                            onClick={() => toggleActive(product.id, product.is_active)}
                            className={`text-xs px-2 py-0.5 rounded font-medium ${product.is_active ? 'bg-green-100 text-green-800' : 'bg-red-100 text-red-800'}`}
                          >
                            {product.is_active ? '활성' : '비활성'}
                          </button>
                        </div>
                      </div>
                    ))}
                  </div>

                  {/* 데스크탑 테이블 */}
                  <div className="hidden md:block overflow-x-auto">
                    <table className="w-full min-w-[580px]">
                      <thead>
                        <tr className="text-left text-xs text-gray-400 border-b bg-white">
                          <th className="py-2 pl-4 pr-2 font-medium">제품명</th>
                          <th className="py-2 px-2 font-medium">품번</th>
                          <th className="py-2 px-2 font-medium">버전</th>
                          <th className="py-2 px-2 font-medium">원가</th>
                          <th className="py-2 px-2 font-medium">채널</th>
                          <th className="py-2 px-2 font-medium">유통기한 관리</th>
                          <th className="py-2 px-2 font-medium">상태</th>
                        </tr>
                      </thead>
                      <tbody>
                        {groupProds.map(product => (
                          <tr key={product.id} className={`border-b last:border-b-0 hover:bg-gray-50 ${!product.is_active ? 'opacity-50' : ''}`}>
                            <td className="py-2.5 pl-4 pr-2 text-sm font-medium text-gray-900">
                              <span className="flex items-center gap-1">
                                {product.product_name}
                                {hasSetKeyword(product.product_name) && (
                                  <span className="text-orange-400 text-xs" title="세트/기획 가능성 — 일괄 OFF 자동 제외">⚠</span>
                                )}
                              </span>
                            </td>
                            <td className="py-2.5 px-2 text-xs text-gray-500">{product.product_code}</td>
                            <td className="py-2.5 px-2">
                              <span className={`px-2 py-0.5 rounded text-xs ${
                                product.version === '홈쇼핑용' ? 'bg-purple-100 text-purple-800' :
                                product.version === '라이브커머스용' ? 'bg-orange-100 text-orange-800' :
                                'bg-gray-100 text-gray-700'
                              }`}>
                                {product.version}
                              </span>
                            </td>
                            <td className="py-2.5 px-2">
                              {editingCost?.id === product.id ? (
                                <div className="flex items-center gap-1">
                                  <input
                                    type="number"
                                    autoFocus
                                    value={editingCost.value}
                                    onChange={e => setEditingCost({ id: product.id, value: e.target.value })}
                                    onBlur={() => saveUnitCost(product.id, editingCost.value)}
                                    onKeyDown={e => {
                                      if (e.key === 'Enter') saveUnitCost(product.id, editingCost.value)
                                      if (e.key === 'Escape') setEditingCost(null)
                                    }}
                                    className="w-20 border rounded px-2 py-0.5 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
                                  />
                                  <span className="text-xs text-gray-400">원</span>
                                </div>
                              ) : (
                                <button
                                  onClick={() => setEditingCost({ id: product.id, value: String(product.unit_cost) })}
                                  className="text-left hover:bg-blue-50 px-2 py-0.5 rounded transition"
                                >
                                  {product.unit_cost > 0
                                    ? <span className="text-sm">{product.unit_cost.toLocaleString()}원</span>
                                    : <span className="text-xs text-gray-400">미입력</span>
                                  }
                                </button>
                              )}
                            </td>
                            <td className="py-2.5 px-2 text-xs text-gray-500">{product.channel || '-'}</td>
                            <td className="py-2.5 px-2">
                              <button
                                onClick={() => toggleTrackExpiry(product.id, product.track_expiry)}
                                className={`px-3 py-1 rounded text-xs font-medium transition ${
                                  product.track_expiry
                                    ? 'bg-blue-100 text-blue-800 hover:bg-blue-200'
                                    : 'bg-gray-100 text-gray-500 hover:bg-gray-200'
                                }`}
                              >
                                {product.track_expiry ? 'ON' : 'OFF'}
                              </button>
                            </td>
                            <td className="py-2.5 px-2">
                              <button
                                onClick={() => toggleActive(product.id, product.is_active)}
                                className={`px-3 py-1 rounded text-xs font-medium transition ${
                                  product.is_active
                                    ? 'bg-green-100 text-green-800 hover:bg-green-200'
                                    : 'bg-red-100 text-red-800 hover:bg-red-200'
                                }`}
                              >
                                {product.is_active ? '활성' : '비활성'}
                              </button>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
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
