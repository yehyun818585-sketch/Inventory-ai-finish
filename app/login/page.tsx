'use client'

import { useState } from 'react'
import { supabase } from '@/lib/supabase'
import { useRouter } from 'next/navigation'

// 회사명은 동명이인처럼 겹칠 수 있어 "회사명이 같으면 합류"로는 남의 회사에 잘못 합류할 수 있다.
// 그래서 합류는 이 초대코드로만 하고, 회사명은 참고 표시일 뿐 식별자로 안 쓴다.
function generateInviteCode(): string {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789' // 헷갈리는 0/O, 1/I 제외
  let code = ''
  for (let i = 0; i < 8; i++) code += chars[Math.floor(Math.random() * chars.length)]
  return code
}

export default function LoginPage() {
  const router = useRouter()
  const [isLogin, setIsLogin] = useState(true) // true: 로그인, false: 회원가입
  const [signupMode, setSignupMode] = useState<'create' | 'join'>('create')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [name, setName] = useState('')
  const [employeeNumber, setEmployeeNumber] = useState('')
  const [companyName, setCompanyName] = useState('')
  const [inviteCodeInput, setInviteCodeInput] = useState('')
  const [joinTargetCompany, setJoinTargetCompany] = useState<{ id: string; name: string } | null>(null)
  const [checkingCode, setCheckingCode] = useState(false)
  const [role, setRole] = useState<'본사' | '창고'>('창고')
  const [position, setPosition] = useState<'관리팀원' | '관리책임자' | '대표' | '담당자'>('담당자')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')

  // 초대코드 입력이 바뀔 때마다(8자 다 채워졌을 때) 해당 회사를 조회해서 회사명을 미리 보여준다 —
  // 로그인 전(anon) 상태에서도 조회는 열려있음(companies_select_all 정책).
  async function checkInviteCode(code: string) {
    setJoinTargetCompany(null)
    const trimmed = code.trim().toUpperCase()
    if (trimmed.length < 8) return
    setCheckingCode(true)
    const { data } = await supabase.from('companies').select('id, name').eq('invite_code', trimmed).maybeSingle()
    setCheckingCode(false)
    setJoinTargetCompany(data || null)
  }

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
      // 회원가입 — 회사명이 아니라 "새로 만들기" 또는 "초대코드로 합류" 중 하나로만 회사가 정해진다.
      let companyId: string
      let companyDisplayName: string
      let generatedCode: string | null = null

      if (signupMode === 'create') {
        if (!companyName.trim()) {
          setError('회사명을 입력해주세요.')
          setLoading(false)
          return
        }
        generatedCode = generateInviteCode()
        const { data: newCompany, error: companyError } = await supabase
          .from('companies')
          .insert([{ name: companyName.trim(), invite_code: generatedCode }])
          .select('id, name')
          .single()

        if (companyError || !newCompany) {
          setError('회사 생성 실패: ' + companyError?.message)
          setLoading(false)
          return
        }
        companyId = newCompany.id
        companyDisplayName = newCompany.name
      } else {
        if (!joinTargetCompany) {
          setError('유효한 초대코드를 입력해주세요.')
          setLoading(false)
          return
        }
        companyId = joinTargetCompany.id
        companyDisplayName = joinTargetCompany.name
      }

      // 회원가입 (company_id 포함)
      const { data: signUpData, error: signUpError } = await supabase.auth.signUp({
        email,
        password,
        options: {
          data: {
            name,
            role,
            position,
            company_id: companyId,
            company_name: companyDisplayName
          }
        }
      })

      if (signUpError) {
        setError(signUpError.message)
        // 새로 만든 회사인데 가입 자체가 실패했으면 그 회사도 롤백
        if (signupMode === 'create') await supabase.from('companies').delete().eq('id', companyId)
      } else {
        // profiles 테이블에 company_id 직접 저장 (trigger가 누락하는 경우 대비)
        if (signUpData.user) {
          await supabase.from('profiles').upsert({
            id: signUpData.user.id,
            email,
            name,
            role,
            position,
            employee_number: employeeNumber.trim() || null,
            company_id: companyId,
            onboarding_completed: false
          })
        }
        if (generatedCode) {
          alert(`회사가 생성되었습니다!\n\n동료를 초대하려면 이 초대코드를 알려주세요:\n${generatedCode}\n\n(나중에 설정 페이지에서 다시 확인할 수 있습니다)`)
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
                <div className="flex gap-1 bg-slate-100 rounded-lg p-1 mb-2">
                  <button
                    type="button"
                    onClick={() => { setSignupMode('create'); setError('') }}
                    className={`flex-1 py-1.5 rounded-md text-sm font-medium transition ${signupMode === 'create' ? 'bg-white shadow text-gray-900' : 'text-gray-500'}`}
                  >
                    새 회사 만들기
                  </button>
                  <button
                    type="button"
                    onClick={() => { setSignupMode('join'); setError('') }}
                    className={`flex-1 py-1.5 rounded-md text-sm font-medium transition ${signupMode === 'join' ? 'bg-white shadow text-gray-900' : 'text-gray-500'}`}
                  >
                    초대코드로 합류
                  </button>
                </div>

                {signupMode === 'create' ? (
                  <>
                    <label className="block text-sm font-medium text-gray-700 mb-1">회사명 *</label>
                    <input
                      type="text"
                      value={companyName}
                      onChange={(e) => setCompanyName(e.target.value)}
                      placeholder="(주)홍길동컴퍼니"
                      className="w-full border rounded-lg px-4 py-2 focus:outline-none focus:ring-2 focus:ring-blue-500"
                      required
                    />
                    <p className="text-xs text-gray-400 mt-1">가입 완료 후 동료 초대용 코드가 발급됩니다.</p>
                  </>
                ) : (
                  <>
                    <label className="block text-sm font-medium text-gray-700 mb-1">초대코드 *</label>
                    <input
                      type="text"
                      value={inviteCodeInput}
                      onChange={(e) => {
                        const v = e.target.value.toUpperCase()
                        setInviteCodeInput(v)
                        checkInviteCode(v)
                      }}
                      placeholder="회사 관리자에게 받은 8자리 코드"
                      maxLength={8}
                      className="w-full border rounded-lg px-4 py-2 tracking-widest focus:outline-none focus:ring-2 focus:ring-blue-500"
                      required
                    />
                    {checkingCode && <p className="text-xs text-gray-400 mt-1">확인 중...</p>}
                    {!checkingCode && inviteCodeInput.length >= 8 && (
                      joinTargetCompany
                        ? <p className="text-xs text-green-600 mt-1">✓ {joinTargetCompany.name}에 합류합니다</p>
                        : <p className="text-xs text-red-500 mt-1">유효하지 않은 초대코드입니다</p>
                    )}
                  </>
                )}
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
                  사번 <span className="text-gray-400 font-normal">(동명이인 구분용, 선택)</span>
                </label>
                <input
                  type="text"
                  value={employeeNumber}
                  onChange={(e) => setEmployeeNumber(e.target.value)}
                  placeholder="예: 1024"
                  className="w-full border rounded-lg px-4 py-2 focus:outline-none focus:ring-2 focus:ring-blue-500"
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
