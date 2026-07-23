'use client'

import { useState, useEffect } from 'react'
import { supabase } from '@/lib/supabase'
import { useAuth } from '@/app/contexts/AuthContext'
import Navbar from '@/app/components/Navbar'
import * as XLSX from 'xlsx'

interface Warehouse {
  id: string
  name: string
}

interface ExcelRow {
  제품군?: string
  제품명?: string
  품번?: string
  충주창고재고?: number
  본사사무실재고?: number
  총재고?: number
  원가?: number
  로트번호?: string | number
  제조일자?: string | number
  생산일자?: string | number
  LOT?: string | number
  [key: string]: string | number | Date | undefined
}

interface ParsedProduct {
  product_group: string
  product_name: string
  product_code: string
  unit_cost: number
  lot_number: string | null
  inventories: {
    warehouse_name: string
    quantity: number
  }[]
}

interface ColumnMapping {
  product_name: string
  product_code: string
  product_group: string
  unit_cost: string
  lot_number: string
  general_qty: string
  warehouse_qty: { [warehouseId: string]: string }
}

// 엑셀에서 감지된 창고 정보
interface DetectedWarehouse {
  name: string      // 추출된 창고 이름 (예: "충주창고")
  column: string    // 엑셀 컬럼명 (예: "충주창고재고")
}

// 세트/기획 가능성 키워드
const SET_KEYWORDS = ['기획', '세트', '증정', '콜라보', '한정판', '에디션', '패키지', '선물', '기프트']
function hasSetKeyword(name: string): boolean {
  const lower = name.toLowerCase()
  return SET_KEYWORDS.some(kw => lower.includes(kw))
}

// 날짜를 로트번호 형식으로 변환 (YYMMDD-01)
function dateToLotNumber(dateValue: string | number | Date | undefined): string | null {
  if (!dateValue) return null

  let date: Date | null = null

  // 엑셀 시리얼 날짜 (숫자)
  if (typeof dateValue === 'number') {
    // 6자리 숫자 → YYMMDD 형식으로 직접 처리 (예: 250601 → "250601")
    const str = String(Math.round(dateValue))
    if (str.length === 6) {
      const yy = str.slice(0, 2)
      const mm = str.slice(2, 4)
      const dd = str.slice(4, 6)
      const mNum = parseInt(mm)
      const dNum = parseInt(dd)
      if (mNum >= 1 && mNum <= 12 && dNum >= 1 && dNum <= 31) {
        return `${yy}${mm}${dd}-01`
      }
    }
    // 일반 엑셀 시리얼 날짜 → JS Date 변환
    const excelEpoch = new Date(1899, 11, 30)
    date = new Date(excelEpoch.getTime() + dateValue * 24 * 60 * 60 * 1000)
  }
  // Date 객체
  else if (dateValue instanceof Date) {
    date = dateValue
  }
  // 문자열
  else if (typeof dateValue === 'string') {
    // 이미 로트번호 형식인지 확인 (YYMMDD-NN)
    if (/^\d{6}-\d{2}$/.test(dateValue)) {
      return dateValue
    }
    // 6자리 숫자 문자열 → YYMMDD 직접 처리 (예: "250601" → "250601-01")
    if (/^\d{6}$/.test(dateValue)) {
      const mm = parseInt(dateValue.slice(2, 4))
      const dd = parseInt(dateValue.slice(4, 6))
      if (mm >= 1 && mm <= 12 && dd >= 1 && dd <= 31) {
        return `${dateValue}-01`
      }
    }
    // 날짜 문자열 파싱 시도
    const parsed = new Date(dateValue)
    if (!isNaN(parsed.getTime())) {
      date = parsed
    }
  }

  if (!date || isNaN(date.getTime())) return null

  const yy = date.getFullYear().toString().slice(-2)
  const mm = (date.getMonth() + 1).toString().padStart(2, '0')
  const dd = date.getDate().toString().padStart(2, '0')

  return `${yy}${mm}${dd}-01`
}

// 엑셀 컬럼에서 로트번호 추출 (다양한 컬럼명 지원)
function extractLotNumber(row: ExcelRow): string | null {
  // 로트번호 관련 컬럼명들
  const lotColumns = [
    '로트번호', '로트', 'LOT', 'lot', 'Lot', 'lot_number', 'LOT번호', 'LOT NO', 'Lot No', 'lot no'
  ]

  // 제조일자/생산일자 관련 컬럼명들 (날짜 → 로트번호 변환)
  const dateColumns = [
    '제조일자', '제조일', '생산일자', '생산일', '제조날짜', '생산날짜',
    'MFG Date', 'Manufacturing Date', 'Production Date', 'Mfg', '입고일', '입고일자'
  ]

  // 1. 로트번호 컬럼 직접 찾기
  for (const col of lotColumns) {
    const value = row[col]
    if (value !== undefined && value !== null && value !== '') {
      // 이미 로트번호 형식이면 그대로 반환
      if (typeof value === 'string' && /^\d{6}-\d{2}$/.test(value)) {
        return value
      }
      // 숫자나 날짜면 변환 시도
      const converted = dateToLotNumber(value)
      if (converted) return converted
      // 문자열이면 그대로 사용 (다른 형식의 로트번호일 수 있음)
      if (typeof value === 'string') return value
    }
  }

  // 2. 제조일자/생산일자 컬럼에서 로트번호 생성
  for (const col of dateColumns) {
    const value = row[col]
    if (value !== undefined && value !== null && value !== '') {
      const converted = dateToLotNumber(value)
      if (converted) return converted
    }
  }

  // 3. 모든 컬럼을 순회하며 날짜/로트 패턴 찾기
  for (const [key, value] of Object.entries(row)) {
    if (value === undefined || value === null || value === '') continue

    // 키 이름에 로트, lot, 제조, 생산 등이 포함된 경우
    const keyLower = key.toLowerCase()
    if (keyLower.includes('로트') || keyLower.includes('lot') ||
        keyLower.includes('제조') || keyLower.includes('생산') ||
        keyLower.includes('mfg')) {
      const converted = dateToLotNumber(value)
      if (converted) return converted
      if (typeof value === 'string' && value.length > 0) return value
    }
  }

  return null
}

export default function UploadPage() {
  const { profile } = useAuth()
  const [parsedData, setParsedData] = useState<ParsedProduct[]>([])
  const [uploading, setUploading] = useState(false)
  const [fileName, setFileName] = useState('')
  const [deleting, setDeleting] = useState(false)
  const [showDeleteModal, setShowDeleteModal] = useState(false)
  const [deleteOption, setDeleteOption] = useState<'inventory' | 'all'>('inventory')
  const [deleteStep, setDeleteStep] = useState<1 | 2>(1)  // 2단계 확인
  const [detectedColumns, setDetectedColumns] = useState<string[]>([])  // 감지된 컬럼명
  const [rawData, setRawData] = useState<ExcelRow[]>([])  // 원본 엑셀 데이터
  const [uploadStep, setUploadStep] = useState<'file' | 'sheet' | 'mapping' | 'preview'>('file')  // 업로드 단계
  const [allSheets, setAllSheets] = useState<{ name: string; rowCount: number }[]>([])  // 전체 시트 목록
  const [selectedSheets, setSelectedSheets] = useState<string[]>([])  // 선택된 시트
  const [workbookRef, setWorkbookRef] = useState<XLSX.WorkBook | null>(null)  // 워크북 참조
  const [warehouses, setWarehouses] = useState<Warehouse[]>([])  // DB에서 가져온 창고 목록
  const [detectedWarehouses, setDetectedWarehouses] = useState<DetectedWarehouse[]>([])  // 엑셀에서 감지된 창고
  const [columnMapping, setColumnMapping] = useState<ColumnMapping>({
    product_name: '',
    product_code: '',
    product_group: '',
    unit_cost: '',
    lot_number: '',
    general_qty: '',
    warehouse_qty: {}
  })
  const [aiSuggestOff, setAiSuggestOff] = useState<string[]>([])
  const [aiNeedsReview, setAiNeedsReview] = useState<string[]>([])
  const [userConfirmedOff, setUserConfirmedOff] = useState<Set<string>>(new Set())
  const [aiClassifying, setAiClassifying] = useState(false)

  // 페이지 로드 시 창고 목록 가져오기
  useEffect(() => {
    async function fetchWarehouses() {
      const { data, error } = await supabase.from('warehouses').select('id, name').eq('company_id', profile?.company_id || '')
      if (error) {
        console.error('❌ [에러] 창고 목록 불러오기 실패:', error.message)
        return
      }
      if (data) {
        setWarehouses(data)
        // 창고별 매핑 초기화
        const initialWarehouseMapping: { [key: string]: string } = {}
        data.forEach(w => {
          initialWarehouseMapping[w.id] = ''
        })
        setColumnMapping(prev => ({ ...prev, warehouse_qty: initialWarehouseMapping }))
      } else {
      }
    }
    fetchWarehouses()
  }, [])

  function handleFileUpload(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    if (!file) {
      return
    }

    setFileName(file.name)

    const reader = new FileReader()
    reader.onload = async (event) => {
      const data = event.target?.result
      const workbook = XLSX.read(data, { type: 'binary' })

      // 각 시트 행 수 파악
      const sheets = workbook.SheetNames.map(sName => {
        const ws = workbook.Sheets[sName]
        const rows = XLSX.utils.sheet_to_json<ExcelRow>(ws)
        return { name: sName, rowCount: rows.length }
      })

      setAllSheets(sheets)
      setSelectedSheets(sheets.map(s => s.name))  // 전부 체크
      setWorkbookRef(workbook)
      setUploadStep('sheet')
    }
    reader.onerror = (error) => {
      console.error('❌ [에러] 파일 읽기 실패:', error)
    }
    reader.readAsBinaryString(file)
  }

  // 엑셀 컬럼에서 창고 자동 감지 (OpenAI 사용)
  async function detectWarehousesFromColumns(columns: string[]): Promise<DetectedWarehouse[]> {

    try {
      const response = await fetch('/api/detect-warehouses', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ columns })
      })

      if (!response.ok) {
        console.error('🤖 [AI] API 응답 에러:', response.status)
        return fallbackDetectWarehouses(columns)
      }

      const data = await response.json()

      if (data.warehouses && data.warehouses.length > 0) {
        return data.warehouses.map((w: { column: string; name: string }) => ({
          name: w.name,
          column: w.column
        }))
      }

      return []
    } catch (error) {
      console.error('🤖 [AI] 에러, 폴백 사용:', error)
      return fallbackDetectWarehouses(columns)
    }
  }

  // AI 실패시 폴백 (기존 로직)
  function fallbackDetectWarehouses(columns: string[]): DetectedWarehouse[] {
    const detected: DetectedWarehouse[] = []
    const qtyKeywords = ['재고', '수량', 'qty', 'quantity', 'stock']
    const excludeKeywords = ['총재고', '현재고', '전체재고', '가용재고', '최소재고', '최대재고', '안전재고', '출고', '입고', '예약', 'total', 'available', 'minimum', 'maximum']

    for (const col of columns) {
      const colLower = col.toLowerCase().replace(/\s/g, '')
      const hasQtyKeyword = qtyKeywords.some(kw => colLower.includes(kw.toLowerCase()))

      if (hasQtyKeyword) {
        const isExcluded = excludeKeywords.some(kw => colLower.includes(kw.toLowerCase()))

        if (!isExcluded) {
          let warehouseName = col
          for (const kw of qtyKeywords) {
            warehouseName = warehouseName.replace(new RegExp(kw, 'gi'), '')
          }
          warehouseName = warehouseName.trim()

          if (warehouseName && warehouseName.length >= 2) {
            detected.push({ name: warehouseName, column: col })
          }
        }
      }
    }

    return detected
  }

  // AI 기반 컬럼 자동 매핑 추론
  async function autoDetectColumnMapping(columns: string[]): Promise<ColumnMapping> {
    // 엑셀에서 창고 자동 감지 (AI 사용)
    const detected = await detectWarehousesFromColumns(columns)
    setDetectedWarehouses(detected)

    // 창고별 매핑 초기화 (감지된 창고 기반)
    const warehouseQtyMapping: { [key: string]: string } = {}
    detected.forEach((w, idx) => {
      warehouseQtyMapping[`detected_${idx}`] = w.column
    })
    // 기존 DB 창고도 추가
    warehouses.forEach(w => {
      if (!Object.values(warehouseQtyMapping).includes('')) {
        warehouseQtyMapping[w.id] = ''
      }
    })

    const mapping: ColumnMapping = {
      product_name: '',
      product_code: '',
      product_group: '',
      unit_cost: '',
      lot_number: '',
      general_qty: '',
      warehouse_qty: warehouseQtyMapping
    }

    // 기본 필드 패턴
    const fieldPatterns: { field: 'product_name' | 'product_code' | 'product_group' | 'lot_number' | 'general_qty' | 'unit_cost'; keywords: string[] }[] = [
      { field: 'product_name', keywords: ['제품명', '상품명', '품명', '이름', 'name', 'product', '제품'] },
      { field: 'product_code', keywords: ['품번', '제품코드', '상품코드', '코드', 'code', 'sku', 'id'] },
      { field: 'product_group', keywords: ['제품군', '품목군', '카테고리', 'category', '분류', '그룹'] },
      { field: 'lot_number', keywords: ['로트', 'lot', '제조일', '생산일', 'mfg', '배치', 'batch'] },
      { field: 'general_qty', keywords: ['총재고', '현재고', '전체재고', 'total'] },
      { field: 'unit_cost', keywords: ['제조원가', '원가', '단가', 'cost', '제조단가'] }
    ]

    // 기본 필드 매핑
    for (const { field, keywords } of fieldPatterns) {
      for (const col of columns) {
        const colLower = col.toLowerCase().replace(/\s/g, '')
        for (const keyword of keywords) {
          if (colLower.includes(keyword.toLowerCase())) {
            if (!mapping[field]) {
              mapping[field] = col
            }
            break
          }
        }
        if (mapping[field]) break
      }
    }

    return mapping
  }

  // 시트 선택 완료 후 컬럼 매핑 단계로 진행
  async function proceedFromSheetSelection() {
    if (!workbookRef || selectedSheets.length === 0) return

    const allRows: ExcelRow[] = []
    for (const sName of selectedSheets) {
      const ws = workbookRef.Sheets[sName]
      const rows = XLSX.utils.sheet_to_json<ExcelRow>(ws)
      rows.forEach(row => { row['__sheet_name__'] = sName })
      allRows.push(...rows)
    }

    if (allRows.length === 0) {
      alert('선택한 시트에 데이터가 없습니다.')
      return
    }

    const columns = Object.keys(allRows[0]).filter(c => c !== '__sheet_name__')
    setDetectedColumns(columns)
    setRawData(allRows)

    const autoMapping = await autoDetectColumnMapping(columns)
    setColumnMapping(autoMapping)
    setUploadStep('mapping')
  }

  // 매핑 적용하여 데이터 파싱
  async function applyMappingAndParse() {

    let skippedNoName = 0
    let skippedNoInventory = 0
    let totalInventoryCount = 0

    const parsed: ParsedProduct[] = rawData.map((row, index) => {
      const productName = columnMapping.product_name ? String(row[columnMapping.product_name] || '') : ''
      const productCode = columnMapping.product_code ? String(row[columnMapping.product_code] || '') : ''
      const productGroup = columnMapping.product_group ? String(row[columnMapping.product_group] || '') : ''

      // 제조원가 추출
      const unitCost = columnMapping.unit_cost && row[columnMapping.unit_cost]
        ? Number(row[columnMapping.unit_cost]) || 0
        : 0

      // 로트번호 추출
      let lotNumber: string | null = null
      if (columnMapping.lot_number && row[columnMapping.lot_number]) {
        const lotValue = row[columnMapping.lot_number]
        lotNumber = dateToLotNumber(lotValue) || (typeof lotValue === 'string' ? lotValue : null)
      }

      // 재고 추출 (엑셀에서 감지된 창고 기반)
      const inventories: { warehouse_name: string; quantity: number }[] = []

      // 감지된 창고에서 재고 추출
      for (const detected of detectedWarehouses) {
        if (row[detected.column]) {
          const qty = Number(row[detected.column])
          if (qty > 0) {
            inventories.push({ warehouse_name: detected.name, quantity: qty })
          }
        }
      }

      // 감지된 창고가 없고, 일반 재고 컬럼이 있으면 시트 이름(없으면 "기본창고")으로 할당
      if (inventories.length === 0 && columnMapping.general_qty && row[columnMapping.general_qty]) {
        const qty = Number(row[columnMapping.general_qty])
        if (qty > 0) {
          const rawSheet = String(row['__sheet_name__'] || '기본창고')
          // 시트 이름에서 창고명만 추출 (불필요한 접두/접미어 제거)
          const warehouseName = rawSheet
            .replace(/\d+월\s*/g, '')           // "12월 " 제거
            .replace(/재고현황|현황|재고|수량/g, '') // 불필요 단어 제거
            .trim() || rawSheet
          inventories.push({ warehouse_name: warehouseName, quantity: qty })
        }
      }

      if (inventories.length === 0) {
        skippedNoInventory++
      } else {
        totalInventoryCount += inventories.length
      }

      // 제품명/품번 대체
      const finalProductName = productName || productCode
      const finalProductCode = productCode || productName

      return {
        product_group: productGroup,
        product_name: finalProductName,
        product_code: finalProductCode,
        unit_cost: unitCost,
        lot_number: lotNumber,
        inventories
      }
    }).filter(item => {
      const hasValidName = item.product_name && item.product_name.trim() !== ''
      const hasValidCode = item.product_code && item.product_code.trim() !== ''
      if (!hasValidName && !hasValidCode) {
        skippedNoName++
        return false
      }
      return true
    })


    if (parsed.length > 0) {
    }

    setParsedData(parsed)
    setUploadStep('preview')
    setUserConfirmedOff(new Set())

    // AI 분류 + 제품군 상속 병합
    const uniqueNames = [...new Set(parsed.map(p => p.product_name).filter(Boolean))]
    if (uniqueNames.length > 0) {
      setAiClassifying(true)
      try {
        // 1. AI 분류 호출
        const [aiRes, existingRes] = await Promise.all([
          fetch('/api/classify-products', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ productNames: uniqueNames })
          }),
          // 2. 기존 제품 그룹 상속 정보 조회
          supabase
            .from('products')
            .select('product_group, track_expiry')
            .eq('company_id', profile?.company_id || '')
        ])

        // 제품군 OFF 집합 계산 (과반수 OFF인 그룹)
        const groupOffGroups = new Set<string>()
        if (existingRes.data) {
          const counts: Record<string, { on: number; off: number }> = {}
          existingRes.data.forEach((p: { product_group: string; track_expiry: boolean }) => {
            const g = p.product_group || ''
            if (!counts[g]) counts[g] = { on: 0, off: 0 }
            if (p.track_expiry) counts[g].on++
            else counts[g].off++
          })
          Object.entries(counts).forEach(([g, { on, off }]) => {
            if (off > on) groupOffGroups.add(g)
          })
        }

        // 세트 키워드 포함 제품 (최우선 — 상속/AI 모두 override)
        const setKeywordNames = new Set(parsed.filter(p => hasSetKeyword(p.product_name)).map(p => p.product_name))

        // 제품군 상속으로 OFF 추천 (세트 키워드 없는 경우만)
        const groupOffNames = new Set(
          parsed
            .filter(p => groupOffGroups.has(p.product_group || '') && !hasSetKeyword(p.product_name))
            .map(p => p.product_name)
        )

        // AI 결과
        let aiData = { suggest_off: [] as string[], needs_review: [] as string[] }
        if (aiRes.ok) aiData = await aiRes.json()

        // 우선순위 병합:
        // 1. 세트 키워드 → needs_review (최우선)
        // 2. 그룹 상속 OFF (세트 키워드 없음) → suggest_off (AI보다 우선)
        // 3. AI suggest_off (세트 키워드 없음) → suggest_off
        // 4. AI needs_review → needs_review (suggest_off와 중복 제외)
        const finalSuggestOff = [...new Set([
          ...groupOffNames,
          ...(aiData.suggest_off || []).filter((n: string) => !hasSetKeyword(n))
        ])].filter(n => !setKeywordNames.has(n))

        const finalNeedsReview = [...new Set([
          ...setKeywordNames,
          ...(aiData.needs_review || [])
        ])].filter(n => !finalSuggestOff.includes(n))

        setAiSuggestOff(finalSuggestOff)
        setAiNeedsReview(finalNeedsReview)
      } catch (e) {
        console.error('분류 에러:', e)
      } finally {
        setAiClassifying(false)
      }
    }
  }

  async function handleDelete() {
    setDeleting(true)

    try {
      const cid = profile?.company_id || ''
      if (deleteOption === 'all') {
        // 전체 삭제: transactions → 재고 → 제품 → 창고 순서
        const { error: e1 } = await supabase.from('transactions').delete().eq('company_id', cid)
        if (e1) console.error('   ❌ 트랜잭션 삭제 실패:', e1.message)

        const { error: e2 } = await supabase.from('inventory').delete().eq('company_id', cid)
        if (e2) console.error('   ❌ 재고 삭제 실패:', e2.message)

        const { error: e3 } = await supabase.from('products').delete().eq('company_id', cid)
        if (e3) console.error('   ❌ 제품 삭제 실패:', e3.message)

        const { error: e4 } = await supabase.from('warehouses').delete().eq('company_id', cid)
        if (e4) console.error('   ❌ 창고 삭제 실패:', e4.message)

        // 창고 목록 상태 초기화
        setWarehouses([])

        alert('모든 데이터가 삭제되었습니다.\n(제품, 재고, 입출고 기록, 창고 전체)')
      } else {
        // 재고만 삭제
        const { error: e1 } = await supabase.from('transactions').delete().eq('company_id', cid)
        if (e1) console.error('   ❌ 트랜잭션 삭제 실패:', e1.message)

        const { error: e2 } = await supabase.from('inventory').delete().eq('company_id', cid)
        if (e2) console.error('   ❌ 재고 삭제 실패:', e2.message)

        alert('재고 및 입출고 기록이 삭제되었습니다.\n(제품 목록은 유지됨)')
      }

      // AI 리포트 캐시도 삭제
      localStorage.removeItem('ai_report')
      localStorage.removeItem('ai_report_time')

      setShowDeleteModal(false)
      setDeleteStep(1)  // 초기화
    } catch (error) {
      console.error('❌ [에러] 삭제 중 예외 발생:', error)
      alert('삭제 중 오류가 발생했습니다. F12 콘솔을 확인하세요.')
    } finally {
      setDeleting(false)
    }
  }

  function closeDeleteModal() {
    setShowDeleteModal(false)
    setDeleteStep(1)  // 모달 닫을 때 초기화
  }

  async function handleUpload() {

    if (parsedData.length === 0) {
      alert('업로드할 데이터가 없습니다.')
      return
    }

    setUploading(true)

    // 통계 추적
    let productCreated = 0
    let productExisted = 0
    let productFailed = 0
    let inventoryCreated = 0
    let inventoryUpdated = 0
    let inventorySkipped = 0

    try {
      // 창고 목록 가져오기 (업로드용)
      const { data: warehouseData, error: warehouseError } = await supabase.from('warehouses').select('*').eq('company_id', profile?.company_id || '')

      if (warehouseError) {
        console.error('❌ [에러] 창고 목록 조회 실패:', warehouseError.message)
        throw warehouseError
      }

      const warehouseMap = new Map(warehouseData?.map(w => [w.name, w.id]) || [])

      for (let i = 0; i < parsedData.length; i++) {
        const item = parsedData[i]

        // 1. 제품 등록 (이미 있으면 스킵)
        const { data: existingProduct, error: findError } = await supabase
          .from('products')
          .select('id')
          .eq('product_code', item.product_code)
          .eq('company_id', profile?.company_id || '')
          .single()

        if (findError && findError.code !== 'PGRST116') {
          console.error(`   ⚠️ 제품 조회 에러:`, findError.message)
        }

        let productId: string

        if (existingProduct) {
          productId = existingProduct.id
          productExisted++
        } else {
          const { data: newProduct, error } = await supabase
            .from('products')
            .insert([{
              product_group: item.product_group,
              product_name: item.product_name,
              product_code: item.product_code,
              version: '일반',
              unit_cost: item.unit_cost,
              is_active: true,
              track_expiry: !userConfirmedOff.has(item.product_name),
              company_id: profile?.company_id
            }])
            .select('id')
            .single()

          if (error || !newProduct) {
            console.error(`   ❌ 제품 등록 실패:`, error?.message)
            productFailed++
            continue
          }
          productId = newProduct.id
          productCreated++
        }

        // 2. 재고 등록 (로트번호 포함)

        if (item.inventories.length === 0) {
        }

        for (const inv of item.inventories) {
          let warehouseId = warehouseMap.get(inv.warehouse_name)

          // 창고가 없으면 자동 생성
          if (!warehouseId) {
            const { data: newWarehouse, error: warehouseCreateError } = await supabase
              .from('warehouses')
              .insert([{ name: inv.warehouse_name, company_id: profile?.company_id }])
              .select('id')
              .single()

            if (warehouseCreateError || !newWarehouse) {
              console.error(`   ❌ 창고 생성 실패:`, warehouseCreateError?.message)
              inventorySkipped++
              continue
            }

            warehouseId = newWarehouse.id
            warehouseMap.set(inv.warehouse_name, warehouseId)
          }


          // 기존 재고 확인 (로트번호도 함께 체크)
          let existingInvQuery = supabase
            .from('inventory')
            .select('id, quantity, lot_number')
            .eq('product_id', productId)
            .eq('warehouse_id', warehouseId)

          // 로트번호가 있으면 로트번호도 조건에 추가
          if (item.lot_number) {
            existingInvQuery = existingInvQuery.eq('lot_number', item.lot_number)
          }

          const { data: existingInv, error: invFindError } = await existingInvQuery.maybeSingle()

          if (invFindError && invFindError.code !== 'PGRST116') {
          }

          if (existingInv) {
            // 기존 재고 업데이트
            const { error: updateError } = await supabase
              .from('inventory')
              .update({
                quantity: inv.quantity,
                lot_number: item.lot_number || existingInv.lot_number
              })
              .eq('id', existingInv.id)

            if (updateError) {
              console.error(`      ❌ 재고 업데이트 실패:`, updateError.message)
            } else {
              inventoryUpdated++
            }
          } else {
            // 새 재고 생성
            const { error: insertError } = await supabase
              .from('inventory')
              .insert([{
                product_id: productId,
                warehouse_id: warehouseId,
                quantity: inv.quantity,
                lot_number: item.lot_number,
                company_id: profile?.company_id
              }])

            if (insertError) {
              console.error(`      ❌ 재고 생성 실패:`, insertError.message)
            } else {
              inventoryCreated++
            }
          }
        }
      }

      // 최종 결과 출력

      // 업로드 완료 후 임박 상품 자동 체크 및 이메일 발송
      fetch('/api/check-expiry-alert', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ company_id: profile?.company_id })
      }).then(res => res.json()).then(result => {
        if (result.sent) {
        } else {
        }
      }).catch(err => console.error('📧 임박 알림 발송 실패:', err))

      alert(`업로드 완료!\n\n제품: 신규 ${productCreated}개, 기존 ${productExisted}개\n재고: 신규 ${inventoryCreated}개, 업데이트 ${inventoryUpdated}개`)
      setParsedData([])
      setFileName('')
      setRawData([])
      setDetectedColumns([])
      setDetectedWarehouses([])
      setUploadStep('file')
      // 창고별 매핑 초기화
      const resetWarehouseMapping: { [key: string]: string } = {}
      warehouses.forEach(w => {
        resetWarehouseMapping[w.id] = ''
      })
      setColumnMapping({
        product_name: '',
        product_code: '',
        product_group: '',
        lot_number: '',
        general_qty: '',
        warehouse_qty: resetWarehouseMapping
      })
    } catch (error) {
      console.error('❌ [에러] 업로드 중 예외 발생:', error)
      alert('업로드 중 오류가 발생했습니다. F12 콘솔을 확인하세요.')
    } finally {
      setUploading(false)
    }
  }

  return (
    <>
      <Navbar />
      <div className="min-h-screen bg-slate-50 pt-28 md:pt-20 p-4 md:p-8">
      <div className="max-w-4xl mx-auto">
        {/* 헤더 */}
        <div className="mb-8">
          <div className="flex justify-between items-start">
            <div>
              <h1 className="text-2xl font-bold text-gray-900">엑셀 업로드</h1>
              <p className="text-gray-500 mt-1">기존 재고 데이터를 한번에 업로드하세요</p>
            </div>
            <button
              onClick={() => setShowDeleteModal(true)}
              className="bg-red-100 text-red-700 px-4 py-2 rounded-lg hover:bg-red-200 transition text-sm font-medium"
            >
              기존 데이터 삭제
            </button>
          </div>
        </div>

        {/* 삭제 확인 모달 - 2단계 확인 */}
        {showDeleteModal && (
          <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50">
            <div className="bg-white rounded-lg shadow-xl p-6 max-w-md w-full mx-4">
              {/* 1단계: 삭제 옵션 선택 */}
              {deleteStep === 1 && (
                <>
                  <h3 className="text-xl font-bold text-gray-900 mb-4">데이터 삭제 (1/2)</h3>
                  <p className="text-gray-600 mb-4">
                    삭제할 데이터 범위를 선택하세요.
                  </p>

                  <div className="space-y-3 mb-6">
                    <label className="flex items-start gap-3 p-3 border rounded-lg cursor-pointer hover:bg-gray-50">
                      <input
                        type="radio"
                        name="deleteOption"
                        checked={deleteOption === 'inventory'}
                        onChange={() => setDeleteOption('inventory')}
                        className="mt-1"
                      />
                      <div>
                        <p className="font-medium text-gray-900">재고 + 입출고 기록만 삭제</p>
                        <p className="text-sm text-gray-500">제품 목록은 유지되고, 재고 수량과 입출고 기록만 삭제됩니다.</p>
                      </div>
                    </label>

                    <label className="flex items-start gap-3 p-3 border border-red-200 rounded-lg cursor-pointer hover:bg-red-50">
                      <input
                        type="radio"
                        name="deleteOption"
                        checked={deleteOption === 'all'}
                        onChange={() => setDeleteOption('all')}
                        className="mt-1"
                      />
                      <div>
                        <p className="font-medium text-red-700">전체 삭제 (창고 포함)</p>
                        <p className="text-sm text-gray-500">제품, 재고, 입출고 기록, 창고 모두 삭제됩니다.</p>
                      </div>
                    </label>
                  </div>

                  <div className="flex gap-3">
                    <button
                      onClick={closeDeleteModal}
                      className="flex-1 px-4 py-2 border rounded-lg hover:bg-gray-50 transition"
                    >
                      취소
                    </button>
                    <button
                      onClick={() => setDeleteStep(2)}
                      className="flex-1 px-4 py-2 bg-red-600 text-white rounded-lg hover:bg-red-700 transition"
                    >
                      다음
                    </button>
                  </div>
                </>
              )}

              {/* 2단계: 최종 확인 */}
              {deleteStep === 2 && (
                <>
                  <div className="text-center mb-6">
                    <div className="w-16 h-16 bg-red-100 rounded-full flex items-center justify-center mx-auto mb-4">
                      <span className="text-3xl">⚠️</span>
                    </div>
                    <h3 className="text-xl font-bold text-red-700 mb-2">최종 확인 (2/2)</h3>
                    <p className="text-gray-600">
                      이 작업은 <span className="font-bold text-red-600">되돌릴 수 없습니다.</span>
                    </p>
                  </div>

                  <div className="bg-red-50 border border-red-200 rounded-lg p-4 mb-6">
                    <p className="font-medium text-red-800 mb-2">삭제 대상:</p>
                    {deleteOption === 'all' ? (
                      <ul className="text-sm text-red-700 space-y-1">
                        <li>• 모든 제품 목록</li>
                        <li>• 모든 재고 데이터</li>
                        <li>• 모든 입출고 기록</li>
                        <li>• 모든 창고 정보</li>
                      </ul>
                    ) : (
                      <ul className="text-sm text-red-700 space-y-1">
                        <li>• 모든 재고 데이터</li>
                        <li>• 모든 입출고 기록</li>
                        <li className="text-gray-500">• 제품 목록은 유지됨</li>
                      </ul>
                    )}
                  </div>

                  <div className="flex gap-3">
                    <button
                      onClick={() => setDeleteStep(1)}
                      className="flex-1 px-4 py-2 border rounded-lg hover:bg-gray-50 transition"
                    >
                      이전
                    </button>
                    <button
                      onClick={handleDelete}
                      disabled={deleting}
                      className="flex-1 px-4 py-2 bg-red-600 text-white rounded-lg hover:bg-red-700 transition disabled:opacity-50 font-medium"
                    >
                      {deleting ? '삭제 중...' : '삭제 실행'}
                    </button>
                  </div>
                </>
              )}
            </div>
          </div>
        )}

        {/* 단계 표시 */}
        <div className="flex items-center gap-2 mb-6">
          <div className={`flex items-center gap-2 ${uploadStep === 'file' ? 'text-blue-600' : 'text-gray-400'}`}>
            <span className={`w-8 h-8 rounded-full flex items-center justify-center text-sm font-medium ${
              uploadStep === 'file' ? 'bg-blue-600 text-white' : 'bg-gray-200'
            }`}>1</span>
            <span className="text-sm font-medium">파일 선택</span>
          </div>
          <div className="w-8 h-0.5 bg-gray-200" />
          <div className={`flex items-center gap-2 ${uploadStep === 'sheet' ? 'text-blue-600' : 'text-gray-400'}`}>
            <span className={`w-8 h-8 rounded-full flex items-center justify-center text-sm font-medium ${
              uploadStep === 'sheet' ? 'bg-blue-600 text-white' : 'bg-gray-200'
            }`}>2</span>
            <span className="text-sm font-medium">시트 선택</span>
          </div>
          <div className="w-8 h-0.5 bg-gray-200" />
          <div className={`flex items-center gap-2 ${uploadStep === 'mapping' ? 'text-blue-600' : 'text-gray-400'}`}>
            <span className={`w-8 h-8 rounded-full flex items-center justify-center text-sm font-medium ${
              uploadStep === 'mapping' ? 'bg-blue-600 text-white' : 'bg-gray-200'
            }`}>3</span>
            <span className="text-sm font-medium">컬럼 매핑</span>
          </div>
          <div className="w-8 h-0.5 bg-gray-200" />
          <div className={`flex items-center gap-2 ${uploadStep === 'preview' ? 'text-blue-600' : 'text-gray-400'}`}>
            <span className={`w-8 h-8 rounded-full flex items-center justify-center text-sm font-medium ${
              uploadStep === 'preview' ? 'bg-blue-600 text-white' : 'bg-gray-200'
            }`}>4</span>
            <span className="text-sm font-medium">확인 및 업로드</span>
          </div>
        </div>

        {/* 1단계: 파일 선택 */}
        {uploadStep === 'file' && (
          <div className="bg-white rounded-lg shadow p-6 mb-8">
            <h2 className="text-xl font-semibold mb-4">파일 선택</h2>

            <div className="border-2 border-dashed border-gray-300 rounded-lg p-8 text-center">
              <input
                type="file"
                accept=".xlsx,.xls"
                onChange={handleFileUpload}
                className="hidden"
                id="fileInput"
              />
              <label
                htmlFor="fileInput"
                className="cursor-pointer text-blue-600 hover:text-blue-800"
              >
                {fileName ? (
                  <span className="text-gray-900 font-medium">{fileName}</span>
                ) : (
                  <span>클릭하여 엑셀 파일 선택 (.xlsx, .xls)</span>
                )}
              </label>
            </div>

            <div className="mt-4 p-4 bg-gray-50 rounded-lg">
              <p className="text-sm font-medium text-gray-700 mb-2">엑셀 형식 예시:</p>
              <p className="text-xs text-gray-500 mb-2">
                * 컬럼명이 달라도 AI가 자동으로 추론합니다. 확인 후 수정할 수 있습니다.
              </p>
              <table className="text-sm w-full">
                <thead>
                  <tr className="text-left text-gray-500">
                    <th className="pr-4">제품군</th>
                    <th className="pr-4">제품명</th>
                    <th className="pr-4">품번</th>
                    <th className="pr-4">로트번호</th>
                    <th className="pr-4">재고</th>
                  </tr>
                </thead>
                <tbody className="text-gray-700">
                  <tr>
                    <td className="pr-4">쿠션</td>
                    <td className="pr-4">쿠션 A</td>
                    <td className="pr-4">CUSH-A-01</td>
                    <td className="pr-4 font-mono">250115-01</td>
                    <td className="pr-4">1200</td>
                  </tr>
                </tbody>
              </table>
            </div>
          </div>
        )}

        {/* 2단계: 시트 선택 */}
        {uploadStep === 'sheet' && (
          <div className="bg-white rounded-lg shadow p-6 mb-8">
            <div className="flex justify-between items-start mb-6">
              <div>
                <h2 className="text-xl font-semibold">시트 선택</h2>
                <p className="text-gray-600 text-sm mt-1">
                  업로드할 시트를 선택하세요. 필요 없는 시트는 체크를 해제하세요.
                </p>
              </div>
              <button
                onClick={() => { setUploadStep('file'); setAllSheets([]); setSelectedSheets([]); setFileName('') }}
                className="text-gray-500 hover:text-gray-700 text-sm"
              >
                다른 파일 선택
              </button>
            </div>

            <div className="space-y-2 mb-6">
              {allSheets.map((sheet) => (
                <label
                  key={sheet.name}
                  className={`flex items-center gap-3 p-4 border-2 rounded-lg cursor-pointer transition ${
                    selectedSheets.includes(sheet.name)
                      ? 'border-blue-400 bg-blue-50'
                      : 'border-gray-200 bg-gray-50 opacity-60'
                  }`}
                >
                  <input
                    type="checkbox"
                    checked={selectedSheets.includes(sheet.name)}
                    onChange={(e) => {
                      if (e.target.checked) {
                        setSelectedSheets(prev => [...prev, sheet.name])
                      } else {
                        setSelectedSheets(prev => prev.filter(s => s !== sheet.name))
                      }
                    }}
                    className="w-4 h-4 text-blue-600"
                  />
                  <div className="flex-1">
                    <p className="font-medium text-gray-900">{sheet.name}</p>
                    <p className="text-sm text-gray-500">{sheet.rowCount}개 행</p>
                  </div>
                  {sheet.rowCount === 0 && (
                    <span className="text-xs text-orange-500 bg-orange-50 px-2 py-1 rounded">데이터 없음</span>
                  )}
                </label>
              ))}
            </div>

            <div className="flex justify-between items-center">
              <p className="text-sm text-gray-500">
                {selectedSheets.length}개 시트 선택됨
              </p>
              <button
                onClick={proceedFromSheetSelection}
                disabled={selectedSheets.length === 0}
                className="px-6 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition disabled:opacity-50"
              >
                다음: 컬럼 매핑
              </button>
            </div>
          </div>
        )}

        {/* 3단계: 컬럼 매핑 */}
        {uploadStep === 'mapping' && (
          <div className="bg-white rounded-lg shadow p-6 mb-8">
            <div className="flex justify-between items-start mb-6">
              <div>
                <h2 className="text-xl font-semibold">컬럼 매핑 확인</h2>
                <p className="text-gray-600 text-sm mt-1">
                  AI가 추론한 컬럼 매핑을 확인하고 필요시 수정하세요.
                </p>
              </div>
              <button
                onClick={() => {
                  setUploadStep('sheet')
                  setRawData([])
                  setDetectedColumns([])
                  setDetectedWarehouses([])
                }}
                className="text-gray-500 hover:text-gray-700 text-sm"
              >
                ← 시트 선택으로
              </button>
            </div>

            {/* 감지된 컬럼 */}
            <div className="bg-blue-50 border border-blue-200 rounded-lg p-4 mb-6">
              <p className="text-sm font-medium text-blue-800 mb-2">
                엑셀에서 감지된 컬럼 ({detectedColumns.length}개):
              </p>
              <div className="flex flex-wrap gap-2">
                {detectedColumns.map((col, idx) => (
                  <span key={idx} className="bg-white px-2 py-1 rounded text-xs text-blue-700 border border-blue-200">
                    {col}
                  </span>
                ))}
              </div>
            </div>

            {/* 매핑 설정 */}
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mb-6">
              {/* 필수 필드 */}
              <div className="space-y-4">
                <h3 className="font-medium text-gray-700 border-b pb-2">필수 정보</h3>

                <div>
                  <label className="block text-sm font-medium text-gray-600 mb-1">
                    제품명 <span className="text-red-500">*</span>
                  </label>
                  <select
                    value={columnMapping.product_name}
                    onChange={(e) => setColumnMapping(prev => ({ ...prev, product_name: e.target.value }))}
                    className="w-full border rounded-lg px-3 py-2 text-sm"
                  >
                    <option value="">-- 선택 --</option>
                    {detectedColumns.map(col => (
                      <option key={col} value={col}>{col}</option>
                    ))}
                  </select>
                </div>

                <div>
                  <label className="block text-sm font-medium text-gray-600 mb-1">
                    품번/제품코드 <span className="text-red-500">*</span>
                  </label>
                  <select
                    value={columnMapping.product_code}
                    onChange={(e) => setColumnMapping(prev => ({ ...prev, product_code: e.target.value }))}
                    className="w-full border rounded-lg px-3 py-2 text-sm"
                  >
                    <option value="">-- 선택 --</option>
                    {detectedColumns.map(col => (
                      <option key={col} value={col}>{col}</option>
                    ))}
                  </select>
                </div>

                <div>
                  <label className="block text-sm font-medium text-gray-600 mb-1">제품군/카테고리</label>
                  <select
                    value={columnMapping.product_group}
                    onChange={(e) => setColumnMapping(prev => ({ ...prev, product_group: e.target.value }))}
                    className="w-full border rounded-lg px-3 py-2 text-sm"
                  >
                    <option value="">-- 선택 안함 --</option>
                    {detectedColumns.map(col => (
                      <option key={col} value={col}>{col}</option>
                    ))}
                  </select>
                </div>
              </div>

              {/* 재고 및 로트 */}
              <div className="space-y-4">
                <h3 className="font-medium text-gray-700 border-b pb-2">재고 및 로트</h3>

                <div>
                  <label className="block text-sm font-medium text-gray-600 mb-1">로트번호/제조일자</label>
                  <select
                    value={columnMapping.lot_number}
                    onChange={(e) => setColumnMapping(prev => ({ ...prev, lot_number: e.target.value }))}
                    className="w-full border rounded-lg px-3 py-2 text-sm"
                  >
                    <option value="">-- 선택 안함 --</option>
                    {detectedColumns.map(col => (
                      <option key={col} value={col}>{col}</option>
                    ))}
                  </select>
                </div>

                {/* 엑셀에서 감지된 창고 표시 */}
                {detectedWarehouses.length > 0 ? (
                  <div className="p-4 bg-green-50 border border-green-200 rounded-lg">
                    <p className="text-sm font-medium text-green-800 mb-2">
                      🏭 엑셀에서 감지된 창고 ({detectedWarehouses.length}개):
                    </p>
                    <div className="space-y-2">
                      {detectedWarehouses.map((w, idx) => (
                        <div key={idx} className="flex items-center gap-2 text-sm">
                          <span className="bg-green-200 px-2 py-1 rounded text-green-800">
                            {w.name}
                          </span>
                          <span className="text-gray-500">←</span>
                          <span className="text-gray-600">{w.column}</span>
                        </div>
                      ))}
                    </div>
                    <p className="text-xs text-green-600 mt-2">
                      * 업로드 시 위 창고들이 자동으로 생성됩니다.
                    </p>
                  </div>
                ) : (
                  <div className="p-4 bg-yellow-50 border border-yellow-200 rounded-lg">
                    <p className="text-sm text-yellow-700">
                      ⚠️ 엑셀에서 창고별 재고 컬럼을 감지하지 못했습니다.
                    </p>
                    <p className="text-xs text-yellow-600 mt-1">
                      컬럼명에 "창고이름+재고" 형식이 필요합니다. (예: 오산창고재고, 남양주수량)
                    </p>
                  </div>
                )}

                <div>
                  <label className="block text-sm font-medium text-gray-600 mb-1">
                    일반 재고 <span className="text-xs text-gray-400">(창고 구분 없을 때)</span>
                  </label>
                  <select
                    value={columnMapping.general_qty}
                    onChange={(e) => setColumnMapping(prev => ({ ...prev, general_qty: e.target.value }))}
                    className="w-full border rounded-lg px-3 py-2 text-sm"
                  >
                    <option value="">-- 선택 안함 --</option>
                    {detectedColumns.map(col => (
                      <option key={col} value={col}>{col}</option>
                    ))}
                  </select>
                </div>
              </div>
            </div>

            {/* 샘플 데이터 미리보기 */}
            {rawData.length > 0 && (
              <div className="mb-6">
                <h3 className="font-medium text-gray-700 mb-2">샘플 데이터 (처음 3행)</h3>
                <div className="overflow-x-auto">
                  <table className="text-xs w-full border">
                    <thead className="bg-gray-50">
                      <tr>
                        {detectedColumns.map(col => (
                          <th key={col} className="border px-2 py-1 text-left">{col}</th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {rawData.slice(0, 3).map((row, idx) => (
                        <tr key={idx}>
                          {detectedColumns.map(col => (
                            <td key={col} className="border px-2 py-1">
                              {String(row[col] ?? '')}
                            </td>
                          ))}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            )}

            {/* 버튼 */}
            <div className="flex justify-end gap-3">
              <button
                onClick={() => {
                  setUploadStep('file')
                  setRawData([])
                  setDetectedColumns([])
                }}
                className="px-4 py-2 border rounded-lg hover:bg-gray-50 transition"
              >
                취소
              </button>
              <button
                onClick={applyMappingAndParse}
                disabled={!columnMapping.product_name && !columnMapping.product_code}
                className="px-6 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition disabled:opacity-50"
              >
                다음: 데이터 확인
              </button>
            </div>
          </div>
        )}

        {/* AI 유통기한 추천 (preview 단계) */}
        {uploadStep === 'preview' && (
          <>
            {aiClassifying && (
              <div className="bg-blue-50 border border-blue-200 rounded-lg p-3 mb-3 text-sm text-blue-700">
                AI가 제품을 분석 중입니다...
              </div>
            )}
            {!aiClassifying && aiSuggestOff.length > 0 && (
              <div className="bg-amber-50 border border-amber-300 rounded-lg p-4 mb-3">
                <h3 className="text-sm font-semibold text-amber-800 mb-1">유통기한 관리 OFF 추천 ({aiSuggestOff.length}건)</h3>
                <p className="text-xs text-amber-700 mb-3">AI 분석 또는 제품군 기존 설정(상속) 기준으로 OFF 추천됩니다. OFF로 설정할 제품을 직접 선택하세요. <span className="font-bold">기본값은 ON</span>이며, 체크하지 않으면 ON으로 등록됩니다.</p>
                <div className="space-y-1.5">
                  {aiSuggestOff.map((name) => (
                    <label key={name} className="flex items-center gap-2 cursor-pointer">
                      <input
                        type="checkbox"
                        checked={userConfirmedOff.has(name)}
                        onChange={(e) => {
                          setUserConfirmedOff(prev => {
                            const next = new Set(prev)
                            if (e.target.checked) next.add(name)
                            else next.delete(name)
                            return next
                          })
                        }}
                        className="w-4 h-4 accent-amber-600"
                      />
                      <span className="text-sm text-gray-800">{name}</span>
                      {userConfirmedOff.has(name) && (
                        <span className="text-xs bg-gray-200 text-gray-600 px-1.5 py-0.5 rounded">유통기한 OFF</span>
                      )}
                    </label>
                  ))}
                </div>
              </div>
            )}
            {!aiClassifying && aiNeedsReview.length > 0 && (
              <div className="bg-orange-50 border border-orange-300 rounded-lg p-4 mb-3">
                <h3 className="text-sm font-semibold text-orange-800 mb-1">유통기한 관리 확인 필요 ({aiNeedsReview.length}건)</h3>
                <p className="text-xs text-orange-700 mb-2">세트/기획 상품 가능성이 있어 유통기한 관리 여부를 직접 확인해 주세요. 업로드 후 제품 관리 페이지에서 변경할 수 있습니다.</p>
                <div className="flex flex-wrap gap-1.5">
                  {aiNeedsReview.map((name) => (
                    <span key={name} className="text-xs bg-orange-100 text-orange-800 px-2 py-0.5 rounded border border-orange-200">{name}</span>
                  ))}
                </div>
              </div>
            )}
          </>
        )}

        {/* 3단계: 미리보기 및 업로드 */}
        {uploadStep === 'preview' && parsedData.length > 0 && (
          <div className="bg-white rounded-lg shadow p-6">
            <div className="flex justify-between items-center mb-4">
              <div>
                <h2 className="text-xl font-semibold">
                  데이터 확인 ({parsedData.length}개 제품)
                </h2>
                <p className="text-sm text-gray-500 mt-1">
                  아래 데이터가 맞는지 확인 후 업로드하세요.
                </p>
              </div>
              <div className="flex gap-2">
                <button
                  onClick={() => setUploadStep('mapping')}
                  className="px-4 py-2 border rounded-lg hover:bg-gray-50 transition text-sm"
                >
                  이전: 매핑 수정
                </button>
                <button
                  onClick={handleUpload}
                  disabled={uploading}
                  className="bg-green-600 text-white px-6 py-2 rounded-lg hover:bg-green-700 transition disabled:opacity-50"
                >
                  {uploading ? '업로드 중...' : '확정 업로드'}
                </button>
              </div>
            </div>

            <table className="w-full">
              <thead>
                <tr className="text-left text-gray-500 border-b">
                  <th className="pb-3">제품군</th>
                  <th className="pb-3">제품명</th>
                  <th className="pb-3">품번</th>
                  <th className="pb-3">로트번호</th>
                  <th className="pb-3">재고</th>
                </tr>
              </thead>
              <tbody>
                {parsedData.map((item, idx) => (
                  <tr key={idx} className="border-b">
                    <td className="py-3">{item.product_group}</td>
                    <td className="py-3 font-medium">{item.product_name}</td>
                    <td className="py-3 text-gray-500">{item.product_code}</td>
                    <td className="py-3">
                      {item.lot_number ? (
                        <span className="font-mono text-blue-600">{item.lot_number}</span>
                      ) : (
                        <span className="text-gray-400">-</span>
                      )}
                    </td>
                    <td className="py-3">
                      {item.inventories.map((inv, i) => (
                        <span key={i} className="mr-3">
                          {inv.warehouse_name}: {inv.quantity.toLocaleString()}개
                        </span>
                      ))}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
    </>
  )
}
