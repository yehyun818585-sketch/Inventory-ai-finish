'use client'

import { useState, useEffect } from 'react'
import Link from 'next/link'
import { supabase } from '@/lib/supabase'
import { useAuth } from '@/app/contexts/AuthContext'
import Navbar from '@/app/components/Navbar'

interface CompanySettings {
  name: string
  industry: string
  default_shelf_life_months: number
  shelf_life_warning_ratio: number
  inventory_unit: string
  reconciliation_grace_days: number
  outbound_grace_days: number
  shipping_cutoff_time: string
}

const INDUSTRY_PRESETS: Record<string, { default_shelf_life_months: number; inventory_unit: string }> = {
  화장품: { default_shelf_life_months: 36, inventory_unit: '개' },
  냉동식품: { default_shelf_life_months: 12, inventory_unit: '박스' },
  기타: { default_shelf_life_months: 24, inventory_unit: '개' }
}

export default function SettingsPage() {
  const { profile } = useAuth()
  const [settings, setSettings] = useState<CompanySettings>({
    name: '',
    industry: '기타',
    default_shelf_life_months: 24,
    shelf_life_warning_ratio: 0.25,
    inventory_unit: '개',
    reconciliation_grace_days: 3,
    outbound_grace_days: 0,
    shipping_cutoff_time: '15:00'
  })
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    if (!profile?.company_id) return
    fetchSettings()
  }, [profile?.company_id])

  async function fetchSettings() {
    const { data } = await supabase
      .from('companies')
      .select('name, industry, default_shelf_life_months, shelf_life_warning_ratio, inventory_unit, reconciliation_grace_days, outbound_grace_days, shipping_cutoff_time')
      .eq('id', profile!.company_id!)
      .single()

    if (data) {
      setSettings({
        name: data.name || '',
        industry: data.industry || '기타',
        default_shelf_life_months: data.default_shelf_life_months || 24,
        shelf_life_warning_ratio: data.shelf_life_warning_ratio || 0.25,
        inventory_unit: data.inventory_unit || '개',
        reconciliation_grace_days: data.reconciliation_grace_days ?? 3,
        outbound_grace_days: data.outbound_grace_days ?? 0,
        shipping_cutoff_time: (data.shipping_cutoff_time || '15:00').slice(0, 5)
      })
    }
    setLoading(false)
  }

  function handleIndustryChange(industry: string) {
    const preset = INDUSTRY_PRESETS[industry]
    setSettings(prev => ({
      ...prev,
      industry,
      default_shelf_life_months: preset.default_shelf_life_months,
      inventory_unit: preset.inventory_unit
    }))
  }

  async function handleSave() {
    if (!profile?.company_id) return
    setSaving(true)

    console.log('💾 저장 시도:', { company_id: profile.company_id, ...settings })

    const { error, data } = await supabase
      .from('companies')
      .update({
        name: settings.name,
        industry: settings.industry,
        default_shelf_life_months: settings.default_shelf_life_months,
        shelf_life_warning_ratio: settings.shelf_life_warning_ratio,
        inventory_unit: settings.inventory_unit,
        reconciliation_grace_days: settings.reconciliation_grace_days,
        outbound_grace_days: settings.outbound_grace_days,
        shipping_cutoff_time: settings.shipping_cutoff_time
      })
      .eq('id', profile.company_id)
      .select()

    console.log('💾 저장 결과:', { error, data })

    setSaving(false)
    if (error) {
      alert('저장 실패: ' + error.message)
    } else {
      alert('설정이 저장되었습니다.')
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
    <>
      <Navbar />
      <div className="min-h-screen bg-slate-50 pt-28 md:pt-20 p-4 md:p-8">
      <div className="max-w-2xl mx-auto">
        <div className="mb-8">
          <h1 className="text-2xl font-bold text-gray-900">회사 설정</h1>
          <p className="text-gray-500 mt-1">업종 및 재고 관리 기준을 설정하세요</p>
        </div>

        <div className="bg-white rounded-lg shadow p-6 space-y-6">

          {/* 회사명 */}
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">회사명</label>
            <input
              type="text"
              value={settings.name}
              onChange={(e) => setSettings(prev => ({ ...prev, name: e.target.value }))}
              className="w-full border rounded-lg px-4 py-2 focus:outline-none focus:ring-2 focus:ring-blue-500"
            />
          </div>

          {/* 업종 */}
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-2">업종</label>
            <div className="grid grid-cols-3 gap-3">
              {Object.keys(INDUSTRY_PRESETS).map(ind => (
                <button
                  key={ind}
                  onClick={() => handleIndustryChange(ind)}
                  className={`p-3 rounded-lg border-2 text-sm font-medium transition ${
                    settings.industry === ind
                      ? 'border-blue-500 bg-blue-50 text-blue-700'
                      : 'border-gray-200 text-gray-600 hover:border-gray-300'
                  }`}
                >
                  {ind === '화장품' ? '💄 ' : ind === '냉동식품' ? '🧊 ' : '📦 '}
                  {ind}
                </button>
              ))}
            </div>
            <p className="text-xs text-gray-400 mt-2">업종 변경 시 아래 기본값이 자동으로 바뀝니다. 직접 수정도 가능해요.</p>
          </div>

          <hr />

          {/* 유통기한 기본값 */}
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">
              유통기한 기본값 (개월)
            </label>
            <p className="text-xs text-gray-400 mb-2">제품별 유통기한이 설정되지 않은 경우 이 값을 사용합니다</p>
            <input
              type="number"
              min="1"
              max="120"
              value={settings.default_shelf_life_months}
              onChange={(e) => setSettings(prev => ({ ...prev, default_shelf_life_months: Number(e.target.value) }))}
              className="w-32 border rounded-lg px-4 py-2 focus:outline-none focus:ring-2 focus:ring-blue-500"
            />
            <span className="ml-2 text-gray-500 text-sm">개월</span>
          </div>

          {/* 임박 기준 */}
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">
              유통기한 임박 기준
            </label>
            <p className="text-xs text-gray-400 mb-2">유통기한의 몇 % 이하일 때 임박으로 표시할지 설정합니다</p>
            <div className="flex items-center gap-3">
              {[10, 25, 33, 50].map(pct => (
                <button
                  key={pct}
                  onClick={() => setSettings(prev => ({ ...prev, shelf_life_warning_ratio: pct / 100 }))}
                  className={`px-4 py-2 rounded-lg border text-sm font-medium transition ${
                    Math.round(settings.shelf_life_warning_ratio * 100) === pct
                      ? 'border-blue-500 bg-blue-50 text-blue-700'
                      : 'border-gray-200 text-gray-600 hover:border-gray-300'
                  }`}
                >
                  {pct}%
                </button>
              ))}
            </div>
            <p className="text-xs text-gray-400 mt-2">
              현재: 유통기한 {settings.default_shelf_life_months}개월 기준 →{' '}
              <span className="font-medium text-orange-500">
                {Math.round(settings.default_shelf_life_months * settings.shelf_life_warning_ratio)}개월 이하
              </span>
              일 때 임박 표시
            </p>
          </div>

          {/* 재고 단위 */}
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">재고 단위</label>
            <p className="text-xs text-gray-400 mb-2">재고 수량 옆에 표시되는 단위입니다</p>
            <div className="flex gap-3">
              {['개', '박스', 'kg', 'L'].map(unit => (
                <button
                  key={unit}
                  onClick={() => setSettings(prev => ({ ...prev, inventory_unit: unit }))}
                  className={`px-4 py-2 rounded-lg border text-sm font-medium transition ${
                    settings.inventory_unit === unit
                      ? 'border-blue-500 bg-blue-50 text-blue-700'
                      : 'border-gray-200 text-gray-600 hover:border-gray-300'
                  }`}
                >
                  {unit}
                </button>
              ))}
              {/* 직접 입력 */}
              {!['개', '박스', 'kg', 'L'].includes(settings.inventory_unit) && (
                <input
                  type="text"
                  value={settings.inventory_unit}
                  onChange={(e) => setSettings(prev => ({ ...prev, inventory_unit: e.target.value }))}
                  className="w-20 border rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
                />
              )}
            </div>
          </div>

          <hr />

          {/* 미기록 유예일수(α) - 입고/이동 */}
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">
              미기록 유예일수 — 입고/이동 (α)
            </label>
            <p className="text-xs text-gray-400 mb-2">
              발주품의서/이동품의서의 납기·이동예정일로부터 며칠 지나야 미기록으로 적발할지 설정합니다 (거래처 등 외부 변수로 며칠 밀릴 수 있어 유예를 둡니다)
            </p>
            <input
              type="number"
              min="0"
              max="30"
              value={settings.reconciliation_grace_days}
              onChange={(e) => setSettings(prev => ({ ...prev, reconciliation_grace_days: Number(e.target.value) }))}
              className="w-32 border rounded-lg px-4 py-2 focus:outline-none focus:ring-2 focus:ring-blue-500"
            />
            <span className="ml-2 text-gray-500 text-sm">일</span>
          </div>

          {/* 미기록 유예일수 - 출고 */}
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">
              미기록 유예일수 — 출고
            </label>
            <p className="text-xs text-gray-400 mb-2">
              출고는 회사가 정한 마감 규칙으로 확정일이 정해지는 거라 외부 변수로 밀릴 여지가 거의 없습니다. 보통 0~1일을 권장합니다.
            </p>
            <input
              type="number"
              min="0"
              max="30"
              value={settings.outbound_grace_days}
              onChange={(e) => setSettings(prev => ({ ...prev, outbound_grace_days: Number(e.target.value) }))}
              className="w-32 border rounded-lg px-4 py-2 focus:outline-none focus:ring-2 focus:ring-blue-500"
            />
            <span className="ml-2 text-gray-500 text-sm">일</span>
          </div>

          {/* 배송 마감시간 */}
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">
              배송 마감시간
            </label>
            <p className="text-xs text-gray-400 mb-2">
              하루 1회 발송 기준 마감시간입니다 (예: 15:00 이전 확정 출고는 당일, 이후는 익일). 알림 문구에 표시됩니다.
            </p>
            <input
              type="time"
              value={settings.shipping_cutoff_time}
              onChange={(e) => setSettings(prev => ({ ...prev, shipping_cutoff_time: e.target.value }))}
              className="w-40 border rounded-lg px-4 py-2 focus:outline-none focus:ring-2 focus:ring-blue-500"
            />
          </div>

          {/* 거래처 관리 링크 */}
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">거래처</label>
            <p className="text-xs text-gray-400 mb-2">
              발주 거래처 등록, 담당자 이메일, 기본계약서는 별도 페이지에서 관리합니다.
            </p>
            <Link
              href="/settings/suppliers"
              className="inline-block text-sm bg-gray-100 text-gray-700 px-4 py-2 rounded-lg hover:bg-gray-200 transition"
            >
              거래처 관리 →
            </Link>
          </div>

          {/* 저장 버튼 */}
          <div className="pt-2">
            <button
              onClick={handleSave}
              disabled={saving}
              className="w-full bg-blue-600 text-white py-3 rounded-lg font-medium hover:bg-blue-700 disabled:opacity-50 transition"
            >
              {saving ? '저장 중...' : '설정 저장'}
            </button>
          </div>
        </div>
      </div>
    </div>
    </>
  )
}
