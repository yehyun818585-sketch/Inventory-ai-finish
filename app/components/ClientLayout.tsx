'use client'

import { AuthProvider } from '@/app/contexts/AuthContext'
import AuthGuard from './AuthGuard'
import ChatWidget from './ChatWidget'

export default function ClientLayout({ children }: { children: React.ReactNode }) {
  return (
    <AuthProvider>
      <AuthGuard>
        {children}
      </AuthGuard>
      <ChatWidget />
    </AuthProvider>
  )
}
