import { useCallback, useEffect, useMemo, useState } from 'react'
import './ScannerPage.css'

type LeadStatus = 'new' | 'read' | 'contacted'
type StatusFilter = 'all' | LeadStatus

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
  const [configTab, setConfigTab] = useState<'target' | 'filters'>('target')
  const [groupsText, setGroupsText] = useState('')
  const [keywordsText, setKeywordsText] = useState('')
  const [commentKeywordsText, setCommentKeywordsText] = useState('')
  const [excludeKeywordsText, setExcludeKeywordsText] = useState('')
  const [autoFilterSpam, setAutoFilterSpam] = useState(true)
  const [scanComments, setScanComments] = useState(false)
  const [maxPostAgeDays, setMaxPostAgeDays] = useState(3)
  const [intervalMinutes, setIntervalMinutes] = useState(15)
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
      setGroupsText(config.groups.join('\n'))
      setKeywordsText(config.keywords.join('\n'))
      setCommentKeywordsText((config.commentKeywords ?? []).join('\n'))
      setExcludeKeywordsText((config.excludeKeywords ?? []).join('\n'))
      setAutoFilterSpam(config.autoFilterSpam !== false)
      setScanComments(config.scanComments === true)
      setMaxPostAgeDays(config.maxPostAgeDays ?? 3)
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
      groups: splitLines(groupsText),
      keywords: splitLines(keywordsText),
      commentKeywords: splitLines(commentKeywordsText),
      excludeKeywords: splitLines(excludeKeywordsText),
      autoFilterSpam,
      scanComments,
      maxPostAgeDays,
      intervalMinutes,
      notifyRecipient: recipient,
    })
    if (!result.success) {
      setMessage({ text: result.error ?? 'Lưu thất bại', kind: 'error' })
      return false
    }
    const saved = await window.electronAPI.scannerGetConfig()
    setGroupsText(saved.groups.join('\n'))
    setKeywordsText(saved.keywords.join('\n'))
    setCommentKeywordsText((saved.commentKeywords ?? []).join('\n'))
    setExcludeKeywordsText((saved.excludeKeywords ?? []).join('\n'))
    setAutoFilterSpam(saved.autoFilterSpam !== false)
    setScanComments(saved.scanComments === true)
    setMaxPostAgeDays(saved.maxPostAgeDays ?? 3)
    setIntervalMinutes(saved.intervalMinutes)
    setRecipient(saved.notifyRecipient ?? '')
    setMessage({ text: 'Đã lưu cấu hình bộ lọc săn khách', kind: 'success' })
    return true
  }, [groupsText, keywordsText, commentKeywordsText, excludeKeywordsText, autoFilterSpam, scanComments, maxPostAgeDays, intervalMinutes, recipient])

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
        <p>Quét bài viết và bình luận trong nhóm Facebook theo từ khóa mục tiêu, hỗ trợ lọc ý định tự do và né tin rác/đối thủ.</p>
      </div>

      <div className="scanner-layout">
        <section className="scanner-panel">
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

              <label className="scanner-label">Từ khóa quét BÀI VIẾT (Nhập từ khóa / ý định cần tìm - mỗi dòng 1 từ)</label>
              <textarea
                id="scanner-keywords"
                className="scanner-textarea"
                rows={5}
                placeholder={'tìm việc\ncần việc\nxin việc\ncông nhân thời vụ\nmua iphone 15'}
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
                * Bỏ qua bài đăng cũ hơn {maxPostAgeDays} ngày. Khi gặp 10 bài cũ liên tiếp, tool sẽ tự dừng cuộn nhóm để tiết kiệm thời gian.
              </span>

              <label className="scanner-label">Quét lại mỗi (phút, ví dụ: 120p = 2 tiếng, 600p = 10 tiếng)</label>
              <input
                id="scanner-interval"
                className="scanner-input"
                type="number"
                min={5}
                value={intervalMinutes}
                disabled={isRunning}
                onChange={(e) => setIntervalMinutes(Math.max(5, Number(e.target.value) || 15))}
              />
              <span className="scanner-hint-text">
                * Chu kỳ quét lặp lại: {intervalMinutes} phút ({Math.floor(intervalMinutes / 60)} giờ {intervalMinutes % 60} phút).
              </span>

              <label className="scanner-label">Báo khách qua Messenger (link cá nhân, username/ID — để trống nếu không dùng)</label>
              <input
                id="scanner-recipient"
                className="scanner-input"
                type="text"
                placeholder="https://www.facebook.com/ten.cua.ban"
                value={recipient}
                disabled={isRunning}
                onChange={(e) => setRecipient(e.target.value)}
              />
            </div>
          )}

          {configTab === 'filters' && (
            <div className="scanner-tab-content">
              {/* Comment Keywords Box (Ô quét riêng cho bình luận) */}
              <label className="scanner-label">
                💬 Từ khóa quét BÌNH LUẬN (Ô quét riêng cho comment - mỗi dòng 1 từ)
              </label>
              <textarea
                id="scanner-comment-keywords"
                className="scanner-textarea"
                rows={5}
                placeholder={'còn tuyển ko\nib e với\ngiá sao\nchấm\nrep ib\ncòn ko ạ\ncho e xin info\nnhận nam ko'}
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
                🚫 Từ khóa LOẠI TRỪ (Né bài đối thủ / HR / Bán buôn / Spam - mỗi dòng 1 từ)
              </label>
              <textarea
                id="scanner-exclude-keywords"
                className="scanner-textarea"
                rows={5}
                placeholder={'tuyển dụng\ntuyển gấp\nthu nhập\nmức lương\nyêu cầu hồ sơ\nxả kho\nsẵn hàng\nbán\ntài xỉu\nvay vốn'}
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
