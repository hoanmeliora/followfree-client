import { useCallback, useEffect, useMemo, useState } from 'react'
import './ScannerPage.css'

type LeadStatus = 'new' | 'read' | 'contacted'
type StatusFilter = 'all' | LeadStatus
type IndustryMode = 'RECRUITMENT' | 'SPA_BEAUTY'

interface ModePreset {
  keywordsText: string
  commentKeywordsText: string
  excludeKeywordsText: string
  maxPostLength: number
  keywordsPlaceholder: string
  commentKeywordsPlaceholder: string
  excludeKeywordsPlaceholder: string
  lengthLabel: string
  lengthHint: string
}

const MODE_PRESETS: Record<IndustryMode, ModePreset> = {
  RECRUITMENT: {
    keywordsText: 'tìm việc\ncần việc\nxin việc\ncông nhân thời vụ\nviệc làm',
    commentKeywordsText: 'ib e với\nquan tâm\ncòn tuyển ko\ncó giới hạn độ tuổi không\nbao nhiêu tuổi\nnhận nam ko\nchấm\n.\nxin info\nở đâu ạ',
    excludeKeywordsText: 'tuyển dụng\ntuyển gấp\nthu nhập\nmức lương\nyêu cầu hồ sơ\nxả kho\nsẵn hàng\nlắp mạng\nlắp wifi\nfpt\nviettel\nmỗi mẫu\nsale rẻ\nthanh lý\ntrả góp\nliệt sĩ\ntai nạn\ntừ thiện\nbán\ntài xỉu\nvay vốn',
    maxPostLength: 30,
    keywordsPlaceholder: 'tìm việc\ncần việc\nxin việc\ncông nhân thời vụ',
    commentKeywordsPlaceholder: 'ib e với\nquan tâm\ncòn tuyển ko\nbao nhiêu tuổi\nnhận nam ko\nchấm\n.',
    excludeKeywordsPlaceholder: 'tuyển dụng\ntuyển gấp\nthu nhập\nmức lương\nxả kho\nsale rẻ\nthanh lý',
    lengthLabel: '📏 Giới hạn số từ tối đa của bài viết (Mặc định 30 từ):',
    lengthHint: '* Bài viết của người tìm việc thật thường ngắn (dưới 30 từ). Bài dài nhiều hơn 30 từ chắc chắn là JD tuyển dụng của HR. Mặc định 30 từ để loại bỏ toàn bộ bài tuyển dụng dài của bọn HR.'
  },
  SPA_BEAUTY: {
    keywordsText: 'trị mụn\nnặn mụn\ntriệt lông\ntắm trắng\nchăm sóc da\nda bị nám\nxin review spa\nspa nào uy tín\nlàm nail\nnối mi\ngội đầu dưỡng sinh\npeel da',
    commentKeywordsText: 'giá sao ạ\nxin giá\ninbox e\nib giá\nở đâu vậy ạ\nđịa chỉ ở đâu\ntư vấn em với\nliệu trình mấy buổi\ncó đau không',
    excludeKeywordsText: 'tuyển mẫu\ntuyển học viên\nkhóa học spa\nsỉ mỹ phẩm\nkem trộn\nthanh lý giường spa\nthanh lý máy spa\nsang nhượng spa\ntuyển dụng\ntuyển gấp',
    maxPostLength: 100,
    keywordsPlaceholder: 'trị mụn\nnặn mụn\ntriệt lông\ntắm trắng\nchăm sóc da\nxin review spa',
    commentKeywordsPlaceholder: 'giá sao ạ\nxin giá\nib giá\nở đâu vậy ạ\nđịa chỉ ở đâu\ntư vấn em với',
    excludeKeywordsPlaceholder: 'tuyển mẫu\ntuyển học viên\nkhóa học spa\nsỉ mỹ phẩm\nthanh lý máy spa',
    lengthLabel: '📏 Giới hạn số từ tối đa của bài viết (Mặc định 100 từ):',
    lengthHint: '* Khách hỏi review spa, kinh nghiệm làm đẹp thường viết bài ngắn vừa phải. Bài dài hơn 100 từ thường là bài quảng cáo dịch vụ/bài PR của Spa đối thủ.'
  }
}

interface Lead {
  id: string
  groupName?: string
  authorName: string
  authorUrl?: string
  content: string
  postUrl: string
  postTimeText?: string
  matchedKeywords: string[]
  timestamp: number
  status: LeadStatus
  suggestedComment?: string
}

interface ScannerLogEntry {
  time: string
  message: string
}

const MAX_UI_LOGS = 100
const STATUS_LABEL: Record<LeadStatus, string> = {
  new: 'Mới',
  read: 'Đã xem',
  contacted: 'Đã liên hệ',
}

const splitLines = (value: string): string[] =>
  value.split('\n').map((line) => line.trim()).filter((line) => line.length > 0)

const escapeRegExp = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/** Highlight keywords as React nodes (no dangerouslySetInnerHTML -> no XSS from scraped content). */
function HighlightedText({ text, keywords }: { text: string; keywords: string[] }) {
  if (keywords.length === 0) return <>{text}</>
  const pattern = new RegExp(`(${keywords.map(escapeRegExp).join('|')})`, 'gi')
  const parts = text.split(pattern)
  return (
    <>
      {parts.map((part, index) =>
        keywords.some((k) => k.toLowerCase() === part.toLowerCase())
          ? <mark key={index} className="scanner-mark">{part}</mark>
          : <span key={index}>{part}</span>,
      )}
    </>
  )
}

function notifyNewLead(lead: Lead): void {
  if (typeof Notification === 'undefined') return
  const show = () => new Notification('🎯 Có khách mới', { body: `${lead.authorName}: ${lead.content.slice(0, 100)}` })
  if (Notification.permission === 'granted') show()
  else if (Notification.permission !== 'denied') Notification.requestPermission().then((p) => p === 'granted' && show())
}

export function ScannerPage() {
  const [industryMode, setIndustryMode] = useState<IndustryMode>('RECRUITMENT')
  const [configTab, setConfigTab] = useState<'target' | 'filters'>('target')
  const [groupsText, setGroupsText] = useState('')
  const [keywordsText, setKeywordsText] = useState('')
  const [commentKeywordsText, setCommentKeywordsText] = useState('')
  const [excludeKeywordsText, setExcludeKeywordsText] = useState('')
  const [autoFilterSpam, setAutoFilterSpam] = useState(true)
  const [scanComments, setScanComments] = useState(true)
  const [maxPostAgeDays, setMaxPostAgeDays] = useState(3)
  const [maxPostLength, setMaxPostLength] = useState(30)
  const [intervalMinutes, setIntervalMinutes] = useState(1)
  const [recipient, setRecipient] = useState('')
  const [isRunning, setIsRunning] = useState(false)
  const [isScanning, setIsScanning] = useState(false)
  const [leads, setLeads] = useState<Lead[]>([])
  const [logs, setLogs] = useState<ScannerLogEntry[]>([])
  const [filter, setFilter] = useState<StatusFilter>('all')
  const [message, setMessage] = useState<{ text: string; kind: 'error' | 'success' } | null>(null)
  const [generatingAiId, setGeneratingAiId] = useState<string | null>(null)

  useEffect(() => {
    const api = window.electronAPI
    api.scannerGetConfig().then((config) => {
      const mode = config.industryMode || 'RECRUITMENT'
      setIndustryMode(mode)
      setGroupsText(config.groups.join('\n'))
      setKeywordsText(config.keywords.join('\n'))
      setCommentKeywordsText((config.commentKeywords ?? []).join('\n'))
      setExcludeKeywordsText((config.excludeKeywords ?? []).join('\n'))
      setAutoFilterSpam(config.autoFilterSpam !== false)
      setScanComments(config.scanComments !== false)
      setMaxPostAgeDays(config.maxPostAgeDays ?? 3)
      setMaxPostLength(config.maxPostLength ?? (mode === 'SPA_BEAUTY' ? 100 : 30))
      setIntervalMinutes(config.intervalMinutes)
      setRecipient(config.notifyRecipient ?? '')
      setIsRunning(config.isRunning)
    })
    api.scannerGetLeads().then(setLeads)

    const disposers = [
      api.onScannerEvent('scanner:new_lead', (lead: Lead) => {
        setLeads((prev) => (prev.some((l) => l.id === lead.id) ? prev : [lead, ...prev]))
        notifyNewLead(lead)
      }),
      api.onScannerEvent('scanner:status', (s: { isRunning: boolean; scanning: boolean }) => {
        setIsRunning(s.isRunning)
        setIsScanning(s.scanning)
      }),
      api.onScannerEvent('scanner:log', (entry: ScannerLogEntry) =>
        setLogs((prev) => [entry, ...prev].slice(0, MAX_UI_LOGS)),
      ),
    ]
    return () => disposers.forEach((dispose) => dispose())
  }, [])

  const saveConfig = useCallback(async (): Promise<boolean> => {
    const result = await window.electronAPI.scannerSaveConfig({
      industryMode,
      groups: splitLines(groupsText),
      keywords: splitLines(keywordsText),
      commentKeywords: splitLines(commentKeywordsText),
      excludeKeywords: splitLines(excludeKeywordsText),
      autoFilterSpam,
      scanComments,
      maxPostAgeDays,
      maxPostLength,
      intervalMinutes,
      notifyRecipient: recipient,
    })
    if (!result.success) {
      setMessage({ text: result.error ?? 'Lưu thất bại', kind: 'error' })
      return false
    }
    const saved = await window.electronAPI.scannerGetConfig()
    setIndustryMode(saved.industryMode || 'RECRUITMENT')
    setGroupsText(saved.groups.join('\n'))
    setKeywordsText(saved.keywords.join('\n'))
    setCommentKeywordsText((saved.commentKeywords ?? []).join('\n'))
    setExcludeKeywordsText((saved.excludeKeywords ?? []).join('\n'))
    setAutoFilterSpam(saved.autoFilterSpam !== false)
    setScanComments(saved.scanComments !== false)
    setMaxPostAgeDays(saved.maxPostAgeDays ?? 3)
    setMaxPostLength(saved.maxPostLength ?? (saved.industryMode === 'SPA_BEAUTY' ? 100 : 30))
    setIntervalMinutes(saved.intervalMinutes)
    setRecipient(saved.notifyRecipient ?? '')
    setMessage({
      text: `Đã lưu cấu hình [${saved.industryMode === 'SPA_BEAUTY' ? '💆 Spa & Làm Đẹp' : '🎯 Tuyển Dụng & Việc Làm'}]`,
      kind: 'success',
    })
    return true
  }, [industryMode, groupsText, keywordsText, commentKeywordsText, excludeKeywordsText, autoFilterSpam, scanComments, maxPostAgeDays, maxPostLength, intervalMinutes, recipient])

  const switchIndustryMode = (targetMode: IndustryMode) => {
    if (targetMode === industryMode) return

    // 1. Lưu cấu hình hiện tại của mode cũ vào localStorage để tránh mất dữ liệu
    try {
      const currentDraft = {
        groupsText,
        keywordsText,
        commentKeywordsText,
        excludeKeywordsText,
        maxPostLength,
      }
      localStorage.setItem(`scanner_draft_${industryMode}`, JSON.stringify(currentDraft))
    } catch { }

    // 2. Nạp bản nháp đã lưu của targetMode hoặc nạp Preset chuẩn
    try {
      const savedTarget = localStorage.getItem(`scanner_draft_${targetMode}`)
      if (savedTarget) {
        const parsed = JSON.parse(savedTarget)
        if (parsed.keywordsText !== undefined) setKeywordsText(parsed.keywordsText)
        if (parsed.commentKeywordsText !== undefined) setCommentKeywordsText(parsed.commentKeywordsText)
        if (parsed.excludeKeywordsText !== undefined) setExcludeKeywordsText(parsed.excludeKeywordsText)
        if (parsed.maxPostLength !== undefined) setMaxPostLength(parsed.maxPostLength)
        if (parsed.groupsText !== undefined && parsed.groupsText.trim()) setGroupsText(parsed.groupsText)
      } else {
        const preset = MODE_PRESETS[targetMode]
        setKeywordsText(preset.keywordsText)
        setCommentKeywordsText(preset.commentKeywordsText)
        setExcludeKeywordsText(preset.excludeKeywordsText)
        setMaxPostLength(preset.maxPostLength)
      }
    } catch {
      const preset = MODE_PRESETS[targetMode]
      setKeywordsText(preset.keywordsText)
      setCommentKeywordsText(preset.commentKeywordsText)
      setExcludeKeywordsText(preset.excludeKeywordsText)
      setMaxPostLength(preset.maxPostLength)
    }

    setIndustryMode(targetMode)
    setMessage({
      text: `Đã chuyển sang chế độ: ${targetMode === 'SPA_BEAUTY' ? '💆 Spa & Làm Đẹp' : '🎯 Tuyển Dụng & Việc Làm'}`,
      kind: 'success',
    })
  }

  const toggleScanner = async () => {
    if (isRunning) {
      await window.electronAPI.scannerStop()
      return
    }
    if (!(await saveConfig())) return
    const result = await window.electronAPI.scannerStart()
    if (!result.success) setMessage({ text: result.error ?? 'Không thể bắt đầu', kind: 'error' })
  }

  const changeStatus = async (id: string, status: LeadStatus) => {
    await window.electronAPI.scannerUpdateLeadStatus(id, status)
    setLeads((prev) => prev.map((l) => (l.id === id ? { ...l, status } : l)))
  }

  const openPost = async (lead: Lead) => {
    await window.electronAPI.scannerOpenExternal(lead.postUrl)
    if (lead.status === 'new') await changeStatus(lead.id, 'read')
  }

  const clearAll = async () => {
    if (!window.confirm('Xóa toàn bộ danh sách khách đã bắt?')) return
    await window.electronAPI.scannerClearLeads()
    setLeads([])
  }

  const handleAiSuggest = async (lead: Lead) => {
    setGeneratingAiId(lead.id)
    try {
      const res = await window.electronAPI.aiGenerateLeadComment({
        postContent: lead.content,
        authorName: lead.authorName,
      })
      if (res.success && res.comment) {
        setLeads((prev) =>
          prev.map((l) => (l.id === lead.id ? { ...l, suggestedComment: res.comment } : l))
        )
      } else {
        alert(res.error || 'Lỗi tạo bình luận AI. Bạn đã cấu hình API Key và nạp việc bên Tab Trợ Lý AI chưa?')
      }
    } catch (err: any) {
      alert(err.message || 'Lỗi gọi AI')
    } finally {
      setGeneratingAiId(null)
    }
  }

  const visibleLeads = useMemo(
    () => (filter === 'all' ? leads : leads.filter((l) => l.status === filter)),
    [leads, filter],
  )
  const newCount = useMemo(() => leads.filter((l) => l.status === 'new').length, [leads])

  return (
    <div className="scanner-page">
      <div className="scanner-header">
        <h2>🎯 Săn Khách & Ứng Viên (Social Listening)</h2>
        <p>Quét bài viết và bình luận trong nhóm Facebook theo ngành nghề, hỗ trợ lọc khách hàng thật và né triệt để bài rác/đối thủ.</p>
      </div>

      <div className="scanner-layout">
        <section className="scanner-panel">
          <div className="scanner-industry-box">
            <span className="scanner-industry-title">Ngành Nghề Quét Khách</span>
            <div className="scanner-industry-switch">
              <button
                type="button"
                className={`scanner-industry-btn ${industryMode === 'RECRUITMENT' ? 'active' : ''}`}
                onClick={() => switchIndustryMode('RECRUITMENT')}
                disabled={isRunning}
              >
                🎯 Tuyển Dụng & Việc Làm
              </button>
              <button
                type="button"
                className={`scanner-industry-btn ${industryMode === 'SPA_BEAUTY' ? 'active' : ''}`}
                onClick={() => switchIndustryMode('SPA_BEAUTY')}
                disabled={isRunning}
              >
                💆 Spa & Làm Đẹp
              </button>
            </div>
          </div>

          <div className="scanner-tab-bar">
            <button
              className={`scanner-tab-btn ${configTab === 'target' ? 'active' : ''}`}
              onClick={() => setConfigTab('target')}
            >
              🎯 Mục tiêu & Từ khóa
            </button>
            <button
              className={`scanner-tab-btn ${configTab === 'filters' ? 'active' : ''}`}
              onClick={() => setConfigTab('filters')}
            >
              🛡️ Bình Luận & Né Bài
            </button>
          </div>

          {configTab === 'target' && (
            <div className="scanner-tab-content">
              <label className="scanner-label">Danh sách nhóm mục tiêu (Link nhóm, ID, hoặc Từ khóa tìm nhóm)</label>
              <textarea
                id="scanner-groups"
                className="scanner-textarea"
                rows={5}
                placeholder={'https://www.facebook.com/groups/123456789\n123456789\nViệc làm KCN Bắc Ninh Bình Dương'}
                value={groupsText}
                disabled={isRunning}
                onChange={(e) => setGroupsText(e.target.value)}
              />

              <label className="scanner-label">
                Từ khóa quét BÀI VIẾT ({industryMode === 'SPA_BEAUTY' ? 'Trị mụn, triệt lông, tắm trắng, nail, review spa...' : 'Tìm việc, xin việc, công nhân...'} - mỗi dòng 1 từ)
              </label>
              <textarea
                id="scanner-keywords"
                className="scanner-textarea"
                rows={5}
                placeholder={MODE_PRESETS[industryMode].keywordsPlaceholder}
                value={keywordsText}
                disabled={isRunning}
                onChange={(e) => setKeywordsText(e.target.value)}
              />

              <label className="scanner-label">Chỉ quét bài đăng trong vòng (ngày, mặc định 3 ngày đổ lại)</label>
              <input
                id="scanner-max-age"
                className="scanner-input"
                type="number"
                min={1}
                max={30}
                value={maxPostAgeDays}
                disabled={isRunning}
                onChange={(e) => setMaxPostAgeDays(Math.max(1, Math.min(30, Number(e.target.value) || 3)))}
              />
              <span className="scanner-hint-text">
                * Bỏ qua bài đăng cũ hơn {maxPostAgeDays} ngày. Khi gặp 5 bài cũ liên tiếp, tool sẽ tự dừng cuộn nhóm để chuyển sang nhóm kế tiếp.
              </span>

              <label className="scanner-label">Quét lại mỗi (phút, ví dụ: 120p = 2 tiếng, 600p = 10 tiếng)</label>
              <input
                id="scanner-interval"
                className="scanner-input"
                type="number"
                min={1}
                value={intervalMinutes}
                disabled={isRunning}
                onChange={(e) => setIntervalMinutes(Math.max(1, Number(e.target.value) || 1))}
              />
              <span className="scanner-hint-text">
                * Chu kỳ quét lặp lại: {intervalMinutes} phút ({intervalMinutes >= 60 ? `${Math.floor(intervalMinutes / 60)} giờ ${intervalMinutes % 60} phút` : `${intervalMinutes} phút`}).
              </span>

              <label className="scanner-label">Báo khách qua Messenger (Link Nhóm chat Messenger hoặc link cá nhân / ID)</label>
              <input
                id="scanner-recipient"
                className="scanner-input"
                type="text"
                placeholder="https://www.facebook.com/messages/t/123456789012345 (Link Nhóm chat hoặc cá nhân)"
                value={recipient}
                disabled={isRunning}
                onChange={(e) => setRecipient(e.target.value)}
              />
              <span className="scanner-hint-text">
                * Dán link Nhóm chat Messenger (dạng facebook.com/messages/t/ID) để bot tự động gửi danh sách ứng viên vào nhóm chat ngay khi vừa tìm thấy.
              </span>
            </div>
          )}

          {configTab === 'filters' && (
            <div className="scanner-tab-content">
              {/* Comment Keywords Box (Ô quét riêng cho bình luận) */}
              <label className="scanner-label">
                💬 Từ khóa quét BÌNH LUẬN ({industryMode === 'SPA_BEAUTY' ? 'Khách hỏi giá, xin tư vấn, địa chỉ...' : 'Ứng viên xin việc, hỏi ca, chấm...'} - mỗi dòng 1 từ)
              </label>
              <textarea
                id="scanner-comment-keywords"
                className="scanner-textarea"
                rows={5}
                placeholder={MODE_PRESETS[industryMode].commentKeywordsPlaceholder}
                value={commentKeywordsText}
                disabled={isRunning}
                onChange={(e) => {
                  const val = e.target.value
                  setCommentKeywordsText(val)
                  if (val.trim().length > 0 && !scanComments) {
                    setScanComments(true)
                  }
                }}
              />
              <span className="scanner-hint-text">
                * Chỉ bóc tách những bình luận khớp với các từ khóa này. Tự động bật chế độ quét bình luận khi có từ khóa.
              </span>

              {/* Exclude Keywords Box */}
              <label className="scanner-label" style={{ marginTop: '10px' }}>
                🚫 Từ khóa LOẠI TRỪ ({industryMode === 'SPA_BEAUTY' ? 'Né Spa đối thủ / Bán máy / Khóa học / Mỹ phẩm' : 'Né bài đối thủ / HR / Bán buôn / Spam'} - mỗi dòng 1 từ)
              </label>
              <textarea
                id="scanner-exclude-keywords"
                className="scanner-textarea"
                rows={5}
                placeholder={MODE_PRESETS[industryMode].excludeKeywordsPlaceholder}
                value={excludeKeywordsText}
                disabled={isRunning}
                onChange={(e) => setExcludeKeywordsText(e.target.value)}
              />

              <div className="scanner-option-box">
                <label className="scanner-checkbox-label">
                  <input
                    type="checkbox"
                    checked={scanComments}
                    disabled={isRunning}
                    onChange={(e) => setScanComments(e.target.checked)}
                  />
                  <span>
                    <strong>Quét cả Bình Luận (Comment Listening)</strong>
                    <small>Bắt bình luận khớp với ô từ khóa bình luận bên trên để không bỏ sót khách</small>
                  </span>
                </label>

                <label className="scanner-checkbox-label">
                  <input
                    type="checkbox"
                    checked={autoFilterSpam}
                    disabled={isRunning}
                    onChange={(e) => setAutoFilterSpam(e.target.checked)}
                  />
                  <span>
                    <strong>Tự động né bài quảng cáo / Shop</strong>
                    <small>Né các bài có Hotline, Zalo, STK, địa chỉ shop hoặc link Shopee/Lazada/TikTok</small>
                  </span>
                </label>
              </div>

              <div style={{ marginTop: '12px' }}>
                <label className="scanner-label" htmlFor="scanner-max-post-len">
                  {MODE_PRESETS[industryMode].lengthLabel}
                </label>
                <input
                  id="scanner-max-post-len"
                  type="number"
                  min={0}
                  max={1000}
                  step={5}
                  className="scanner-input"
                  style={{ width: '100%', marginTop: '4px' }}
                  value={maxPostLength}
                  disabled={isRunning}
                  onChange={(e) => setMaxPostLength(Math.max(0, parseInt(e.target.value, 10) || 0))}
                />
                <span className="scanner-hint-text">
                  {MODE_PRESETS[industryMode].lengthHint}
                </span>
              </div>
            </div>
          )}

          {message && <div className={`scanner-message ${message.kind}`}>{message.text}</div>}

          <div className="scanner-actions">
            <button id="scanner-save" className="scanner-btn secondary" disabled={isRunning} onClick={saveConfig}>
              Lưu cấu hình
            </button>
            <button id="scanner-toggle" className={`scanner-btn ${isRunning ? 'danger' : 'primary'}`} onClick={toggleScanner}>
              {isRunning ? '⏹ Dừng quét' : '▶ Bắt đầu quét'}
            </button>
          </div>

          <div className="scanner-state">
            <span className={`scanner-dot ${isRunning ? (isScanning ? 'scanning' : 'on') : 'off'}`} />
            {isRunning ? (isScanning ? 'Đang quét nhóm...' : 'Đang chờ lượt quét kế tiếp') : 'Đã dừng'}
          </div>

          <div className="scanner-log">
            {logs.length === 0 && <div className="scanner-log-empty">Chưa có nhật ký</div>}
            {logs.map((entry, index) => (
              <div key={index}><span className="scanner-log-time">{entry.time}</span> {entry.message}</div>
            ))}
          </div>
        </section>

        <section className="scanner-results">
          <div className="scanner-toolbar">
            <div className="scanner-filters">
              {(['all', 'new', 'read', 'contacted'] as StatusFilter[]).map((f) => (
                <button
                  key={f}
                  className={`scanner-chip ${filter === f ? 'active' : ''}`}
                  onClick={() => setFilter(f)}
                >
                  {f === 'all' ? `Tất cả (${leads.length})` : f === 'new' ? `Mới (${newCount})` : STATUS_LABEL[f]}
                </button>
              ))}
            </div>
            <button className="scanner-btn ghost" onClick={clearAll} disabled={leads.length === 0}>🗑 Xóa hết</button>
          </div>

          {visibleLeads.length === 0 && <div className="scanner-empty">Chưa có khách nào. Bấm "Bắt đầu quét" để tool đi tìm.</div>}

          {visibleLeads.map((lead) => (
            <article key={lead.id} className={`scanner-card ${lead.status}`}>
              <div className="scanner-card-head">
                <div>
                  <strong>{lead.authorName}</strong>
                  <span className="scanner-meta">
                    {lead.postTimeText ? ` · 🕒 ${lead.postTimeText}` : ''} · {lead.groupName || 'Nhóm'} · {new Date(lead.timestamp).toLocaleTimeString('vi-VN', { hour: '2-digit', minute: '2-digit' })}
                  </span>
                </div>
                <span className={`scanner-badge ${lead.status}`}>{STATUS_LABEL[lead.status]}</span>
              </div>
              <p className="scanner-content"><HighlightedText text={lead.content} keywords={lead.matchedKeywords} /></p>

              {lead.suggestedComment && (
                <div style={{
                  background: '#f8fafc',
                  border: '1px dashed #38bdf8',
                  padding: '8px 12px',
                  borderRadius: '6px',
                  margin: '8px 0',
                  fontSize: '13px',
                  color: '#0369a1'
                }}>
                  💡 <strong>Gợi ý AI:</strong> "{lead.suggestedComment}"
                  <button
                    style={{
                      marginLeft: '8px',
                      background: 'none',
                      border: 'none',
                      color: '#0284c7',
                      cursor: 'pointer',
                      fontSize: '12px',
                      textDecoration: 'underline'
                    }}
                    onClick={() => {
                      navigator.clipboard.writeText(lead.suggestedComment || '')
                      alert('Đã copy câu trả lời của AI vào clipboard!')
                    }}
                  >
                    Copy
                  </button>
                </div>
              )}

              <div className="scanner-card-foot">
                <button className="scanner-btn primary small" onClick={() => openPost(lead)}>Mở bài viết</button>
                <button
                  className="scanner-btn secondary small"
                  disabled={generatingAiId === lead.id}
                  onClick={() => handleAiSuggest(lead)}
                  style={{ background: 'rgba(147, 51, 234, 0.1)', color: '#9333ea', borderColor: '#d8b4fe' }}
                >
                  {generatingAiId === lead.id ? '⏳ Đang nghĩ...' : '🧠 AI gợi ý việc'}
                </button>
                {lead.authorUrl && (
                  <button className="scanner-btn secondary small" onClick={() => window.electronAPI.scannerOpenExternal(lead.authorUrl as string)}>
                    Trang người đăng
                  </button>
                )}
                <button className="scanner-btn secondary small" disabled={lead.status === 'contacted'} onClick={() => changeStatus(lead.id, 'contacted')}>
                  ✓ Đã liên hệ
                </button>
              </div>
            </article>
          ))}
        </section>
      </div>
    </div>
  )
}
