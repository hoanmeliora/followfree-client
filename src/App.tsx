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

      minimizeWindow: () => void
      hideWindow: () => void
      closeWindow: () => void
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
