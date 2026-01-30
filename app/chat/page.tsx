'use client'

import { useEffect, useState, useRef } from 'react'
import { supabase } from '@/lib/supabase'
import Link from 'next/link'

interface Product {
  id: string
  product_name: string
  product_code: string
}

interface Warehouse {
  id: string
  name: string
}

interface Message {
  role: 'user' | 'assistant'
  content: string
  data?: {
    action: string
    product_name?: string
    quantity?: number
    warehouse?: string
    channel?: string
  }
}

export default function ChatPage() {
  const [products, setProducts] = useState<Product[]>([])
  const [warehouses, setWarehouses] = useState<Warehouse[]>([])
  const [messages, setMessages] = useState<Message[]>([
    {
      role: 'assistant',
      content: '안녕하세요! 재고관리 AI입니다. 입출고를 도와드릴게요.\n\n예시:\n- "쿠션A 500개 올리브영 출고"\n- "핸드크림 1000개 충주창고 입고"\n- "쿠션 재고 얼마야?"'
    }
  ])
  const [input, setInput] = useState('')
  const [loading, setLoading] = useState(false)
  const [pendingAction, setPendingAction] = useState<Message['data'] | null>(null)
  const messagesEndRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    fetchData()
  }, [])

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages])

  async function fetchData() {
    const { data: productsData } = await supabase
      .from('products')
      .select('id, product_name, product_code')
      .eq('is_active', true)

    const { data: warehousesData } = await supabase
      .from('warehouses')
      .select('id, name')

    setProducts(productsData || [])
    setWarehouses(warehousesData || [])
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    if (!input.trim() || loading) return

    const userMessage = input.trim()
    setInput('')
    setMessages(prev => [...prev, { role: 'user', content: userMessage }])
    setLoading(true)

    try {
      const response = await fetch('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          message: userMessage,
          products,
          warehouses
        })
      })

      const data = await response.json()

      if (data.error) {
        setMessages(prev => [...prev, {
          role: 'assistant',
          content: '죄송합니다. 오류가 발생했습니다. 다시 시도해주세요.'
        }])
        return
      }

      if (data.action === '입고' || data.action === '출고') {
        setPendingAction(data)
        setMessages(prev => [...prev, {
          role: 'assistant',
          content: data.message || `${data.action} 요청:\n제품: ${data.product_name}\n수량: ${data.quantity?.toLocaleString()}개\n${data.warehouse ? `창고: ${data.warehouse}\n` : ''}${data.channel ? `채널: ${data.channel}\n` : ''}\n이대로 진행할까요?`,
          data
        }])
      } else if (data.action === '조회') {
        // 재고 조회
        const inventory = await getInventory(data.product_name)
        setMessages(prev => [...prev, {
          role: 'assistant',
          content: inventory
        }])
      } else {
        setMessages(prev => [...prev, {
          role: 'assistant',
          content: data.message || '요청을 이해하지 못했습니다. 다시 말씀해주세요.'
        }])
      }
    } catch (error) {
      console.error(error)
      setMessages(prev => [...prev, {
        role: 'assistant',
        content: '네트워크 오류가 발생했습니다.'
      }])
    } finally {
      setLoading(false)
    }
  }

  async function getInventory(productName: string) {
    const { data } = await supabase
      .from('inventory')
      .select(`
        quantity,
        products (product_name, product_code),
        warehouses (name)
      `)

    if (!data || data.length === 0) {
      return '등록된 재고가 없습니다.'
    }

    // 제품명으로 필터링
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const filtered = data.filter((item: any) =>
      item.products?.product_name?.includes(productName)
    )

    if (filtered.length === 0) {
      return `"${productName}" 관련 재고를 찾을 수 없습니다.`
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = filtered.map((item: any) =>
      `${item.products?.product_name} - ${item.warehouses?.name}: ${item.quantity.toLocaleString()}개`
    ).join('\n')

    return `재고 현황:\n${result}`
  }

  async function confirmAction() {
    if (!pendingAction) return

    setLoading(true)

    try {
      // 제품 찾기
      const product = products.find(p =>
        p.product_name.includes(pendingAction.product_name || '') ||
        p.product_code.includes(pendingAction.product_name || '')
      )

      if (!product) {
        setMessages(prev => [...prev, {
          role: 'assistant',
          content: `"${pendingAction.product_name}" 제품을 찾을 수 없습니다. 제품을 먼저 등록해주세요.`
        }])
        setPendingAction(null)
        return
      }

      // 창고 찾기 (기본값: 충주창고)
      const warehouse = warehouses.find(w =>
        w.name.includes(pendingAction.warehouse || '충주')
      ) || warehouses[0]

      if (!warehouse) {
        setMessages(prev => [...prev, {
          role: 'assistant',
          content: '창고를 찾을 수 없습니다.'
        }])
        setPendingAction(null)
        return
      }

      // 입출고 기록 저장
      const { error: txError } = await supabase
        .from('transactions')
        .insert([{
          product_id: product.id,
          warehouse_id: warehouse.id,
          type: pendingAction.action,
          quantity: pendingAction.quantity,
          channel: pendingAction.channel || null,
          note: 'AI 채팅으로 등록',
          recorded_by: 'AI'
        }])

      if (txError) throw txError

      // 재고 업데이트
      const { data: existingInv } = await supabase
        .from('inventory')
        .select('id, quantity')
        .eq('product_id', product.id)
        .eq('warehouse_id', warehouse.id)
        .single()

      if (existingInv) {
        const newQty = pendingAction.action === '입고'
          ? existingInv.quantity + (pendingAction.quantity || 0)
          : existingInv.quantity - (pendingAction.quantity || 0)

        await supabase
          .from('inventory')
          .update({ quantity: newQty })
          .eq('id', existingInv.id)
      } else if (pendingAction.action === '입고') {
        await supabase
          .from('inventory')
          .insert([{
            product_id: product.id,
            warehouse_id: warehouse.id,
            quantity: pendingAction.quantity
          }])
      }

      setMessages(prev => [...prev, {
        role: 'assistant',
        content: `✅ ${pendingAction.action} 완료!\n${product.product_name} ${pendingAction.quantity?.toLocaleString()}개가 ${pendingAction.action === '입고' ? '입고' : '출고'}되었습니다.`
      }])

      setPendingAction(null)
      fetchData()
    } catch (error) {
      console.error(error)
      setMessages(prev => [...prev, {
        role: 'assistant',
        content: '처리 중 오류가 발생했습니다.'
      }])
    } finally {
      setLoading(false)
    }
  }

  function cancelAction() {
    setPendingAction(null)
    setMessages(prev => [...prev, {
      role: 'assistant',
      content: '취소되었습니다. 다른 요청이 있으시면 말씀해주세요.'
    }])
  }

  return (
    <div className="min-h-screen bg-gray-50 flex flex-col">
      {/* 헤더 */}
      <header className="bg-white shadow p-4">
        <div className="max-w-3xl mx-auto flex justify-between items-center">
          <div>
            <Link href="/" className="text-blue-600 hover:underline text-sm">
              ← 대시보드로
            </Link>
            <h1 className="text-xl font-bold text-gray-900">AI 채팅 입출고</h1>
          </div>
        </div>
      </header>

      {/* 채팅 영역 */}
      <div className="flex-1 overflow-y-auto p-4">
        <div className="max-w-3xl mx-auto space-y-4">
          {messages.map((msg, idx) => (
            <div
              key={idx}
              className={`flex ${msg.role === 'user' ? 'justify-end' : 'justify-start'}`}
            >
              <div
                className={`max-w-[80%] rounded-lg p-4 ${
                  msg.role === 'user'
                    ? 'bg-blue-600 text-white'
                    : 'bg-white shadow'
                }`}
              >
                <pre className="whitespace-pre-wrap font-sans">{msg.content}</pre>
              </div>
            </div>
          ))}

          {/* 확인 버튼 */}
          {pendingAction && (
            <div className="flex justify-center gap-4">
              <button
                onClick={confirmAction}
                disabled={loading}
                className="bg-green-600 text-white px-6 py-2 rounded-lg hover:bg-green-700 disabled:opacity-50"
              >
                {loading ? '처리 중...' : '확인'}
              </button>
              <button
                onClick={cancelAction}
                disabled={loading}
                className="bg-gray-400 text-white px-6 py-2 rounded-lg hover:bg-gray-500 disabled:opacity-50"
              >
                취소
              </button>
            </div>
          )}

          {loading && !pendingAction && (
            <div className="flex justify-start">
              <div className="bg-white shadow rounded-lg p-4">
                <p className="text-gray-500">생각 중...</p>
              </div>
            </div>
          )}

          <div ref={messagesEndRef} />
        </div>
      </div>

      {/* 입력 영역 */}
      <div className="bg-white border-t p-4">
        <form onSubmit={handleSubmit} className="max-w-3xl mx-auto flex gap-2">
          <input
            type="text"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder="예: 쿠션A 500개 올리브영 출고"
            className="flex-1 border rounded-lg px-4 py-3 focus:outline-none focus:ring-2 focus:ring-blue-500"
            disabled={loading || !!pendingAction}
          />
          <button
            type="submit"
            disabled={loading || !input.trim() || !!pendingAction}
            className="bg-blue-600 text-white px-6 py-3 rounded-lg hover:bg-blue-700 disabled:opacity-50 transition"
          >
            전송
          </button>
        </form>
      </div>
    </div>
  )
}
