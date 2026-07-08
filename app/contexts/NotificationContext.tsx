'use client'

import { createContext, useContext, useEffect, useState } from 'react'
import { supabase } from '@/lib/supabase'
import { useAuth } from '@/app/contexts/AuthContext'

export interface AppNotification {
  id: string
  document_id: string | null
  type: '결재요청' | '승인' | '반려'
  message: string
  read_at: string | null
  created_at: string
}

interface NotificationContextType {
  notifications: AppNotification[]
  toastQueue: AppNotification[]
  unreadCount: number
  markAsRead: (id: string) => void
  dismissToast: (id: string) => void
}

const NotificationContext = createContext<NotificationContextType>({
  notifications: [],
  toastQueue: [],
  unreadCount: 0,
  markAsRead: () => {},
  dismissToast: () => {}
})

export function NotificationProvider({ children }: { children: React.ReactNode }) {
  const { profile } = useAuth()
  const [notifications, setNotifications] = useState<AppNotification[]>([])
  const [toastQueue, setToastQueue] = useState<AppNotification[]>([])

  useEffect(() => {
    if (!profile?.id) return

    async function fetchRecent() {
      const { data } = await supabase
        .from('notifications')
        .select('id, document_id, type, message, read_at, created_at')
        .eq('recipient_user_id', profile!.id)
        .order('created_at', { ascending: false })
        .limit(20)
      setNotifications(data || [])
    }
    fetchRecent()

    const channel = supabase
      .channel(`notifications-${profile.id}`)
      .on('postgres_changes', {
        event: 'INSERT',
        schema: 'public',
        table: 'notifications',
        filter: `recipient_user_id=eq.${profile.id}`
      }, (payload) => {
        const row = payload.new as AppNotification
        setNotifications(prev => [row, ...prev])
        setToastQueue(prev => [...prev, row])
        setTimeout(() => {
          setToastQueue(prev => prev.filter(t => t.id !== row.id))
        }, 6000)
      })
      .subscribe((status) => {
        console.log(`🔔 [notifications] realtime status: ${status}`)
      })

    return () => { supabase.removeChannel(channel) }
  }, [profile?.id])

  async function markAsRead(id: string) {
    setNotifications(prev => prev.map(n => n.id === id ? { ...n, read_at: new Date().toISOString() } : n))
    await supabase.from('notifications').update({ read_at: new Date().toISOString() }).eq('id', id)
  }

  function dismissToast(id: string) {
    setToastQueue(prev => prev.filter(t => t.id !== id))
  }

  const unreadCount = notifications.filter(n => !n.read_at).length

  return (
    <NotificationContext.Provider value={{ notifications, toastQueue, unreadCount, markAsRead, dismissToast }}>
      {children}
    </NotificationContext.Provider>
  )
}

export const useNotifications = () => useContext(NotificationContext)
