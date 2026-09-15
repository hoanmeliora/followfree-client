import React, { useState, useEffect, useCallback } from 'react'
import './DashboardPage.css'

import AutoRegPage from './AutoRegPage'
import AutoPostPage from './AutoPostPage'

interface Props {
  session: {
    token: string
    user: { id: string; username: string; email: string; role: string; points: number; balance: number }
  }
  onLogout: () => void
  onSessionUpdate?: (session: any) => void
}

interface WorkerStatus {
  running: boolean
  connected: boolean
  tasksCompleted: number
  totalPointsEarned: number
  currentTask: string | null
  currentAccountName?: string
  accountCount: number
}

interface LogEntry {
  time: string
  message: string
  type: 'info' | 'success' | 'warning' | 'error'
}

export function DashboardPage({ session, onLogout, onSessionUpdate }: Props) {
  const [status, setStatus] = useState<WorkerStatus>({
    running: false, connected: false,
    tasksCompleted: 0, totalPointsEarned: 0,
    currentTask: null, accountCount: 0,
  })
  const [logs, setLogs] = useState<LogEntry[]>([])
  const [showProfileMenu, setShowProfileMenu] = useState(false)
  const [showPasswordModal, setShowPasswordModal] = useState(false)
  const [passwordForm, setPasswordForm] = useState({ oldPassword: '', newPassword: '' })
  const [passwordError, setPasswordError] = useState('')
  const [activeTab, setActiveTab] = useState<'dashboard' | 'accounts' | 'campaigns' | 'deposits' | 'emails' | 'autoreg' | 'autopost' | 'settings'>('dashboard')
  const [appSettings, setAppSettings] = useState({ runHeadless: false })

  const addLog = useCallback((message: string, type: LogEntry['type'] = 'info') => {
    const time = new Date().toLocaleTimeString('vi-VN')
    setLogs((prev) => [{ time, message, type }, ...prev].slice(0, 100))
  }, [])

  useEffect(() => {
    // Load initial status
    window.electronAPI?.getWorkerStatus().then(setStatus)
    
    // Load settings
    window.electronAPI?.getSettings?.().then((settings: any) => {
      if (settings) setAppSettings(settings)
    })

    // Listen to events from main process
    const onStatusUpdate = (data: WorkerStatus) => setStatus(data)
    const onConnected = (connected: boolean) => {
      addLog(connected ? '✅ Đã kết nối đến server' : '📴 Mất kết nối với server',
        connected ? 'success' : 'warning')
    }
    const onSynced = (count: number) => {
      addLog(`📥 Đã đồng bộ ${count} tài khoản từ server`, 'success')
    }
    const onTaskDone = (data: any) => {
      const accountInfo = data.accountName ? ` (bởi nick ${data.accountName})` : '';
      addLog(`✔ Hoàn thành task ${data.taskId?.slice(0, 8)}...${accountInfo}`, 'success')
    }
    const onError = (data: any) => {
      addLog(`❌ ${data.title}: ${data.message}`, 'error')
      alert(`${data.title}\n\n${data.message}`)
    }
    const onWarning = (data: any) => {
      addLog(`⚠️ ${data.title}: ${data.message}`, 'warning')
      // Hiển thị cảnh báo nhưng không block UI
      setTimeout(() => alert(`⚠️ ${data.title}\n\n${data.message}`), 500)
    }

    window.electronAPI?.on('worker:status', onStatusUpdate)
    window.electronAPI?.on('worker:connected', onConnected)
    window.electronAPI?.on('worker:accounts_synced', onSynced)
    window.electronAPI?.on('worker:task_completed', onTaskDone)
    window.electronAPI?.on('worker:error', onError)
    window.electronAPI?.on('worker:warning', onWarning)

    return () => {
      window.electronAPI?.off('worker:status', onStatusUpdate)
      window.electronAPI?.off('worker:connected', onConnected)
      window.electronAPI?.off('worker:accounts_synced', onSynced)
      window.electronAPI?.off('worker:task_completed', onTaskDone)
      window.electronAPI?.off('worker:error', onError)
      window.electronAPI?.off('worker:warning', onWarning)
    }
  }, [addLog])

  const toggleWorker = async () => {
    if (status.running) {
      await window.electronAPI?.stopWorker()
      addLog('⏹ Đã dừng Worker', 'warning')
    } else {
      const result = await window.electronAPI?.startWorker()
      if (result?.error) {
        addLog(`❌ ${result.error}`, 'error')
      } else {
        addLog('▶️ Đã bắt đầu Worker', 'success')
      }
    }
  }

  const toggleHeadless = async () => {
    const newVal = !appSettings.runHeadless;
    setAppSettings(prev => ({ ...prev, runHeadless: newVal }));
    if (window.electronAPI?.updateSettings) {
      await window.electronAPI.updateSettings({ ...appSettings, runHeadless: newVal });
      addLog(newVal ? '⚙️ Đã bật Chế độ chạy ngầm' : '⚙️ Đã tắt Chế độ chạy ngầm (Hiện trình duyệt)', 'info');
    }
  }

  const handleChangePassword = async (e: React.FormEvent) => {
    e.preventDefault()
    setPasswordError('')
    if (passwordForm.newPassword.length < 6) {
      setPasswordError('Mật khẩu mới phải có ít nhất 6 ký tự')
      return
    }
    const res = await window.electronAPI?.changePassword(passwordForm.oldPassword, passwordForm.newPassword)
    if (res?.success) {
      alert('Đổi mật khẩu thành công! V vui lòng đăng nhập lại.')
      setShowPasswordModal(false)
      onLogout()
    } else {
      setPasswordError(res?.error || 'Lỗi đổi mật khẩu')
    }
  }

  return (
    <div className="dashboard-root">
      {/* Custom Titlebar */}
      <div className="titlebar">
        <div className="brand-mini">⚡ FollowFree</div>
        <div className="titlebar-drag" />
        <div className="titlebar-controls">
          <button onClick={() => window.electronAPI?.minimizeWindow()} className="ctrl-btn">─</button>
          <button onClick={() => window.electronAPI?.hideWindow()} className="ctrl-btn close">✕</button>
        </div>
      </div>

      <div className="dashboard-layout">
        {/* Sidebar */}
        <aside className="sidebar">
          {/* User Info */}
          <div style={{ position: 'relative' }}>
            <div 
              className="user-card" 
              onClick={() => setShowProfileMenu(!showProfileMenu)}
              style={{ cursor: 'pointer', transition: 'all 0.2s', border: showProfileMenu ? '1px solid var(--accent)' : '' }}
            >
              <div className="avatar">{session.user.username[0].toUpperCase()}</div>
              <div className="user-info">
                <span className="username">{session.user.username}</span>
                <span className="user-role">{session.user.role}</span>
              </div>
              <div style={{ marginLeft: 'auto', color: 'var(--text-secondary)' }}>▼</div>
            </div>

            {/* Profile Menu Dropdown */}
            {showProfileMenu && (
              <div style={{
                position: 'absolute', top: '100%', left: 0, right: 0, zIndex: 100,
                background: 'var(--bg-secondary)', border: '1px solid var(--border)',
                borderRadius: '8px', padding: '10px', boxShadow: '0 4px 12px rgba(0,0,0,0.5)',
                display: 'flex', flexDirection: 'column', gap: '8px'
              }}>
                <div style={{ fontSize: '13px', color: 'var(--text-secondary)' }}>Email: <span style={{ color: '#fff', fontWeight: 'bold' }}>{session.user.email}</span></div>
                <div style={{ fontSize: '13px', color: 'var(--text-secondary)' }}>UID: <span style={{ color: '#fff', fontWeight: 'bold' }}>{session.user.id.slice(0, 8)}...</span></div>
                <div style={{ fontSize: '13px', color: 'var(--text-secondary)' }}>Số dư: <span style={{ color: '#4CAF50', fontWeight: 'bold' }}>{session.user.balance.toLocaleString()} ₫</span></div>
                <hr style={{ border: 'none', borderTop: '1px solid var(--border)', margin: '4px 0' }} />
                
                <button 
                  onClick={() => {
                    setShowProfileMenu(false);
                    setShowPasswordModal(true);
                  }}
                  style={{ 
                    background: 'transparent', color: 'var(--accent-light)', border: 'none', 
                    textAlign: 'left', padding: '6px', cursor: 'pointer', borderRadius: '4px'
                  }}
                  onMouseOver={(e) => e.currentTarget.style.background = 'rgba(167, 139, 250, 0.1)'}
                  onMouseOut={(e) => e.currentTarget.style.background = 'transparent'}
                >
                  🔒 Đổi mật khẩu
                </button>

                <button 
                  onClick={onLogout}
                  style={{ 
                    background: 'transparent', color: 'var(--danger)', border: 'none', 
                    textAlign: 'left', padding: '6px', cursor: 'pointer', borderRadius: '4px'
                  }}
                  onMouseOver={(e) => e.currentTarget.style.background = 'rgba(239, 68, 68, 0.1)'}
                  onMouseOut={(e) => e.currentTarget.style.background = 'transparent'}
                >
                  🚪 Đăng xuất ngay
                </button>
              </div>
            )}
          </div>

          {/* Points */}
          <div className="points-card">
            <div className="points-label">Số Xu tích lũy</div>
            <div className="points-value">
              {(session.user.points + status.totalPointsEarned).toLocaleString()}
              <span className="points-unit">Xu</span>
            </div>
          </div>

          {/* Navigation */}
          <nav className="sidebar-nav">
            <button
              className={`nav-item ${activeTab === 'dashboard' ? 'active' : ''}`}
              onClick={() => setActiveTab('dashboard')}
            >
              <span className="nav-icon">📊</span> Dashboard
            </button>
            <button
              className={`nav-item ${activeTab === 'accounts' ? 'active' : ''}`}
              onClick={() => setActiveTab('accounts')}
            >
              <span className="nav-icon">👤</span> Tài khoản ({status.accountCount})
            </button>
            <button
              className={`nav-item ${activeTab === 'campaigns' ? 'active' : ''}`}
              onClick={() => setActiveTab('campaigns')}
            >
              <span className="nav-icon">🚀</span> Mua Tương Tác
            </button>
            <button
              className={`nav-item ${activeTab === 'deposits' ? 'active' : ''}`}
              onClick={() => setActiveTab('deposits')}
            >
              <span className="nav-icon">💳</span> Nạp Xu
            </button>
            <button
              className={`nav-item ${activeTab === 'autopost' ? 'active' : ''}`}
              onClick={() => setActiveTab('autopost')}
              style={{ background: activeTab === 'autopost' ? '' : 'rgba(76, 175, 80, 0.1)', color: activeTab === 'autopost' ? '' : '#4CAF50' }}
            >
              <span className="nav-icon">🔄</span> Auto Post Nhóm
            </button>
            <button
              className={`nav-item ${activeTab === 'autoreg' ? 'active' : ''}`}
              onClick={() => setActiveTab('autoreg')}
              style={{ background: activeTab === 'autoreg' ? '' : 'rgba(233, 69, 96, 0.1)', color: activeTab === 'autoreg' ? '' : '#e94560' }}
            >
              <span className="nav-icon">🤖</span> Tạo Tài Khoản
            </button>
            <button
              className={`nav-item ${activeTab === 'emails' ? 'active' : ''}`}
              onClick={() => setActiveTab('emails')}
            >
              <span className="nav-icon">📧</span> Nhận Email
            </button>
            <button
              className={`nav-item ${activeTab === 'settings' ? 'active' : ''}`}
              onClick={() => setActiveTab('settings')}
            >
              <span className="nav-icon">⚙️</span> Cài đặt ứng dụng
            </button>
          </nav>

          <div style={{ flex: 1 }}></div>

          {/* Logout */}
          <button className="logout-btn" onClick={onLogout}>⬅ Đăng xuất</button>
        </aside>

        {/* Main Content */}
        <main className="main-content">
          {activeTab === 'dashboard' && (
            <>
              {/* Status Banner */}
              <div className={`status-banner ${status.running ? 'running' : 'stopped'}`}>
                <div className="status-dot" />
                <span>{status.running
                  ? status.connected ? 'Đang chạy - Đã kết nối server' : 'Đang chạy - Đang kết nối...'
                  : 'Đã dừng'
                }</span>
                {status.currentTask && (
                  <span className="current-task">
                    Đang xử lý: {status.currentTask.slice(0, 8)}... {status.currentAccountName ? `(Bởi: ${status.currentAccountName})` : ''}
                  </span>
                )}
              </div>

              {/* Stats Grid */}
              <div className="stats-grid">
                <div className="stat-card">
                  <div className="stat-icon">✅</div>
                  <div className="stat-value">{status.tasksCompleted.toLocaleString()}</div>
                  <div className="stat-label">Task hoàn thành</div>
                </div>
                <div className="stat-card">
                  <div className="stat-icon">⭐</div>
                  <div className="stat-value">{status.totalPointsEarned.toLocaleString()}</div>
                  <div className="stat-label">Số Xu kiếm được</div>
                </div>
                <div className="stat-card">
                  <div className="stat-icon">👤</div>
                  <div className="stat-value">{status.accountCount.toLocaleString()}</div>
                  <div className="stat-label">Tài khoản clone</div>
                </div>
              </div>

              {/* Control Button */}
              <button
                className={`control-btn ${status.running ? 'stop' : 'start'}`}
                onClick={toggleWorker}
              >
                {status.running ? '⏹ Dừng Worker' : '▶ Bắt đầu cày'}
              </button>

              {/* Activity Log */}
              <div className="log-section">
                <h3 className="log-title">Nhật ký hoạt động</h3>
                <div className="log-container">
                  {logs.length === 0 ? (
                    <p className="log-empty">Chưa có hoạt động nào. Nhấn "Bắt đầu cày" để bắt đầu!</p>
                  ) : (
                    logs.map((log, i) => (
                      <div key={i} className={`log-entry ${log.type}`}>
                        <span className="log-time">{log.time}</span>
                        <span className="log-msg">{log.message}</span>
                      </div>
                    ))
                  )}
                </div>
              </div>
            </>
          )}

          {activeTab === 'accounts' && (
            <AccountsTab accountCount={status.accountCount} />
          )}

          {activeTab === 'campaigns' && (
            <CampaignsTab userPoints={session.user.points + status.totalPointsEarned} />
          )}

          {activeTab === 'deposits' && (
            <DepositsTab onRefresh={async () => {
              const res = await (window as any).electronAPI?.getMe()
              if (res?.success && onSessionUpdate) {
                onSessionUpdate({ token: session.token, user: res.data })
              }
            }} />
          )}

          {activeTab === 'emails' && (
            <EmailTab />
          )}

          {activeTab === 'autoreg' && (
            <AutoRegPage goToAccounts={() => setActiveTab('accounts')} />
          )}

          {activeTab === 'autopost' && (
            <AutoPostPage addLog={addLog} session={session} />
          )}

          {activeTab === 'settings' && (
            <div className="accounts-section">
              <div className="section-header">
                <h2>Cài đặt ứng dụng</h2>
                <p className="section-desc">Cấu hình các thông số hoạt động của FollowFree Desktop</p>
              </div>

              <div style={{ 
                background: 'rgba(255,255,255,0.02)', 
                padding: '24px', 
                borderRadius: '12px', 
                border: '1px solid var(--border)',
                backdropFilter: 'blur(10px)',
                marginTop: '20px'
              }}>
                <h3 style={{ fontSize: '14px', marginBottom: '16px', fontWeight: 400, color: 'var(--accent)' }}>Cấu hình Hiệu suất & Giao diện</h3>
                
                <label style={{ display: 'flex', alignItems: 'center', gap: '12px', cursor: 'pointer', padding: '12px', background: 'rgba(0,0,0,0.2)', borderRadius: '8px', border: '1px solid var(--border)' }}>
                  <input 
                    type="checkbox" 
                    checked={appSettings.runHeadless} 
                    onChange={toggleHeadless} 
                    style={{ width: '18px', height: '18px', accentColor: 'var(--accent)' }}
                  />
                  <div>
                    <div style={{ fontSize: '14px', color: 'var(--text-primary)', fontWeight: 400 }}>Chạy ngầm (Ẩn Trình duyệt Playwright)</div>
                    <div style={{ fontSize: '12px', color: 'var(--text-secondary)', marginTop: '4px', fontWeight: 300 }}>Khi bật tính năng này, bot sẽ chạy ẩn ở dưới nền giúp tiết kiệm RAM đáng kể. Tắt đi nếu bạn muốn xem trực tiếp màn hình bot đang tương tác.</div>
                  </div>
                </label>
              </div>
            </div>
          )}
        </main>
      </div>

      {/* Password Modal */}
      {showPasswordModal && (
        <div style={{
          position: 'fixed', top: 0, left: 0, right: 0, bottom: 0, 
          background: 'rgba(0,0,0,0.7)', zIndex: 9999,
          display: 'flex', justifyContent: 'center', alignItems: 'center'
        }}>
          <div style={{
            background: 'var(--bg-card)', padding: '24px', borderRadius: '12px',
            width: '400px', border: '1px solid var(--border)'
          }}>
            <h3 style={{ margin: '0 0 20px 0', color: '#fff' }}>🔒 Đổi mật khẩu</h3>
            {passwordError && <div style={{ color: 'var(--danger)', marginBottom: '10px', fontSize: '14px' }}>{passwordError}</div>}
            
            <form onSubmit={handleChangePassword}>
              <div style={{ marginBottom: '15px' }}>
                <label style={{ display: 'block', marginBottom: '8px', color: 'var(--text-secondary)', fontSize: '13px' }}>Mật khẩu cũ</label>
                <input 
                  type="password" 
                  value={passwordForm.oldPassword}
                  onChange={(e) => setPasswordForm({...passwordForm, oldPassword: e.target.value})}
                  required
                  style={{ width: '100%', padding: '10px', background: 'var(--bg-secondary)', border: '1px solid var(--border)', color: '#fff', borderRadius: '6px' }}
                />
              </div>
              <div style={{ marginBottom: '20px' }}>
                <label style={{ display: 'block', marginBottom: '8px', color: 'var(--text-secondary)', fontSize: '13px' }}>Mật khẩu mới</label>
                <input 
                  type="password" 
                  value={passwordForm.newPassword}
                  onChange={(e) => setPasswordForm({...passwordForm, newPassword: e.target.value})}
                  required
                  style={{ width: '100%', padding: '10px', background: 'var(--bg-secondary)', border: '1px solid var(--border)', color: '#fff', borderRadius: '6px' }}
                />
              </div>
              
              <div style={{ display: 'flex', gap: '10px', justifyContent: 'flex-end' }}>
                <button 
                  type="button" 
                  onClick={() => setShowPasswordModal(false)}
                  style={{ padding: '8px 16px', background: 'transparent', color: 'var(--text-secondary)', border: '1px solid var(--border)', borderRadius: '6px', cursor: 'pointer' }}
                >
                  Hủy
                </button>
                <button 
                  type="submit"
                  style={{ padding: '8px 16px', background: 'var(--accent)', color: '#fff', border: 'none', borderRadius: '6px', cursor: 'pointer' }}
                >
                  Xác nhận đổi
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

    </div>
  )
}

function AccountsTab({ accountCount }: { accountCount: number }) {
  const [accounts, setAccounts] = useState<any[]>([])
  const [showAddForm, setShowAddForm] = useState(false)
  const [showGmailCookieForm, setShowGmailCookieForm] = useState(false)
  const [gmailCookieStr, setGmailCookieStr] = useState('')
  const [filterPlatform, setFilterPlatform] = useState('ALL')

  // Form state
  const [platform, setPlatform] = useState('FACEBOOK')

  const loadAccounts = useCallback(() => {
    window.electronAPI?.getAccounts().then((allAccounts: any[]) => {
      // CHỈ HIỂN THỊ TÀI KHOẢN NGƯỜI DÙNG TỰ NHẬP (isManual === true)
      setAccounts(allAccounts.filter(a => a.isManual))
    })
  }, [])

  // Lấy dữ liệu 1 lần lúc vào app
  useEffect(() => {
    loadAccounts()
    
    // Lắng nghe event từ AutoRegPage để bật form
    const handleOpenAdd = () => {
      setPlatform('GMAIL');
      setShowAddForm(true);
    };
    window.addEventListener('open-add-gmail', handleOpenAdd);
    return () => window.removeEventListener('open-add-gmail', handleOpenAdd);
  }, [loadAccounts])

  const handleAutoLogin = async (e: React.FormEvent) => {
    e.preventDefault()

    const res = await (window as any).electronAPI?.autoLoginPlatform(platform)
    if (res?.success) {
      setShowAddForm(false)
      loadAccounts()
    } else {
      alert(res?.error || 'Đăng nhập thất bại!')
    }
  }

  const handleAddGmailByCookie = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!gmailCookieStr) return alert('Vui lòng dán Cookie Gmail!');
    
    const res = await (window as any).electronAPI?.addGmailByCookie(gmailCookieStr);
    if (res?.success) {
      setShowGmailCookieForm(false);
      setGmailCookieStr('');
      loadAccounts();
      alert('Thêm Gmail thành công!');
    } else {
      alert('Lỗi: ' + res?.error);
    }
  }

  const handleLoginGmailOAuth = async () => {
    const res = await (window as any).electronAPI?.loginGmailOAuth();
    if (res?.success) {
      loadAccounts();
      alert('Đã kết nối Gmail qua API thành công!');
    } else {
      if (res?.error) alert('Lỗi kết nối: ' + res.error);
    }
  }

  const handleRemove = async (id: string) => {
    if (!confirm('Xóa tài khoản này?')) return
    await (window as any).electronAPI?.removeAccount(id)
    loadAccounts()
  }

  const platformColors: Record<string, string> = {
    FACEBOOK: '#1877f2', TIKTOK: '#ff0050', GMAIL: '#ea4335', GMAIL_OAUTH: '#ea4335'
  }

  const filteredAccounts = filterPlatform === 'ALL' 
    ? accounts 
    : accounts.filter(a => filterPlatform === 'GMAIL' ? (a.platform === 'GMAIL' || a.platform === 'GMAIL_OAUTH') : a.platform === filterPlatform);

  return (
    <div className="accounts-section">
      <div className="section-header">
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <h2>Tài khoản của tôi ({accounts.length})</h2>
          <div style={{ display: 'flex', gap: '10px' }}>
            <button 
              className="add-btn" 
              style={{ background: '#ea4335', display: 'flex', alignItems: 'center', gap: '5px' }}
              onClick={handleLoginGmailOAuth}
              title="Đăng nhập tự động qua Google (Khuyên dùng)"
            >
              🚀 Thêm Gmail (Auto API)
            </button>
            <button className="add-btn" onClick={() => setShowAddForm(!showAddForm)}>
              {showAddForm ? '✕ Hủy' : '+ Thêm tài khoản MXH'}
            </button>
          </div>
        </div>
        <p className="section-desc">Danh sách tài khoản bạn tự thêm vào hệ thống. Các tài khoản nhận từ server sẽ chạy ngầm và không hiển thị ở đây.</p>
      </div>

      {showAddForm && (
        <form className="add-account-form" onSubmit={handleAutoLogin} style={{ textAlign: 'center', padding: '30px' }}>
          <h3 style={{ marginBottom: '15px' }}>Đăng nhập mạng xã hội</h3>
          <p style={{ color: '#888', marginBottom: '20px', fontSize: '13px' }}>
            Hệ thống sẽ mở một cửa sổ trình duyệt an toàn. Bạn chỉ cần đăng nhập, chúng tôi sẽ tự động lấy thông tin tài khoản của bạn.
          </p>
          <div className="form-group" style={{ marginBottom: '20px', textAlign: 'left' }}>
            <label>Nền tảng</label>
            <select value={platform} onChange={(e) => setPlatform(e.target.value)} style={{ padding: '10px', width: '100%' }}>
              {Object.keys(platformColors).filter(p => p !== 'GMAIL_OAUTH' && p !== 'GMAIL').map(p => <option key={p} value={p}>{p}</option>)}
            </select>
          </div>

          <button type="submit" className="submit-btn" style={{ background: platformColors[platform] || '#4caf50', padding: '12px 24px', fontSize: '16px' }}>
            Mở cửa sổ đăng nhập {platform}
          </button>
        </form>
      )}


      {accounts.length > 0 && !showAddForm && !showGmailCookieForm && (
        <div style={{ display: 'flex', gap: '10px', marginBottom: '20px', borderBottom: '1px solid #333', paddingBottom: '10px' }}>
          {['ALL', 'FACEBOOK', 'TIKTOK', 'GMAIL'].map(p => (
            <button
              key={p}
              onClick={() => setFilterPlatform(p)}
              style={{
                background: filterPlatform === p ? 'rgba(52, 152, 219, 0.2)' : 'transparent',
                color: filterPlatform === p ? '#3498db' : '#aaa',
                border: filterPlatform === p ? '1px solid #3498db' : '1px solid transparent',
                padding: '6px 16px',
                borderRadius: '20px',
                cursor: 'pointer',
                fontWeight: filterPlatform === p ? 'bold' : 'normal',
                transition: 'all 0.2s'
              }}
            >
              {p === 'ALL' ? 'Tất cả' : p === 'GMAIL' ? 'Gmail (Auto Reg)' : p === 'FACEBOOK' ? 'Facebook' : 'Tiktok'}
            </button>
          ))}
        </div>
      )}

      {filteredAccounts.length === 0 && !showAddForm && !showGmailCookieForm ? (
        <div className="empty-state">
          <div className="empty-icon">👤</div>
          <p>Không có tài khoản nào!</p>
          <p className="empty-sub">Hãy bấm thêm tài khoản để sử dụng.</p>
        </div>
      ) : (
        <div className="accounts-grid">
          {filteredAccounts.map((acc) => (
            <div key={acc.id} className="account-card" style={{ position: 'relative', textAlign: 'center', padding: '20px 15px' }}>
              {/* Nút xóa */}
              <button
                onClick={() => handleRemove(acc.id)}
                title="Xóa tài khoản"
                style={{
                  position: 'absolute', top: '8px', right: '8px',
                  background: 'rgba(255,60,60,0.15)', border: '1px solid rgba(255,60,60,0.3)',
                  borderRadius: '6px', color: '#ff6b6b', cursor: 'pointer',
                  width: '26px', height: '26px', display: 'flex', alignItems: 'center', justifyContent: 'center',
                  fontSize: '14px', lineHeight: 1,
                  transition: 'all 0.15s'
                }}
                onMouseEnter={e => (e.currentTarget.style.background = 'rgba(255,60,60,0.35)')}
                onMouseLeave={e => (e.currentTarget.style.background = 'rgba(255,60,60,0.15)')}
              >✕</button>
              {/* Avatar */}
              <div style={{ marginBottom: '10px' }}>
                {acc.avatarUrl ? (
                  <img
                    src={acc.avatarUrl}
                    alt={acc.username}
                    style={{
                      width: '56px', height: '56px', borderRadius: '50%',
                      border: `2px solid ${platformColors[acc.platform] || '#555'}`,
                      objectFit: 'cover'
                    }}
                  />
                ) : (
                  <div style={{
                    width: '56px', height: '56px', borderRadius: '50%',
                    background: platformColors[acc.platform] || '#555',
                    display: 'flex', alignItems: 'center', justifyContent: 'center',
                    fontSize: '22px', margin: '0 auto'
                  }}>
                    {acc.username?.[0]?.toUpperCase() || '?'}
                  </div>
                )}
              </div>

              {/* Platform badge */}
              <div className="platform-badge" style={{
                background: platformColors[acc.platform] || '#555',
                display: 'inline-block', marginBottom: '8px'
              }}>
                {acc.platform}
              </div>

              {/* Name */}
              <div className="account-name" style={{ fontSize: '14px', fontWeight: 600, userSelect: 'text', cursor: 'text', wordBreak: 'break-all' }}>
                {acc.username}
              </div>

              {/* Status */}
              <div className={`account-status ${acc.status?.toLowerCase()}`} style={{ marginTop: '6px' }}>
                {acc.status === 'ACTIVE' ? '🟢 Hoạt động'
                  : acc.status === 'CHECKPOINT' ? '🟡 Checkpoint'
                    : acc.status === 'BANNED' ? '🔴 Bị khóa'
                      : '⚪ Nghỉ ngơi'}
              </div>

              {/* Mở Browser Button */}
              <button
                onClick={() => {
                  if ((window as any).electronAPI?.openBrowser) {
                    (window as any).electronAPI.openBrowser(acc.id, acc.platform, acc.cookieData)
                  }
                }}
                style={{
                  marginTop: '15px',
                  background: 'rgba(52, 152, 219, 0.2)', border: `1px solid rgba(52, 152, 219, 0.5)`, borderRadius: '4px', color: '#3498db',
                  padding: '6px 12px', cursor: 'pointer', fontSize: '12px', width: '100%', fontWeight: 600, transition: 'all 0.2s'
                }}
                onMouseEnter={e => { e.currentTarget.style.background = '#3498db'; e.currentTarget.style.color = '#fff' }}
                onMouseLeave={e => { e.currentTarget.style.background = 'rgba(52, 152, 219, 0.2)'; e.currentTarget.style.color = '#3498db' }}
              >
                Mở Trình Duyệt
              </button>

              {/* Mở Xưởng Đẻ Page */}
              {acc.platform === 'FACEBOOK' && (
              <button
                onClick={async () => {
                  if (!confirm('Khởi động Xưởng Đẻ Page (Bọc Thép) với tài khoản này? Tool sẽ tự động chạy ngầm và tải Avatar AI.')) return;
                  if ((window as any).electronAPI?.pageFarmStart) {
                    const res = await (window as any).electronAPI.pageFarmStart(acc.id, acc.cookieData, acc.userAgent)
                    if (res.success) {
                      alert('Thành công! Đã đẻ ra Page: ' + res.pageName)
                    } else {
                      alert('Lỗi đẻ Page: ' + res.msg)
                    }
                  }
                }}
                style={{
                  marginTop: '8px',
                  background: 'rgba(46, 204, 113, 0.2)', border: `1px solid rgba(46, 204, 113, 0.5)`, borderRadius: '4px', color: '#2ecc71',
                  padding: '6px 12px', cursor: 'pointer', fontSize: '12px', width: '100%', fontWeight: 600, transition: 'all 0.2s'
                }}
                onMouseEnter={e => { e.currentTarget.style.background = '#2ecc71'; e.currentTarget.style.color = '#fff' }}
                onMouseLeave={e => { e.currentTarget.style.background = 'rgba(46, 204, 113, 0.2)'; e.currentTarget.style.color = '#2ecc71' }}
              >
                🔥 Đẻ Page Pro5
              </button>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

function CampaignsTab({ userPoints }: { userPoints: number }) {
  const [campaigns, setCampaigns] = useState<any[]>([])
  const [showForm, setShowForm] = useState(false)
  const [platform, setPlatform] = useState('FACEBOOK')
  const [actionType, setActionType] = useState('LIKE')
  const [targetUrl, setTargetUrl] = useState('')
  const [targetCount, setTargetCount] = useState<number>(10)
  const [error, setError] = useState('')
  const [startCount, setStartCount] = useState<number | null>(null)
  const [groupLinksInput, setGroupLinksInput] = useState<string>('')
  const [isRefreshing, setIsRefreshing] = useState(false)
  const [isPreviewing, setIsPreviewing] = useState(false)
  const [hasChecked, setHasChecked] = useState(false)
  const [isCreating, setIsCreating] = useState(false)

  const loadCampaigns = useCallback(() => {
    window.electronAPI?.getCampaigns().then((res: any) => {
      if (res.success) setCampaigns(res.data)
    })
  }, [])

  const countValidGroups = (text: string) => {
    const invalidPaths = ['/feed/', '/discover/', '/joins/', '/search/', '/create/'];
    return text.split('\n').map(l => l.trim()).filter(l => {
      const low = l.toLowerCase();
      return l.length > 0 && !invalidPaths.some(p => low.includes(p));
    }).length;
  };

  useEffect(() => { loadCampaigns() }, [loadCampaigns])

  const costTable: Record<string, number> = {
    LIKE: 2, LOVE: 2, HAHA: 2, WOW: 2, SAD: 2, ANGRY: 2, FOLLOW: 4, VIEW_LIVE: 2, VIEW_VIDEO: 2, SHARE: 6, COMMENT: 4,
  }
  const totalCost = (costTable[actionType] || 2) * targetCount

  const handleCheckUrl = async (urlToCheck?: string) => {
    const url = urlToCheck || targetUrl
    if (!url || platform !== 'FACEBOOK') return

    setIsPreviewing(true)
    setHasChecked(false)
    setStartCount(null)
    try {
      const count = await window.electronAPI?.previewTarget(url, actionType)
      if (typeof count === 'number') {
        setStartCount(count)
      }
    } catch (e) {
      console.error(e)
    } finally {
      setIsPreviewing(false)
      setHasChecked(true)
    }
  }

  // Tự động quét khi dán link hợp lệ (Debounce 800ms)
  useEffect(() => {
    if (!targetUrl || !targetUrl.startsWith('http')) {
      setHasChecked(false)
      setStartCount(null)
      return
    }

    if (actionType === 'SHARE_GROUP') {
      setHasChecked(true)
      setStartCount(null)
      return
    }

    const timer = setTimeout(() => {
      handleCheckUrl(targetUrl)
    }, 800)

    return () => clearTimeout(timer)
  }, [targetUrl, actionType])

  const handleCreate = async (e: React.FormEvent) => {
    e.preventDefault()
    setError('')
    if (totalCost > userPoints) {
      setError('Bạn không đủ Xu để tạo chiến dịch này!')
      return
    }

    // Validate Facebook URLs
    if (platform === 'FACEBOOK') {
      const urlLower = targetUrl.toLowerCase()
      const isProfileLink = urlLower.includes('profile.php') && !urlLower.includes('story_fbid')

      const isInteraction = ['LIKE', 'LOVE', 'HAHA', 'WOW', 'SAD', 'ANGRY'].includes(actionType)
      if (isInteraction && isProfileLink) {
        setError('❌ Bắt quả tang! Bạn đang mua TĂNG TƯƠNG TÁC nhưng lại nhập link của TRANG CÁ NHÂN. Xin vui lòng chọn "Follow" hoặc đổi sang link của Bài Viết!')
        return
      }

      if (actionType === 'FOLLOW' && (urlLower.includes('/posts/') || urlLower.includes('/videos/') || urlLower.includes('story.php'))) {
        setError('❌ Bắt quả tang! Bạn đang mua TĂNG FOLLOW nhưng lại nhập link của BÀI VIẾT. Xin vui lòng chọn "Like" hoặc đổi sang link của Trang Cá Nhân!')
        return
      }
    }

    setIsCreating(true)

    let metadata = undefined;
    if (actionType === 'SHARE_GROUP') {
      const invalidPaths = ['/feed/', '/discover/', '/joins/', '/search/', '/create/'];
      const groups = groupLinksInput.split('\n').map(l => l.trim()).filter(l => {
        const low = l.toLowerCase();
        return l.length > 0 && !invalidPaths.some(p => low.includes(p));
      });
      if (groups.length === 0) {
        setError('❌ Bạn chưa nhập bất kỳ Link Nhóm hợp lệ nào!');
        setIsCreating(false);
        return;
      }
      metadata = { groups };
    }

    const res = await window.electronAPI?.createCampaign({
      platform, actionType, targetUrl, targetCount: Number(targetCount), startCount: startCount || undefined, metadata
    })

    if (!res.success) {
      setError(res.error)
    } else {
      setShowForm(false)
      loadCampaigns()
      setStartCount(null)
      setHasChecked(false)
    }
    setIsCreating(false)
  }

  return (
    <div className="accounts-section">
      <div className="section-header">
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <h2>Chiến dịch của bạn</h2>
          <button className="add-btn" onClick={() => setShowForm(!showForm)} style={{ background: '#ffd700', color: '#000', border: 'none', fontWeight: 'bold' }}>
            {showForm ? '✕ Hủy' : '🚀 Mua Tương Tác'}
          </button>
        </div>
        <p className="section-desc">Dùng Xu tích lũy để mua Like, Follow thật từ cộng đồng cày view.</p>
      </div>

      {showForm && (
        <form className="add-account-form" onSubmit={handleCreate} style={{ border: '1px solid #ffd700', background: 'rgba(255, 215, 0, 0.05)' }}>
          {error && <div style={{ color: '#ff4444', marginBottom: '15px', padding: '10px', background: 'rgba(255,0,0,0.1)', borderRadius: '6px' }}>{error}</div>}
          <div className="form-group">
            <label>Nền tảng</label>
            <select value={platform} onChange={(e) => setPlatform(e.target.value)}>
              <option value="FACEBOOK">Facebook</option>
              <option value="TIKTOK">TikTok</option>
              <option value="YOUTUBE">YouTube</option>
            </select>
          </div>
          <div className="form-group">
            <label>Hành động</label>
            <select value={actionType} onChange={(e) => setActionType(e.target.value)}>
              <option value="LIKE">Like (2 Xu/lượt)</option>
              {platform === 'FACEBOOK' && (
                <>
                  <option value="LOVE">Thả Tim (2 Xu)</option>
                  <option value="HAHA">Thả Haha (2 Xu)</option>
                  <option value="WOW">Thả Wow (2 Xu)</option>
                  <option value="SAD">Thả Buồn (2 Xu)</option>
                  <option value="ANGRY">Thả Phẫn nộ (2 Xu)</option>
                </>
              )}
              <option value="FOLLOW">Follow (4 Xu/lượt)</option>
              <option value="SHARE">Share (6 Xu/lượt)</option>
              <option value="SHARE_GROUP">Share vào Nhóm (8 Xu/lượt)</option>
              <option value="COMMENT">Comment (4 Xu/lượt)</option>
            </select>
          </div>
          <div className="form-group">
            <label>Đường dẫn bài viết (Link gốc)</label>
            <input 
              type="url" 
              value={targetUrl} 
              onChange={e => setTargetUrl(e.target.value)} 
              onBlur={() => handleCheckUrl()} 
              placeholder="https://facebook.com/..." 
              required 
            />
            {isPreviewing && (
              <div style={{ fontSize: '13px', color: '#ffd700', marginTop: '6px', display: 'flex', alignItems: 'center', gap: '6px' }}>
                ⏳ <span>Đang mở trình duyệt quét số lượng Like/Follow hiện tại... Vui lòng đợi vài giây!</span>
              </div>
            )}

            {startCount !== null && (
              <div style={{ fontSize: '13px', color: '#2ecc71', marginTop: '6px', fontWeight: 'bold' }}>
                ✅ Đã phát hiện số lượng hiện tại: {startCount.toLocaleString()} {actionType === 'FOLLOW' ? 'người theo dõi' : 'lượt thích'}
              </div>
            )}

            {hasChecked && !isPreviewing && startCount === null && actionType !== 'SHARE_GROUP' && (
              <div style={{ fontSize: '13px', color: '#ff4444', marginTop: '8px', padding: '8px', background: 'rgba(255,0,0,0.1)', borderRadius: '4px', border: '1px solid rgba(255,0,0,0.3)' }}>
                ❌ <strong>Không thể quét được số lượng!</strong>
                <div style={{ marginTop: '4px', fontSize: '12px' }}>
                  Hệ thống bắt buộc phải xác định được số lượng ban đầu để làm mốc dừng chiến dịch. Vui lòng:
                  <ul style={{ margin: '4px 0 0 15px', padding: 0, lineHeight: '1.5' }}>
                    <li>Kiểm tra lại đường link có chính xác không.</li>
                    {actionType === 'FOLLOW' ? (
                      <li>Bật <strong>Chế độ chuyên nghiệp (Professional Mode)</strong> hoặc cài đặt hiển thị công khai số lượng người theo dõi trên trang cá nhân của bạn.</li>
                    ) : (
                      <li>Bật hiển thị CÔNG KHAI số lượng Like/Cảm xúc cho bài viết này.</li>
                    )}
                  </ul>
                </div>
              </div>
            )}

            {startCount !== null && !isPreviewing && (
              <div style={{ fontSize: '13px', color: '#ffd700', marginTop: '5px', fontWeight: 'bold' }}>
                ✓ Hiện tại đang có: {startCount.toLocaleString()} {actionType === 'FOLLOW' ? 'lượt theo dõi' : 'lượt tương tác'}
              </div>
            )}
          </div>
          
          {actionType === 'SHARE_GROUP' && (
            <div className="form-group">
              <label>Danh sách Link Nhóm (Mỗi link 1 dòng)</label>
              <textarea 
                value={groupLinksInput}
                onChange={e => {
                  const val = e.target.value;
                  setGroupLinksInput(val);
                  // Tự động đếm số lượng nhóm
                  const invalidPaths = ['/feed/', '/discover/', '/joins/', '/search/', '/create/'];
                  const count = val.split('\n').map(l => l.trim()).filter(l => {
                    const low = l.toLowerCase();
                    return l.length > 0 && !invalidPaths.some(p => low.includes(p));
                  }).length;
                  
                  if (count > 0) {
                    setTargetCount(count);
                  } else {
                    setTargetCount(1); // Mặc định để tránh lỗi bằng 0
                  }
                }}
                placeholder="https://facebook.com/groups/..."
                rows={5}
                style={{ width: '100%', padding: '10px', background: 'rgba(0,0,0,0.5)', color: '#fff', border: '1px solid #555', borderRadius: '4px', resize: 'vertical' }}
                required
              ></textarea>
              <div style={{ fontSize: '12px', color: countValidGroups(groupLinksInput) > 0 ? '#2ecc71' : '#aaa', marginTop: '6px', fontWeight: 'bold' }}>
                {countValidGroups(groupLinksInput) > 0 
                  ? `✅ Đã nhận diện được ${countValidGroups(groupLinksInput)} Nhóm.` 
                  : '*Bạn có thể dùng Tiện ích "Quét Nhóm Facebook" để lấy danh sách này.'}
              </div>
            </div>
          )}
          
          <div className="form-group">
            <label>Số lượng cần mua thêm</label>
            <input type="number" min="1" max="100000" value={targetCount} onChange={e => setTargetCount(Number(e.target.value))} required disabled={actionType === 'SHARE_GROUP'} />
            {actionType === 'SHARE_GROUP' && <div style={{ fontSize: '12px', color: '#ffd700', marginTop: '4px' }}>*Số lượng tự động tính toán dựa trên danh sách Nhóm.</div>}
            {startCount !== null && targetCount > 0 && actionType !== 'SHARE_GROUP' && (
              <div style={{ fontSize: '13px', color: '#00ff88', marginTop: '5px' }}>
                🎯 Mục tiêu hệ thống sẽ dừng lại: {(startCount + targetCount).toLocaleString()}
              </div>
            )}
          </div>

          <div style={{ marginTop: '20px', padding: '15px', background: 'rgba(255,215,0,0.15)', borderRadius: '8px' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '1.2em', marginBottom: '10px' }}>
              <span>Tổng thanh toán:</span>
              <span style={{ color: '#ffd700', fontWeight: 'bold' }}>{totalCost.toLocaleString()} Xu</span>
            </div>

            <button
              type="submit"
              className="submit-btn"
              disabled={(startCount === null && actionType !== 'SHARE_GROUP') || isPreviewing || isCreating || (actionType === 'SHARE_GROUP' && targetCount === 0)}
              style={{
                width: '100%', padding: '12px',
                background: ((startCount === null && actionType !== 'SHARE_GROUP') || isPreviewing || isCreating || (actionType === 'SHARE_GROUP' && targetCount === 0)) ? '#555' : '#ffd700',
                color: ((startCount === null && actionType !== 'SHARE_GROUP') || isPreviewing || isCreating || (actionType === 'SHARE_GROUP' && targetCount === 0)) ? '#999' : '#000',
                border: 'none', borderRadius: '6px', fontWeight: 'bold',
                cursor: ((startCount === null && actionType !== 'SHARE_GROUP') || isPreviewing || isCreating || (actionType === 'SHARE_GROUP' && targetCount === 0)) ? 'not-allowed' : 'pointer'
              }}
            >
              {isCreating ? '⏳ Đang tạo chiến dịch...' : '🚀 Bắt Đầu Chiến Dịch'}
            </button>
          </div>
        </form>
      )}

      {campaigns.length === 0 && !showForm ? (
        <div className="empty-state">
          <div className="empty-icon">💸</div>
          <p>Bạn chưa mua tương tác nào!</p>
          <p className="empty-sub">Hãy cày Xu và mua thử một vài lượt Like xem sao.</p>
        </div>
      ) : (
        <div className="accounts-grid" style={{ marginTop: '20px' }}>
          {campaigns.map((camp) => (
            <div key={camp.id} className="account-card" style={{ borderLeft: '4px solid #ffd700', background: '#1c1c1c' }}>
              <div className="platform-badge" style={{ background: camp.platform === 'FACEBOOK' ? '#1877f2' : '#ff0050' }}>{camp.platform}</div>
              <div className="account-name" style={{ fontSize: '16px', marginTop: '10px' }}>
                <strong>{camp.actionType}</strong>
              </div>
              <div style={{ color: '#999', fontSize: '12px', marginTop: '5px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={camp.targetUrl}>
                {camp.targetUrl}
              </div>

              <div style={{ marginTop: '15px', background: '#333', height: '6px', borderRadius: '3px', overflow: 'hidden' }}>
                <div style={{ width: `${Math.min(100, (camp.doneCount / camp.targetCount) * 100)}%`, background: '#ffd700', height: '100%' }}></div>
              </div>

              <div style={{ marginTop: '8px', fontSize: '13px', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <span style={{ display: 'flex', flexDirection: 'column' }}>
                  {typeof camp.startCount === 'number' && (
                    <span style={{ color: '#aaa', fontSize: '11px', marginBottom: '4px' }}>
                      Bắt đầu: {camp.startCount.toLocaleString()} ➡️ Mục tiêu: {(camp.startCount + camp.targetCount).toLocaleString()}
                    </span>
                  )}
                  <span>Đã chạy: <span style={{ color: '#ffd700', fontWeight: 'bold' }}>{camp.doneCount}</span> / {camp.targetCount}</span>
                </span>
                <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
                  {camp.status === 'RUNNING' && (
                    <button
                      onClick={async () => {
                        if (confirm('Bạn có chắc muốn hủy chiến dịch này? Số Xu thừa sẽ được hoàn lại.')) {
                          await window.electronAPI?.cancelCampaign(camp.id)
                          loadCampaigns()
                        }
                      }}
                      style={{
                        background: 'rgba(255, 60, 60, 0.15)', border: '1px solid rgba(255, 60, 60, 0.3)',
                        color: '#ff6b6b', borderRadius: '4px', padding: '4px 8px', fontSize: '11px', cursor: 'pointer'
                      }}>
                      Dừng & Hoàn tiền
                    </button>
                  )}
                  <span className={`account-status ${camp.status?.toLowerCase()}`} style={{ background: 'none', padding: 0 }}>
                    {camp.status === 'RUNNING' ? '🟢 Đang chạy' : camp.status === 'COMPLETED' ? '⭐ Xong' : '⚪ Đã Hủy'}
                  </span>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

export function DepositsTab({ onRefresh }: { onRefresh?: () => void }) {
  const [depositInfo, setDepositInfo] = React.useState<any>(null)
  const [amount, setAmount] = React.useState(50000)
  const [error, setError] = React.useState<string | null>(null)
  const [isRefreshing, setIsRefreshing] = React.useState(false)

  const handleRefresh = async () => {
    setIsRefreshing(true)
    if (depositInfo) {
      await (window as any).electronAPI?.mockDeposit(amount, depositInfo.syntax)
    }
    if (onRefresh) await onRefresh()
    setTimeout(() => setIsRefreshing(false), 800)
  }

  React.useEffect(() => {
    window.electronAPI?.getDepositInfo().then((res: any) => {
      if (res.success) {
        setDepositInfo(res.data)
      } else {
        setError(res.error || 'Lỗi không xác định')
      }
    })
  }, [])

  if (error) return <div style={{ padding: '20px', color: '#ff4444' }}>❌ {error}</div>
  if (!depositInfo) return <div style={{ padding: '20px' }}>Đang tải thông tin nạp tiền...</div>

  const qrUrl = `https://img.vietqr.io/image/${depositInfo.bankId}-${depositInfo.accountNo}-compact2.jpg?amount=${amount}&addInfo=${depositInfo.syntax}&accountName=${depositInfo.accountName.replace(/ /g, '%20')}`

  return (
    <div className="accounts-section">
      <div className="section-header">
        <h2>Nạp Tiền Nhanh (VietQR)</h2>
        <p className="section-desc">Quét mã QR bằng ứng dụng ngân hàng. Hệ thống sẽ tự động cộng Xu sau 3-5 giây kể từ lúc giao dịch thành công.</p>
      </div>

      <div style={{ display: 'flex', gap: '30px', marginTop: '20px' }}>
        {/* Cột trái: QR Code */}
        <div style={{ flex: 1, background: 'rgba(255,255,255,0.02)', padding: '24px', borderRadius: '12px', textAlign: 'center', border: '1px solid var(--border)', backdropFilter: 'blur(10px)' }}>
          <h3 style={{ marginBottom: '15px', color: '#4caf50' }}>Quét mã QR để thanh toán</h3>

          <div style={{ marginBottom: '15px' }}>
            <label style={{ display: 'block', marginBottom: '8px', color: '#888' }}>Số tiền muốn nạp (VNĐ)</label>
            <input
              type="number"
              value={amount}
              onChange={e => setAmount(Number(e.target.value))}
              style={{ width: '80%', padding: '12px', fontSize: '18px', textAlign: 'center', background: 'rgba(0,0,0,0.3)', border: '1px solid var(--border)', color: 'var(--text-primary)', borderRadius: '6px', outline: 'none' }}
              step="10000"
              min="10000"
            />
          </div>

          <div style={{ background: '#fff', padding: '10px', borderRadius: '8px', display: 'inline-block' }}>
            <img src={qrUrl} alt="VietQR" style={{ width: '250px', height: '250px', objectFit: 'contain' }} />
          </div>

          <div style={{ marginTop: '15px', fontSize: '1.2em' }}>
            Nhận được: <span style={{ color: '#ffd700', fontWeight: 'bold' }}>{(amount * depositInfo.rate).toLocaleString()} Xu</span>
          </div>
        </div>

        {/* Cột phải: Thông tin */}
        <div style={{ flex: 1, background: 'rgba(255,255,255,0.02)', padding: '24px', borderRadius: '12px', border: '1px solid var(--border)', backdropFilter: 'blur(10px)' }}>
          <h3 style={{ marginBottom: '15px' }}>Thông tin chuyển khoản</h3>

          <div style={{ display: 'flex', flexDirection: 'column', gap: '15px' }}>
            <div style={{ background: 'rgba(0,0,0,0.2)', padding: '12px', borderRadius: '8px', border: '1px solid var(--border)' }}>
              <div style={{ color: 'var(--text-secondary)', fontSize: '11px', textTransform: 'uppercase', letterSpacing: '0.1em', marginBottom: '4px' }}>Ngân hàng</div>
              <div style={{ fontSize: '16px', fontWeight: '400' }}>{depositInfo.bankId}</div>
            </div>

            <div style={{ background: 'rgba(0,0,0,0.2)', padding: '12px', borderRadius: '8px', border: '1px solid var(--border)' }}>
              <div style={{ color: 'var(--text-secondary)', fontSize: '11px', textTransform: 'uppercase', letterSpacing: '0.1em', marginBottom: '4px' }}>Chủ tài khoản</div>
              <div style={{ fontSize: '16px', fontWeight: '400' }}>{depositInfo.accountName}</div>
            </div>

            <div style={{ background: 'rgba(0,0,0,0.2)', padding: '12px', borderRadius: '8px', border: '1px solid var(--border)' }}>
              <div style={{ color: 'var(--text-secondary)', fontSize: '11px', textTransform: 'uppercase', letterSpacing: '0.1em', marginBottom: '4px' }}>Số tài khoản</div>
              <div style={{ fontSize: '16px', fontWeight: '600', color: '#4caf50' }}>{depositInfo.accountNo}</div>
            </div>

            <div style={{ background: 'rgba(212,175,55,0.05)', padding: '12px', borderRadius: '8px', border: '1px solid var(--accent)' }}>
              <div style={{ color: 'var(--accent)', fontSize: '11px', textTransform: 'uppercase', letterSpacing: '0.1em', marginBottom: '4px' }}>Nội dung chuyển khoản (Bắt buộc)</div>
              <div style={{ fontSize: '18px', fontWeight: '400', color: 'var(--accent)' }}>{depositInfo.syntax}</div>
            </div>
          </div>

          <div style={{ marginTop: '20px', padding: '15px', background: 'rgba(255,165,0,0.1)', borderRadius: '8px', color: '#ffcc00', fontSize: '13px', lineHeight: '1.5' }}>
            ⚠️ <strong>Lưu ý quan trọng:</strong>
            <ul style={{ paddingLeft: '20px', marginTop: '5px' }}>
              <li>Nạp sai nội dung hệ thống sẽ không tự động cộng Xu.</li>
              <li>Nếu quét QR mã sẽ tự điền đầy đủ. Chỉ dùng thông tin trên để chuyển khoản thủ công.</li>
            </ul>
          </div>

          <button
            onClick={handleRefresh}
            disabled={isRefreshing}
            style={{
              marginTop: '20px',
              width: '100%',
              padding: '15px',
              background: '#4caf50',
              color: 'white',
              border: 'none',
              borderRadius: '8px',
              fontSize: '16px',
              fontWeight: 'bold',
              cursor: isRefreshing ? 'not-allowed' : 'pointer',
              opacity: isRefreshing ? 0.7 : 1,
              transition: 'all 0.2s'
            }}
          >
            {isRefreshing ? '⏳ Đang kiểm tra...' : '✅ Tôi đã chuyển khoản'}
          </button>
        </div>
      </div>
    </div>
  )
}

function EmailTab() {
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [isConnected, setIsConnected] = useState(false)
  const [isConnecting, setIsConnecting] = useState(false)
  const [error, setError] = useState('')
  const [codes, setCodes] = useState<any[]>([])

  useEffect(() => {
    // Load config
    window.electronAPI?.getEmailConfig().then((config: any) => {
      if (config) {
        setEmail(config.email || '')
        setPassword(config.password || '')
      }
    })

    const onNewCode = (data: any) => {
      setCodes(prev => [data, ...prev].slice(0, 50))
    }
    const onConnected = () => {
      setIsConnected(true)
      setIsConnecting(false)
      setError('')
    }
    const onDisconnected = () => {
      setIsConnected(false)
    }
    const onError = (msg: string) => {
      setError(msg)
      setIsConnecting(false)
    }

    window.electronAPI?.on('email:new_code', onNewCode)
    window.electronAPI?.on('email:connected', onConnected)
    window.electronAPI?.on('email:disconnected', onDisconnected)
    window.electronAPI?.on('email:error', onError)

    return () => {
      window.electronAPI?.off('email:new_code', onNewCode)
      window.electronAPI?.off('email:connected', onConnected)
      window.electronAPI?.off('email:disconnected', onDisconnected)
      window.electronAPI?.off('email:error', onError)
    }
  }, [])

  const handleConnect = async (e: React.FormEvent) => {
    e.preventDefault()
    setIsConnecting(true)
    setError('')
    const res = await window.electronAPI?.connectEmail(email, password)
    if (!res?.success) {
      setError('Lỗi kết nối IMAP. Hãy kiểm tra lại App Password.')
      setIsConnecting(false)
    }
  }

  const handleDisconnect = async () => {
    await window.electronAPI?.disconnectEmail()
  }

  return (
    <div className="accounts-section">
      <div className="section-header">
        <h2>📧 Hòm thư Master (Nhận mã Checkpoint)</h2>
        <div className="header-actions">
          {isConnected ? (
            <button className="primary-btn" style={{ background: '#f44336' }} onClick={handleDisconnect}>
              Ngắt kết nối
            </button>
          ) : (
            <span style={{ color: '#ff9800', fontSize: '14px' }}>Chưa kết nối IMAP</span>
          )}
        </div>
      </div>

      {!isConnected && (
        <form className="add-account-form" onSubmit={handleConnect} style={{ padding: '20px', border: '1px solid rgba(255, 215, 0, 0.2)' }}>
          <h3>Kết nối Gmail Catch-all</h3>
          <p style={{ color: '#aaa', fontSize: '13px', marginBottom: '15px' }}>
            Nhập địa chỉ Gmail Master và <strong>Mật khẩu ứng dụng (App Password)</strong> để Tool tự động nhận mã Facebook gửi về.
          </p>
          <div className="form-group">
            <label>Gmail Master</label>
            <input
              type="email"
              placeholder="master@gmail.com"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              required
            />
          </div>
          <div className="form-group">
            <label>App Password (16 ký tự)</label>
            <input
              type="password"
              placeholder="xxxx xxxx xxxx xxxx"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
            />
          </div>
          {error && <div className="error-message" style={{ margin: '10px 0' }}>{error}</div>}
          <button type="submit" className="primary-btn" disabled={isConnecting} style={{ width: '100%' }}>
            {isConnecting ? 'Đang kết nối...' : 'Bắt đầu Lắng nghe'}
          </button>
        </form>
      )}

      <div style={{ marginTop: '20px' }}>
        <h3>Danh sách Mã Xác Nhận mới nhất</h3>
        <div className="log-container" style={{ maxHeight: '400px', background: '#0a0a0a', border: '1px solid #333' }}>
          {codes.length === 0 ? (
            <div className="log-item" style={{ textAlign: 'center', color: '#666' }}>Chưa có mã nào được nhận.</div>
          ) : (
            codes.map((c, i) => (
              <div key={i} className="log-item" style={{ display: 'flex', justifyContent: 'space-between', borderBottom: '1px solid #222', padding: '10px' }}>
                <span className="log-time" style={{ width: '80px' }}>{new Date(c.timestamp).toLocaleTimeString('vi-VN')}</span>
                <span style={{ flex: 1, color: '#ffd700', fontFamily: 'monospace' }}>{c.toEmail}</span>
                <span style={{ color: '#4caf50', fontWeight: 'bold', fontSize: '16px' }}>{c.code}</span>
              </div>
            ))
          )}
        </div>
      </div>
    </div>
  )
}
