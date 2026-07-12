'use client'

import { useState } from 'react'
import { supabase } from '@/lib/supabase'
import { useRouter } from 'next/navigation'

export default function LoginPage() {
  const router = useRouter()
  const [isLogin, setIsLogin] = useState(true) // true: 로그인, false: 회원가입
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [name, setName] = useState('')
  const [companyName, setCompanyName] = useState('')
  const [role, setRole] = useState<'본사' | '창고'>('창고')
  const [position, setPosition] = useState<'관리팀원' | '관리책임자' | '대표' | '담당자'>('담당자')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    setLoading(true)
    setError('')

    if (isLogin) {
      // 로그인
      const { error } = await supabase.auth.signInWithPassword({
        email,
        password
      })

      if (error) {
        setError('로그인 실패: ' + error.message)
      } else {
        router.push('/')
      }
    } else {
      // 회원가입
      if (!companyName.trim()) {
        setError('회사명을 입력해주세요.')
        setLoading(false)
        return
      }

      // 1. 동일 회사명 있으면 합류, 없으면 새로 생성
      let companyId: string

      const { data: existingCompany } = await supabase
        .from('companies')
        .select('id')
        .eq('name', companyName.trim())
        .single()

      if (existingCompany) {
        // 기존 회사에 합류
        companyId = existingCompany.id
      } else {
        // 새 회사 생성
        const { data: newCompany, error: companyError } = await supabase
          .from('companies')
          .insert([{ name: companyName.trim() }])
          .select('id')
          .single()

        if (companyError || !newCompany) {
          setError('회사 생성 실패: ' + companyError?.message)
          setLoading(false)
          return
        }
        companyId = newCompany.id
      }

      const companyData = { id: companyId }

      // 2. 회원가입 (company_id 포함)
      const { data: signUpData, error: signUpError } = await supabase.auth.signUp({
        email,
        password,
        options: {
          data: {
            name,
            role,
            position,
            company_id: companyData.id,
            company_name: companyName.trim()
          }
        }
      })

      if (signUpError) {
        setError(signUpError.message)
        // 회원가입 실패 시 생성된 회사 삭제
        await supabase.from('companies').delete().eq('id', companyData.id)
      } else {
        // 3. profiles 테이블에 company_id 직접 저장 (trigger가 누락하는 경우 대비)
        if (signUpData.user) {
          await supabase.from('profiles').upsert({
            id: signUpData.user.id,
            email,
            name,
            role,
            position,
            company_id: companyData.id,
            onboarding_completed: false
          })
        }
        router.push('/')
      }
    }

    setLoading(false)
  }

  return (
    <div className="min-h-screen bg-gray-50 flex items-center justify-center p-4">
      <div className="bg-white rounded-lg shadow-lg w-full max-w-md p-8">
        <h1 className="text-2xl font-bold text-center text-gray-900 mb-2">
          재고관리 AI
        </h1>
        <p className="text-center text-gray-500 mb-8">
          {isLogin ? '로그인하여 시작하세요' : '새 계정을 만드세요'}
        </p>

        <form onSubmit={handleSubmit} className="space-y-4">
          {!isLogin && (
            <>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  회사명 *
                </label>
                <input
                  type="text"
                  value={companyName}
                  onChange={(e) => setCompanyName(e.target.value)}
                  placeholder="(주)홍길동컴퍼니"
                  className="w-full border rounded-lg px-4 py-2 focus:outline-none focus:ring-2 focus:ring-blue-500"
                  required
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  이름
                </label>
                <input
                  type="text"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="홍길동"
                  className="w-full border rounded-lg px-4 py-2 focus:outline-none focus:ring-2 focus:ring-blue-500"
                  required
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  역할
                </label>
                <div className="flex gap-4">
                  <label className="flex items-center gap-2 cursor-pointer">
                    <input
                      type="radio"
                      name="role"
                      value="본사"
                      checked={role === '본사'}
                      onChange={() => { setRole('본사'); setPosition('관리팀원') }}
                      className="text-blue-600"
                    />
                    <span>본사</span>
                  </label>
                  <label className="flex items-center gap-2 cursor-pointer">
                    <input
                      type="radio"
                      name="role"
                      value="창고"
                      checked={role === '창고'}
                      onChange={() => { setRole('창고'); setPosition('담당자') }}
                      className="text-blue-600"
                    />
                    <span>창고</span>
                  </label>
                </div>
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  직급 <span className="text-gray-400 font-normal">(결재 승인 권한 판단에 사용)</span>
                </label>
                {role === '창고' ? (
                  <div className="flex gap-4">
                    <label className="flex items-center gap-2 opacity-70">
                      <input type="radio" checked readOnly className="text-blue-600" />
                      <span>담당자</span>
                    </label>
                  </div>
                ) : (
                  <div className="flex gap-4 flex-wrap">
                    {(['관리팀원', '관리책임자', '대표'] as const).map(p => (
                      <label key={p} className="flex items-center gap-2 cursor-pointer">
                        <input
                          type="radio"
                          name="position"
                          value={p}
                          checked={position === p}
                          onChange={() => setPosition(p)}
                          className="text-blue-600"
                        />
                        <span>{p}</span>
                      </label>
                    ))}
                  </div>
                )}
                <p className="text-xs text-gray-400 mt-1">관리책임자/대표만 결재 승인이 가능합니다.</p>
              </div>
            </>
          )}

          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">
              이메일
            </label>
            <input
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="example@company.com"
              className="w-full border rounded-lg px-4 py-2 focus:outline-none focus:ring-2 focus:ring-blue-500"
              required
            />
          </div>

          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">
              비밀번호
            </label>
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="6자 이상"
              className="w-full border rounded-lg px-4 py-2 focus:outline-none focus:ring-2 focus:ring-blue-500"
              required
              minLength={6}
            />
          </div>

          {error && (
            <p className="text-red-500 text-sm">{error}</p>
          )}

          <button
            type="submit"
            disabled={loading}
            className="w-full bg-blue-600 text-white py-3 rounded-lg font-medium hover:bg-blue-700 disabled:opacity-50 transition"
          >
            {loading ? '처리 중...' : isLogin ? '로그인' : '회원가입'}
          </button>
        </form>

        <div className="mt-6 text-center">
          <button
            onClick={() => { setIsLogin(!isLogin); setError('') }}
            className="text-blue-600 hover:underline text-sm"
          >
            {isLogin ? '계정이 없으신가요? 회원가입' : '이미 계정이 있으신가요? 로그인'}
          </button>
        </div>
      </div>
    </div>
  )
}
