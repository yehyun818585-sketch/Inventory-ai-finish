'use client'

import { useEffect, useState } from 'react'
import { supabase } from '@/lib/supabase'
import { useAuth } from '@/app/contexts/AuthContext'
import Navbar from '@/app/components/Navbar'

interface Channel {
  id: string
  name: string
  created_at: string
}

export default function ChannelsPage() {
  const { profile } = useAuth()
  const [channels, setChannels] = useState<Channel[]>([])
  const [loading, setLoading] = useState(true)
  const [newName, setNewName] = useState('')
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    if (!profile?.company_id) return
    fetchChannels()
  }, [profile?.company_id])

  async function fetchChannels() {
    setLoading(true)
    const { data } = await supabase
      .from('channels')
      .select('id, name, created_at')
      .eq('company_id', profile!.company_id!)
      .order('created_at', { ascending: true })
    setChannels(data || [])
    setLoading(false)
  }

  async function handleAdd(e: React.FormEvent) {
    e.preventDefault()
    const name = newName.trim()
    if (!name) return
    const cid = profile?.company_id
    if (!cid) return

    setSaving(true)
    try {
      const { error } = await supabase.from('channels').insert([{ name, company_id: cid }])
      if (error) {
        alert('추가 실패: ' + error.message)
        return
      }
      setNewName('')
      fetchChannels()
    } finally {
      setSaving(false)
    }
  }

  async function handleDelete(c: Channel) {
    if (!confirm(`"${c.name}" 채널을 삭제하시겠습니까?\n\n이미 이 채널로 기안된 출고지시서는 그대로 남습니다.`)) return
    const { error } = await supabase.from('channels').delete().eq('id', c.id)
    if (error) { alert('삭제 실패: ' + error.message); return }
    fetchChannels()
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
        <div className="max-w-3xl mx-auto">
          <div className="mb-6">
            <h1 className="text-xl font-bold text-gray-900">채널 관리</h1>
            <p className="text-sm text-gray-500 mt-1">
              출고지시서 기안 및 실제 출고 등록 시 선택할 채널(자사몰, 올리브영 등)을 등록합니다.
              여기 등록된 이름만 양쪽 화면에서 그대로 선택되므로, 오타로 인한 대사 불일치를 막을 수 있습니다.
            </p>
          </div>

          <div className="bg-white rounded-lg shadow p-6 mb-8">
            <form onSubmit={handleAdd} className="flex gap-2">
              <input
                type="text"
                placeholder="예: 자사몰, 올리브영"
                value={newName}
                onChange={(e) => setNewName(e.target.value)}
                className="flex-1 border rounded-lg px-4 py-2 focus:outline-none focus:ring-2 focus:ring-blue-500"
              />
              <button
                type="submit"
                disabled={saving || !newName.trim()}
                className="bg-blue-600 text-white px-5 py-2 rounded-lg font-medium hover:bg-blue-700 disabled:opacity-50 transition shrink-0"
              >
                {saving ? '추가 중...' : '+ 채널 추가'}
              </button>
            </form>
          </div>

          <div className="bg-white rounded-lg shadow">
            <div className="p-3 md:p-6 border-b">
              <h2 className="text-base md:text-lg font-semibold">등록된 채널 ({channels.length}개)</h2>
            </div>
            <div className="p-3 md:p-6">
              {channels.length === 0 ? (
                <p className="text-gray-500 text-center py-8">등록된 채널이 없습니다.</p>
              ) : (
                <div className="space-y-2">
                  {channels.map(c => (
                    <div key={c.id} className="flex items-center justify-between border-b py-3">
                      <p className="font-medium text-sm">{c.name}</p>
                      <button onClick={() => handleDelete(c)} className="text-sm text-red-500 hover:underline">삭제</button>
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
