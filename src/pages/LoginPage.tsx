import React, { useState } from 'react'
import './LoginPage.css'

interface Props {
  onLogin: (session: any) => void
}

export function LoginPage({ onLogin }: Props) {
  const [tab, setTab] = useState<'login' | 'register'>('login')
  const [username, setUsername] = useState('')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    setLoading(true)
    setError('')

    try {
      let result
      if (tab === 'login') {
        result = await window.electronAPI?.login(username, password)
      } else {
        // register - gọi qua IPC
        result = await window.electronAPI?.register(username, email, password)
      }

      if (result?.success) {
        onLogin({ token: result.token, user: result.user })
      } else {
        setError(result?.error || 'Đăng nhập thất bại')
      }
    } catch {
      setError('Không thể kết nối đến server')
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="login-root">
      {/* Custom Titlebar */}
      <div className="titlebar">
        <div className="titlebar-drag" />
        <div className="titlebar-controls">
          <button onClick={() => window.electronAPI?.minimizeWindow()} className="ctrl-btn minimize">─</button>
          <button onClick={() => window.electronAPI?.maximizeWindow()} className="ctrl-btn maximize">🗖</button>
          <button onClick={() => window.electronAPI?.hideWindow()} className="ctrl-btn close">✕</button>
        </div>
      </div>

      <div className="login-container">
        {/* Logo & Brand */}
        <div className="brand">
          <div className="brand-icon">⚡</div>
          <h1 className="brand-name">FollowFree</h1>
          <p className="brand-tagline">Tăng tương tác thật - Hoàn toàn tự động</p>
        </div>

        {/* Tabs */}
        <div className="auth-tabs">
          <button
            className={`tab-btn ${tab === 'login' ? 'active' : ''}`}
            onClick={() => setTab('login')}
          >
            Đăng nhập
          </button>
          <button
            className={`tab-btn ${tab === 'register' ? 'active' : ''}`}
            onClick={() => setTab('register')}
          >
            Đăng ký
          </button>
        </div>

        {/* Form */}
        <form onSubmit={handleSubmit} className="auth-form">
          <div className="form-group">
            <label>Tên đăng nhập</label>
            <input
              type="text"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              placeholder="Nhập tên đăng nhập..."
              required
              autoFocus
            />
          </div>

          {tab === 'register' && (
            <div className="form-group">
              <label>Email</label>
              <input
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="Nhập email..."
                required
              />
            </div>
          )}

          <div className="form-group">
            <label>Mật khẩu</label>
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="Nhập mật khẩu..."
              required
            />
          </div>

          {error && <div className="error-msg">⚠️ {error}</div>}

          <button type="submit" className="submit-btn" disabled={loading}>
            {loading ? (
              <span className="btn-spinner" />
            ) : tab === 'login' ? (
              'Đăng nhập'
            ) : (
              'Tạo tài khoản'
            )}
          </button>
        </form>

        <p className="version-tag">FollowFree v1.0.0</p>
      </div>
    </div>
  )
}
