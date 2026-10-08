import React, { useState, useEffect } from 'react'
import { LoginPage } from './pages/LoginPage'
import { DashboardPage } from './pages/DashboardPage'
import './App.css'

interface Session {
  token: string
  user: {
    id: string
    username: string
    email: string
    role: string
    points: number
    balance: number
  }
}

declare global {
  interface Window {
    electronAPI: {
      login: (username: string, password: string) => Promise<any>
      register: (username: string, email: string, password: string) => Promise<any>
      logout: () => Promise<any>
      getSession: () => Promise<Session | null>
      getMe: () => Promise<any>
      changePassword: (oldP: string, newP: string) => Promise<any>
      
      startWorker: () => Promise<any>
      stopWorker: () => Promise<any>
      getWorkerStatus: () => Promise<any>
      getAccounts: () => Promise<any[]>
      addAccount: (account: any) => Promise<any>
      removeAccount: (id: string) => Promise<any>
      autoLoginPlatform: (platform: string) => Promise<any>
      loginGmailOAuth: () => Promise<any>
      addGmailByCookie: (cookieStr: string) => Promise<any>
      openBrowser: (id: string, platform: string, cookieStr: string) => Promise<any>
      
      createCampaign: (data: any) => Promise<any>
      getCampaigns: () => Promise<any>
      getSettings: () => Promise<any>
      updateSettings: (settings: any) => Promise<any>
      cancelCampaign: (id: string) => Promise<any>
      previewTarget: (url: string, actionType: string) => Promise<any>
      
      getDepositInfo: () => Promise<any>
      mockDeposit: (amount: number, syntax: string) => Promise<any>
      
      getEmailConfig: () => Promise<any>
      connectEmail: (email: string, password: string) => Promise<any>
      disconnectEmail: () => Promise<any>
      
      autoRegStart: (config: any) => Promise<any>
      autoRegStop: () => Promise<any>
      onAutoRegLog: (cb: (e: any, msg: string) => void) => () => void

      scannerGetConfig: () => Promise<{ groups: string[]; keywords: string[]; intervalMinutes: number; isRunning: boolean; notifyRecipient?: string }>
      scannerSaveConfig: (input: { groups: string[]; keywords: string[]; intervalMinutes: number; notifyRecipient?: string }) => Promise<{ success: boolean; error?: string }>
      scannerStart: () => Promise<{ success: boolean; error?: string }>
      scannerStop: () => Promise<{ success: boolean }>
      scannerGetLeads: () => Promise<Array<{
        id: string; groupName?: string; authorName: string; authorUrl?: string; content: string
        postUrl: string; matchedKeywords: string[]; timestamp: number; status: 'new' | 'read' | 'contacted'
      }>>
      scannerUpdateLeadStatus: (id: string, status: 'new' | 'read' | 'contacted') => Promise<{ success: boolean }>
      scannerClearLeads: () => Promise<{ success: boolean }>
      scannerOpenExternal: (url: string) => Promise<{ success: boolean }>
      onScannerEvent: (channel: 'scanner:new_lead' | 'scanner:status' | 'scanner:log', cb: (data: any) => void) => () => void

      minimizeWindow: () => void
      maximizeWindow: () => void
      hideWindow: () => void
      closeWindow: () => void
      getRecentLogs: () => Promise<any[]>
      on: (channel: string, cb: (...args: any[]) => void) => void
      off: (channel: string, cb: (...args: any[]) => void) => void
    }
  }
}

function App() {
  const [session, setSession] = useState<Session | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    // Kiểm tra session đã lưu sẵn
    window.electronAPI?.getSession().then((saved) => {
      setSession(saved)
      setLoading(false)
    })

    const handleAuthExpired = async () => {
      alert('Phiên đăng nhập đã hết hạn (hoặc máy chủ yêu cầu đăng nhập lại). Vui lòng đăng nhập lại!')
      await window.electronAPI?.logout()
      setSession(null)
    }

    window.electronAPI?.on('auth:expired', handleAuthExpired)
    return () => {
      window.electronAPI?.off('auth:expired', handleAuthExpired)
    }
  }, [])

  const handleLogin = (newSession: Session) => setSession(newSession)

  const handleLogout = async () => {
    await window.electronAPI?.logout()
    setSession(null)
  }

  if (loading) {
    return (
      <div className="loading-screen">
        <div className="spinner" />
        <p>Đang khởi động...</p>
      </div>
    )
  }

  if (!session) {
    return <LoginPage onLogin={handleLogin} />
  }

  return <DashboardPage session={session} onLogout={handleLogout} onSessionUpdate={handleLogin} />
}

export default App
