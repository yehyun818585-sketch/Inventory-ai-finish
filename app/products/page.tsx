'use client'

import { useEffect, useState } from 'react'
import { supabase } from '@/lib/supabase'
import Link from 'next/link'

interface Product {
  id: string
  product_group: string
  product_name: string
  product_code: string
  version: string
  unit_cost: number
  channel: string | null
  is_active: boolean
  created_at: string
}

export default function ProductsPage() {
  const [products, setProducts] = useState<Product[]>([])
  const [loading, setLoading] = useState(true)
  const [showForm, setShowForm] = useState(false)

  // 폼 데이터
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
  }, [])

  async function fetchProducts() {
    setLoading(true)
    const { data } = await supabase
      .from('products')
      .select('*')
      .order('created_at', { ascending: false })

    setProducts(data || [])
    setLoading(false)
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()

    const { error } = await supabase
      .from('products')
      .insert([{
        ...formData,
        unit_cost: Number(formData.unit_cost)
      }])

    if (error) {
      alert('등록 실패: ' + error.message)
      return
    }

    alert('제품이 등록되었습니다!')
    setFormData({
      product_group: '',
      product_name: '',
      product_code: '',
      version: '일반',
      unit_cost: 0,
      channel: ''
    })
    setShowForm(false)
    fetchProducts()
  }

  async function toggleActive(id: string, currentStatus: boolean) {
    const { error } = await supabase
      .from('products')
      .update({ is_active: !currentStatus })
      .eq('id', id)

    if (error) {
      alert('상태 변경 실패: ' + error.message)
      return
    }

    fetchProducts()
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
        <div className="flex justify-between items-center mb-8">
          <div>
            <Link href="/" className="text-blue-600 hover:underline mb-2 inline-block">
              ← 대시보드로
            </Link>
            <h1 className="text-3xl font-bold text-gray-900">제품 관리</h1>
          </div>
          <button
            onClick={() => setShowForm(!showForm)}
            className="bg-blue-600 text-white px-6 py-3 rounded-lg hover:bg-blue-700 transition"
          >
            {showForm ? '취소' : '+ 제품 등록'}
          </button>
        </div>

        {/* 등록 폼 */}
        {showForm && (
          <div className="bg-white rounded-lg shadow p-6 mb-8">
            <h2 className="text-xl font-semibold mb-4">새 제품 등록</h2>
            <form onSubmit={handleSubmit} className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  제품군 *
                </label>
                <input
                  type="text"
                  required
                  placeholder="예: 쿠션, 핸드크림"
                  value={formData.product_group}
                  onChange={(e) => setFormData({...formData, product_group: e.target.value})}
                  className="w-full border rounded-lg px-4 py-2 focus:outline-none focus:ring-2 focus:ring-blue-500"
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  제품명 *
                </label>
                <input
                  type="text"
                  required
                  placeholder="예: 쿠션 A"
                  value={formData.product_name}
                  onChange={(e) => setFormData({...formData, product_name: e.target.value})}
                  className="w-full border rounded-lg px-4 py-2 focus:outline-none focus:ring-2 focus:ring-blue-500"
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  품번 *
                </label>
                <input
                  type="text"
                  required
                  placeholder="예: CUSH-A-01"
                  value={formData.product_code}
                  onChange={(e) => setFormData({...formData, product_code: e.target.value})}
                  className="w-full border rounded-lg px-4 py-2 focus:outline-none focus:ring-2 focus:ring-blue-500"
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  버전
                </label>
                <select
                  value={formData.version}
                  onChange={(e) => setFormData({...formData, version: e.target.value})}
                  className="w-full border rounded-lg px-4 py-2 focus:outline-none focus:ring-2 focus:ring-blue-500"
                >
                  <option value="일반">일반</option>
                  <option value="홈쇼핑용">홈쇼핑용</option>
                  <option value="라이브커머스용">라이브커머스용</option>
                </select>
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  원가 (원)
                </label>
                <input
                  type="number"
                  placeholder="예: 5000"
                  value={formData.unit_cost}
                  onChange={(e) => setFormData({...formData, unit_cost: Number(e.target.value)})}
                  className="w-full border rounded-lg px-4 py-2 focus:outline-none focus:ring-2 focus:ring-blue-500"
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  주요 판매 채널
                </label>
                <input
                  type="text"
                  placeholder="예: 올리브영"
                  value={formData.channel}
                  onChange={(e) => setFormData({...formData, channel: e.target.value})}
                  className="w-full border rounded-lg px-4 py-2 focus:outline-none focus:ring-2 focus:ring-blue-500"
                />
              </div>
              <div className="md:col-span-2">
                <button
                  type="submit"
                  className="w-full bg-green-600 text-white py-3 rounded-lg hover:bg-green-700 transition font-medium"
                >
                  등록하기
                </button>
              </div>
            </form>
          </div>
        )}

        {/* 제품 목록 */}
        <div className="bg-white rounded-lg shadow">
          <div className="p-6 border-b">
            <h2 className="text-xl font-semibold">제품 목록 ({products.length}개)</h2>
          </div>
          <div className="p-6">
            {products.length === 0 ? (
              <p className="text-gray-500 text-center py-8">
                등록된 제품이 없습니다. 위 버튼을 눌러 제품을 등록해주세요.
              </p>
            ) : (
              <table className="w-full">
                <thead>
                  <tr className="text-left text-gray-500 border-b">
                    <th className="pb-3">제품군</th>
                    <th className="pb-3">제품명</th>
                    <th className="pb-3">품번</th>
                    <th className="pb-3">버전</th>
                    <th className="pb-3">원가</th>
                    <th className="pb-3">채널</th>
                    <th className="pb-3">상태</th>
                  </tr>
                </thead>
                <tbody>
                  {products.map((product) => (
                    <tr key={product.id} className={`border-b ${!product.is_active ? 'opacity-50' : ''}`}>
                      <td className="py-4">{product.product_group}</td>
                      <td className="py-4 font-medium">{product.product_name}</td>
                      <td className="py-4 text-gray-500">{product.product_code}</td>
                      <td className="py-4">
                        <span className={`px-2 py-1 rounded text-sm ${
                          product.version === '홈쇼핑용' ? 'bg-purple-100 text-purple-800' :
                          product.version === '라이브커머스용' ? 'bg-orange-100 text-orange-800' :
                          'bg-gray-100 text-gray-800'
                        }`}>
                          {product.version}
                        </span>
                      </td>
                      <td className="py-4">{product.unit_cost.toLocaleString()}원</td>
                      <td className="py-4 text-gray-500">{product.channel || '-'}</td>
                      <td className="py-4">
                        <button
                          onClick={() => toggleActive(product.id, product.is_active)}
                          className={`px-3 py-1 rounded text-sm font-medium ${
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
            )}
          </div>
        </div>
      </div>
    </div>
  )
}
