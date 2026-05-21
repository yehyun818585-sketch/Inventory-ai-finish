'use client'

import Link from 'next/link'
import { useState, useRef, useEffect } from 'react'
import { useAuth } from '@/app/contexts/AuthContext'
import { usePathname } from 'next/navigation'

const NAV_LINKS = [
  { href: '/transactions', label: '입출고' },
  { href: '/products', label: '제품관리' },
  { href: '/lots', label: '로트관리' },
  { href: '/plans', label: '기획관리' },
  { href: '/report', label: 'AI 리포트' },
]

export default function Navbar() {
  const { profile, signOut } = useAuth()
  const pathname = usePathname()
  const [open, setOpen] = useState(false)
  const dropdownRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    function handleClick(e: MouseEvent) {
      if (dropdownRef.current && !dropdownRef.current.contains(e.target as Node)) {
        setOpen(false)
      }
    }
    document.addEventListener('mousedown', handleClick)
    return () => document.removeEventListener('mousedown', handleClick)
  }, [])

  const initial = profile?.name?.[0]?.toUpperCase() || '?'

  return (
    <nav className="bg-blue-900 text-white fixed top-0 left-0 right-0 z-40 shadow-md">
      {/* 상단 행: 로고 + 메뉴(데스크탑) + 프로필 */}
      <div className="h-14 flex items-center px-4 md:px-6 gap-4 md:gap-8">
        {/* 로고 */}
        <Link href="/" className="font-bold text-base flex items-center gap-2 shrink-0 hover:text-blue-200 transition">
          <span className="text-lg">📦</span>
          <span>재고AI</span>
        </Link>

        {/* 데스크탑 메뉴 */}
        <div className="hidden md:flex items-center gap-1 flex-1">
          {NAV_LINKS.map(({ href, label }) => {
            const active = pathname === href
            return (
              <Link
                key={href}
                href={href}
                className={`px-3 py-1.5 rounded-lg text-sm font-medium transition ${
                  active
                    ? 'bg-blue-700 text-white'
                    : 'text-blue-200 hover:text-white hover:bg-blue-800'
                }`}
              >
                {label}
              </Link>
            )
          })}
        </div>

        {/* 프로필 드롭다운 */}
        <div className="relative shrink-0 ml-auto" ref={dropdownRef}>
          <button
            onClick={() => setOpen(!open)}
            className="flex items-center gap-2 hover:bg-blue-800 px-2 md:px-3 py-1.5 rounded-lg transition"
          >
            <div className="w-7 h-7 bg-blue-600 rounded-full flex items-center justify-center text-xs font-bold">
              {initial}
            </div>
            <span className="hidden sm:inline text-sm font-medium">{profile?.name}</span>
            <span className={`hidden sm:inline text-xs px-1.5 py-0.5 rounded-full font-medium ${
              profile?.role === '본사' ? 'bg-blue-700 text-blue-200' : 'bg-emerald-700 text-emerald-200'
            }`}>
              {profile?.role}
            </span>
            <svg className={`w-3 h-3 text-blue-300 transition-transform ${open ? 'rotate-180' : ''}`} fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
            </svg>
          </button>

          {open && (
            <div className="absolute right-0 top-12 bg-white text-gray-700 rounded-xl shadow-xl w-48 py-2 z-50 border border-gray-100">
              <Link
                href="/upload"
                onClick={() => setOpen(false)}
                className="flex items-center gap-2.5 px-4 py-2.5 hover:bg-gray-50 text-sm"
              >
                <span>📤</span> 엑셀 업로드
              </Link>
              <Link
                href="/onboarding"
                onClick={() => setOpen(false)}
                className="flex items-center gap-2.5 px-4 py-2.5 hover:bg-gray-50 text-sm"
              >
                <span>🚀</span> 시작 가이드
                {!profile?.onboarding_completed && (
                  <span className="ml-auto w-2 h-2 bg-red-500 rounded-full" />
                )}
              </Link>
              <Link
                href="/settings"
                onClick={() => setOpen(false)}
                className="flex items-center gap-2.5 px-4 py-2.5 hover:bg-gray-50 text-sm"
              >
                <span>⚙️</span> 회사 설정
              </Link>
              <div className="border-t my-1" />
              <button
                onClick={() => { setOpen(false); signOut() }}
                className="w-full text-left flex items-center gap-2.5 px-4 py-2.5 hover:bg-red-50 text-red-600 text-sm"
              >
                <span>→</span> 로그아웃
              </button>
            </div>
          )}
        </div>
      </div>

      {/* 모바일 하단 행: 가로 스크롤 메뉴 */}
      <div className="md:hidden border-t border-blue-800 overflow-x-auto">
        <div className="flex items-center px-2 py-1 gap-1 min-w-max">
          {NAV_LINKS.map(({ href, label }) => {
            const active = pathname === href
            return (
              <Link
                key={href}
                href={href}
                className={`px-3 py-1.5 rounded-lg text-sm font-medium transition whitespace-nowrap ${
                  active
                    ? 'bg-blue-700 text-white'
                    : 'text-blue-200 hover:text-white hover:bg-blue-800'
                }`}
              >
                {label}
              </Link>
            )
          })}
        </div>
      </div>
    </nav>
  )
}
