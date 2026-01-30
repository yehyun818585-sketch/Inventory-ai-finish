'use client'

import { useAuth } from '@/app/contexts/AuthContext'
import { useRouter, usePathname } from 'next/navigation'
import { useEffect } from 'react'

export default function AuthGuard({ children }: { children: React.ReactNode }) {
  const { user, loading } = useAuth()
  const router = useRouter()
  const pathname = usePathname()

  useEffect(() => {
    if (!loading && !user && pathname !== '/login') {
      router.push('/login')
    }
  }, [user, loading, pathname, router])

  // 로딩 중
  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <p className="text-xl text-gray-500">로딩 중...</p>
      </div>
    )
  }

  // 로그인 페이지는 그냥 보여줌
  if (pathname === '/login') {
    return <>{children}</>
  }

  // 로그인 안 된 상태면 아무것도 안 보여줌 (리다이렉트 중)
  if (!user) {
    return null
  }

  return <>{children}</>
}
