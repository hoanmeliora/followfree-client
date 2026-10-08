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
  matchedKeywords: string[]
  timestamp: number
  status: LeadStatus
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
  const [groupsText, setGroupsText] = useState('')
  const [keywordsText, setKeywordsText] = useState('')
  const [intervalMinutes, setIntervalMinutes] = useState(15)
  const [recipient, setRecipient] = useState('')
  const [isRunning, setIsRunning] = useState(false)
  const [isScanning, setIsScanning] = useState(false)
  const [leads, setLeads] = useState<Lead[]>([])
  const [logs, setLogs] = useState<ScannerLogEntry[]>([])
  const [filter, setFilter] = useState<StatusFilter>('all')
  const [message, setMessage] = useState<{ text: string; kind: 'error' | 'success' } | null>(null)

  useEffect(() => {
    const api = window.electronAPI
    api.scannerGetConfig().then((config) => {
      setGroupsText(config.groups.join('\n'))
      setKeywordsText(config.keywords.join('\n'))
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
    setIntervalMinutes(saved.intervalMinutes)
    setRecipient(saved.notifyRecipient ?? '')
    setMessage({ text: 'Đã lưu cấu hình', kind: 'success' })
    return true
  }, [groupsText, keywordsText, intervalMinutes, recipient])

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

  const visibleLeads = useMemo(
    () => (filter === 'all' ? leads : leads.filter((l) => l.status === filter)),
    [leads, filter],
  )
  const newCount = useMemo(() => leads.filter((l) => l.status === 'new').length, [leads])

  return (
    <div className="scanner-page">
      <div className="scanner-header">
        <h2>🎯 Săn Khách (Social Listening)</h2>
        <p>Tự động quét bài mới trong nhóm Facebook, báo ngay khi có người đăng đúng từ khóa bạn cần.</p>
      </div>

      <div className="scanner-layout">
        <section className="scanner-panel">
          <label className="scanner-label">Danh sách mục tiêu (Link nhóm, ID, hoặc Từ khóa tìm nhóm)</label>
          <textarea
            id="scanner-groups"
            className="scanner-textarea"
            rows={6}
            placeholder={'https://www.facebook.com/groups/123456789\n123456789\nViệc làm Hà Nội'}
            value={groupsText}
            disabled={isRunning}
            onChange={(e) => setGroupsText(e.target.value)}
          />

          <label className="scanner-label">Từ khóa (mỗi dòng 1 từ, không phân biệt dấu/hoa thường)</label>
          <textarea
            id="scanner-keywords"
            className="scanner-textarea"
            rows={6}
            placeholder={'tìm việc\ncần việc\nnhận làm'}
            value={keywordsText}
            disabled={isRunning}
            onChange={(e) => setKeywordsText(e.target.value)}
          />

          <label className="scanner-label">Quét lại mỗi (phút, tối thiểu 5)</label>
          <input
            id="scanner-interval"
            className="scanner-input"
            type="number"
            min={5}
            value={intervalMinutes}
            disabled={isRunning}
            onChange={(e) => setIntervalMinutes(Number(e.target.value))}
          />

          <label className="scanner-label">Nhắn Messenger báo khách cho (link trang cá nhân, username hoặc ID — để trống nếu không cần)</label>
          <input
            id="scanner-recipient"
            className="scanner-input"
            type="text"
            placeholder="https://www.facebook.com/ten.cua.ban"
            value={recipient}
            disabled={isRunning}
            onChange={(e) => setRecipient(e.target.value)}
          />

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
                  <span className="scanner-meta"> · {lead.groupName || 'Nhóm'} · {new Date(lead.timestamp).toLocaleString('vi-VN')}</span>
                </div>
                <span className={`scanner-badge ${lead.status}`}>{STATUS_LABEL[lead.status]}</span>
              </div>
              <p className="scanner-content"><HighlightedText text={lead.content} keywords={lead.matchedKeywords} /></p>
              <div className="scanner-card-foot">
                <button className="scanner-btn primary small" onClick={() => openPost(lead)}>Mở bài viết</button>
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
