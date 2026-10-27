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
      createLocalCampaign?: (data: any) => Promise<any>
      getVersion?: () => Promise<string>
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

      scannerGetConfig: () => Promise<{
        groups: string[]
        keywords: string[]
        intentKeywords?: string[]
        commentKeywords?: string[]
        excludeKeywords?: string[]
        autoFilterSpam?: boolean
        scanComments?: boolean
        maxPostAgeDays?: number
        intervalMinutes: number
        isRunning: boolean
        notifyRecipient?: string
      }>
      scannerSaveConfig: (input: {
        groups: string[]
        keywords: string[]
        intentKeywords?: string[]
        commentKeywords?: string[]
        excludeKeywords?: string[]
        autoFilterSpam?: boolean
        scanComments?: boolean
        maxPostAgeDays?: number
        intervalMinutes: number
        notifyRecipient?: string
      }) => Promise<{ success: boolean; error?: string }>
      scannerStart: () => Promise<{ success: boolean; error?: string }>
      scannerStop: () => Promise<{ success: boolean }>
      scannerGetLeads: () => Promise<Array<{
        id: string; groupName?: string; authorName: string; authorUrl?: string; content: string
        postUrl: string; postTimeText?: string; matchedKeywords: string[]; timestamp: number; status: 'new' | 'read' | 'contacted'
      }>>
      scannerUpdateLeadStatus: (id: string, status: 'new' | 'read' | 'contacted') => Promise<{ success: boolean }>
      scannerClearLeads: () => Promise<{ success: boolean }>
      scannerOpenExternal: (url: string) => Promise<{ success: boolean }>
      onScannerEvent: (channel: 'scanner:new_lead' | 'scanner:status' | 'scanner:log', cb: (data: any) => void) => () => void

      aiGetConfig: () => Promise<any>
      aiSaveConfig: (config: any) => Promise<{ success: boolean; error?: string }>
      aiGenerateLeadComment: (data: { postContent: string; authorName: string }) => Promise<{ success: boolean; comment?: string; error?: string }>

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

const LOCAL_SESSION: Session = {
  token: 'local-offline-token',
  user: {
    id: 'local_user',
    username: 'Admin',
    email: 'local@device',
    role: 'ADMIN',
    points: 999999,
    balance: 999999,
  },
}

function App() {
  const [session, setSession] = useState<Session>(LOCAL_SESSION)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    // Tự động nạp session đã lưu hoặc dùng phiên làm việc local mặc định
    window.electronAPI?.getSession().then((saved) => {
      setSession(saved && saved.user ? saved : LOCAL_SESSION)
      setLoading(false)
    }).catch(() => {
      setSession(LOCAL_SESSION)
      setLoading(false)
    })

    const handleAuthExpired = async () => {
      // Chế độ công cụ cá nhân offline: bỏ qua sự kiện hết hạn token
      console.warn('Bỏ qua sự kiện auth:expired trong chế độ tool cá nhân offline')
    }

    window.electronAPI?.on('auth:expired', handleAuthExpired)
    return () => {
      window.electronAPI?.off('auth:expired', handleAuthExpired)
    }
  }, [])

  const handleLogin = (newSession: Session) => setSession(newSession)

  const handleLogout = async () => {
    await window.electronAPI?.logout()
    setSession(LOCAL_SESSION)
  }

  if (loading) {
    return (
      <div className="loading-screen">
        <div className="spinner" />
        <p>Đang khởi động...</p>
      </div>
    )
  }

  // Luôn mở trực tiếp Dashboard, ẩn hoàn toàn màn hình đăng nhập/đăng ký
  return <DashboardPage session={session} onLogout={handleLogout} onSessionUpdate={handleLogin} />
}

export default App
