import { useState, useEffect } from 'react'
import './AiAssistantPage.css'

export interface AiConfig {
  systemPrompt?: string
  jobList?: string[]
  jobsText?: string
}

export function AiAssistantPage() {
  const [config, setConfig] = useState<AiConfig>({
    systemPrompt: '',
    jobList: [],
  })

  const [activeSubTab, setActiveSubTab] = useState<'jobs' | 'test'>('jobs')
  const [saveMessage, setSaveMessage] = useState<{ text: string; kind: 'success' | 'error' } | null>(null)

  // State cho phần test AI
  const [testPostContent, setTestPostContent] = useState('')
  const [testAuthorName, setTestAuthorName] = useState('')
  const [testLoading, setTestLoading] = useState(false)
  const [testResult, setTestResult] = useState<string | null>(null)
  const [testError, setTestError] = useState<string | null>(null)

  useEffect(() => {
    if (window.electronAPI?.aiGetConfig) {
      window.electronAPI.aiGetConfig().then((savedConfig: any) => {
        if (savedConfig) {
          let loadedJobs: string[] = []
          if (Array.isArray(savedConfig.jobList)) {
            loadedJobs = savedConfig.jobList
          } else if (savedConfig.jobsText && savedConfig.jobsText.trim()) {
            loadedJobs = [savedConfig.jobsText.trim()]
          }

          setConfig({
            systemPrompt: savedConfig.systemPrompt || '',
            jobList: loadedJobs,
          })
        }
      })
    }
  }, [])

  const handleSaveConfig = async (newConfig?: AiConfig) => {
    const configToSave = newConfig || config
    try {
      const res = await window.electronAPI.aiSaveConfig(configToSave)
      if (res?.success) {
        setSaveMessage({ text: 'Đã lưu danh sách công việc thành công!', kind: 'success' })
      } else {
        setSaveMessage({ text: res?.error || 'Lỗi khi lưu danh sách công việc', kind: 'error' })
      }
    } catch (e: any) {
      setSaveMessage({ text: e.message || 'Lỗi kết nối', kind: 'error' })
    }
    setTimeout(() => setSaveMessage(null), 3000)
  }

  // Quản lý từng ô công việc riêng biệt
  const handleJobChange = (index: number, value: string) => {
    const updated = [...(config.jobList || [])]
    updated[index] = value
    setConfig({ ...config, jobList: updated })
  }

  const handleAddJobSlot = () => {
    const updated = [...(config.jobList || []), '']
    setConfig({ ...config, jobList: updated })
  }

  const handleDeleteJobSlot = (index: number) => {
    const updated = (config.jobList || []).filter((_, i) => i !== index)
    setConfig({ ...config, jobList: updated })
  }

  const handleTestAi = async () => {
    const hasJobs = (config.jobList || []).some((j) => j.trim().length > 0)
    if (!hasJobs) {
      alert('Vui lòng nhập nội dung cho ít nhất 1 ô công việc ở tab "Danh sách công việc" trước!')
      setActiveSubTab('jobs')
      return
    }

    setTestLoading(true)
    setTestResult(null)
    setTestError(null)

    try {
      const res = await window.electronAPI.aiGenerateLeadComment({
        postContent: testPostContent,
        authorName: testAuthorName,
      })
      if (res.success && res.comment) {
        setTestResult(res.comment)
      } else {
        setTestError(res.error || 'AI không trả về được câu bình luận')
      }
    } catch (err: any) {
      setTestError(err.message || 'Lỗi thử nghiệm AI')
    } finally {
      setTestLoading(false)
    }
  }

  return (
    <div className="ai-page-root">
      {/* Header */}
      <div className="ai-header">
        <div className="ai-title-wrap">
          <h2>🧠 Trợ Lý AI Tuyển Dụng & Bình Luận</h2>
          <p className="ai-desc">
            Tự động đọc bài viết tìm việc của ứng viên trên nhóm Facebook, đối chiếu danh sách các công việc và tạo câu bình luận gợi ý thông minh, tự nhiên.
          </p>
        </div>
      </div>

      {saveMessage && (
        <div className={`ai-alert ${saveMessage.kind}`}>
          {saveMessage.kind === 'success' ? '✅' : '❌'} {saveMessage.text}
        </div>
      )}

      {/* Tabs */}
      <div className="ai-tabs-nav">
        <button
          className={`ai-tab-btn ${activeSubTab === 'jobs' ? 'active' : ''}`}
          onClick={() => setActiveSubTab('jobs')}
        >
          📋 Danh sách công việc ({(config.jobList || []).length} ô)
        </button>
        <button
          className={`ai-tab-btn ${activeSubTab === 'test' ? 'active' : ''}`}
          onClick={() => setActiveSubTab('test')}
        >
          🧪 Thử nghiệm gợi ý (Test)
        </button>
      </div>

      {/* SUBTAB 1: MỖI CÔNG VIỆC 1 Ô RIÊNG BIỆT */}
      {activeSubTab === 'jobs' && (
        <div className="ai-content-section">
          <div className="ai-card">
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '16px' }}>
              <div>
                <h3 style={{ margin: 0 }}>📋 Mỗi công việc nhập vào 1 ô riêng biệt</h3>
                <p className="ai-hint" style={{ margin: '4px 0 0 0' }}>
                  Điền đầy đủ thông tin (vị trí, khu vực, ca làm, mức lương...) cho từng công việc vào ô riêng dưới đây. Bấm "+ Thêm ô công việc" để thêm vị trí mới.
                </p>
              </div>
              <button
                type="button"
                className="ai-btn-primary"
                style={{ margin: 0 }}
                onClick={handleAddJobSlot}
              >
                ➕ Thêm ô công việc
              </button>
            </div>

            <div style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
              {(config.jobList || []).map((jobText, index) => (
                <div
                  key={index}
                  style={{
                    border: '1px solid #e2e8f0',
                    borderRadius: '8px',
                    padding: '14px',
                    background: '#ffffff',
                    boxShadow: '0 1px 2px rgba(0,0,0,0.03)',
                  }}
                >
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '8px' }}>
                    <strong style={{ fontSize: '14px', color: '#0369a1' }}>
                      💼 Công việc #{index + 1}
                    </strong>
                    <button
                      type="button"
                      className="ai-btn-delete"
                      onClick={() => handleDeleteJobSlot(index)}
                      title="Xóa ô công việc này"
                    >
                      🗑 Xóa ô này
                    </button>
                  </div>
                  <textarea
                    rows={5}
                    style={{
                      width: '100%',
                      fontFamily: 'inherit',
                      fontSize: '13px',
                      lineHeight: '1.5',
                      padding: '10px 12px',
                      borderRadius: '6px',
                      border: '1px solid #cbd5e1',
                      boxSizing: 'border-box',
                    }}
                    placeholder={`Nhập thông tin công việc ${index + 1} (Tên việc, khu vực, ca làm, mức lương, yêu cầu, hotline...)...`}
                    value={jobText}
                    onChange={(e) => handleJobChange(index, e.target.value)}
                  />
                </div>
              ))}

              {(config.jobList || []).length === 0 && (
                <div style={{ textAlign: 'center', padding: '30px', color: '#94a3b8' }}>
                  Chưa có ô công việc nào. Bấm <strong>"+ Thêm ô công việc"</strong> phía trên để bắt đầu nhập!
                </div>
              )}
            </div>

            <div style={{ display: 'flex', gap: '10px', marginTop: '20px' }}>
              <button
                type="button"
                className="ai-btn-primary"
                onClick={() => handleSaveConfig()}
              >
                💾 Lưu toàn bộ công việc
              </button>
              <button
                type="button"
                className="ai-btn-secondary"
                onClick={handleAddJobSlot}
              >
                ➕ Thêm ô công việc khác
              </button>
            </div>
          </div>
        </div>
      )}

      {/* SUBTAB 2: TEST GỢI Ý */}
      {activeSubTab === 'test' && (
        <div className="ai-content-section">
          <div className="ai-card">
            <h3>🧪 Mô phỏng tình huống thực tế</h3>
            <p className="ai-hint">
              Nhập một bài viết tìm việc giả lập để kiểm tra xem AI suy luận và chọn việc trong các ô bạn đã nhập như thế nào trước khi áp dụng thực tế.
            </p>

            <div className="ai-form-group">
              <label>Tên người tìm việc</label>
              <input
                type="text"
                value={testAuthorName}
                onChange={(e) => setTestAuthorName(e.target.value)}
              />
            </div>

            <div className="ai-form-group">
              <label>Nội dung bài viết tìm việc</label>
              <textarea
                rows={3}
                value={testPostContent}
                onChange={(e) => setTestPostContent(e.target.value)}
                placeholder="Nhập nội dung bài đăng tìm việc..."
              />
            </div>

            <button
              className="ai-btn-primary"
              onClick={handleTestAi}
              disabled={testLoading}
            >
              {testLoading ? '⏳ AI đang suy nghĩ & chọn việc...' : '🚀 Chạy thử nghiệm AI'}
            </button>

            {testResult && (
              <div className="ai-test-result">
                <h4>🎯 Kết quả bình luận do AI tạo ra:</h4>
                <div className="ai-result-box">
                  "{testResult}"
                </div>
                <p className="ai-word-count">Độ dài: {testResult.split(/\s+/).length} từ</p>
              </div>
            )}

            {testError && (
              <div className="ai-alert error" style={{ marginTop: '16px' }}>
                ❌ Lỗi: {testError}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  )
}
