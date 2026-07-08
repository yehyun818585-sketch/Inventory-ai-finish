'use client'

import { useState, useEffect } from 'react'
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
  default_po_email: string
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
    default_po_email: ''
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
      .select('name, industry, default_shelf_life_months, shelf_life_warning_ratio, inventory_unit, reconciliation_grace_days, default_po_email')
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
        default_po_email: data.default_po_email || ''
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
        default_po_email: settings.default_po_email || null
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

          {/* 미기록 유예일수(α) */}
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">
              미기록 유예일수 (α)
            </label>
            <p className="text-xs text-gray-400 mb-2">
              발주품의서/출고지시서의 납기·출고예정일로부터 며칠 지나야 미기록으로 적발할지 설정합니다
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

          {/* 발주서 기본 수신처 */}
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">
              발주서 기본 수신처 이메일
            </label>
            <p className="text-xs text-gray-400 mb-2">
              발주서 발송 시 기본으로 채워지는 거래처 담당자 이메일입니다 (발송 시 수정 가능)
            </p>
            <input
              type="email"
              placeholder="order@supplier.com"
              value={settings.default_po_email}
              onChange={(e) => setSettings(prev => ({ ...prev, default_po_email: e.target.value }))}
              className="w-full border rounded-lg px-4 py-2 focus:outline-none focus:ring-2 focus:ring-blue-500"
            />
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
