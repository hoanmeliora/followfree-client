import { app, BrowserWindow, ipcMain, Tray, Menu, nativeImage, shell, dialog } from 'electron'
import path from 'path'
import http from 'http'
import url from 'url'
import { autoUpdater } from 'electron-updater'

function getRandomUserAgent(seed?: string): string {
  const agents = [
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/119.0.0.0 Safari/537.36',
    'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/118.0.0.0 Safari/537.36',
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:109.0) Gecko/20100101 Firefox/119.0',
  ]
  if (seed) {
    let hash = 0;
    for (let i = 0; i < seed.length; i++) {
      hash = seed.charCodeAt(i) + ((hash << 5) - hash);
    }
    const index = Math.abs(hash) % agents.length;
    return agents[index];
  }
  return agents[Math.floor(Math.random() * agents.length)]
}

import { WorkerService } from './services/worker.service'
import { AuthService } from './services/auth.service'
import { StoreService } from './services/store.service'
import { AccountSyncService } from './services/account-sync.service'
import { CampaignService } from './services/campaign.service'
import { DepositService } from './services/deposit.service'
import { EmailService } from './services/email.service'
import { AutoRegService } from './services/auto-reg.service'
import { PageFarmService } from './services/page-farm.service'
import axios from 'axios'

const isDev = process.env.NODE_ENV === 'development'
let mainWindow: BrowserWindow | null = null

// Global 401 interceptor
axios.interceptors.response.use(
  (response) => response,
  (error) => {
    if (error.response && error.response.status === 401) {
      const url = error.config?.url || '';
      if (!url.includes('/auth/login') && !url.includes('/auth/register')) {
        if (mainWindow) {
          mainWindow.webContents.send('auth:expired')
        }
      }
    }
    return Promise.reject(error)
  }
)
let tray: Tray | null = null
let workerService: WorkerService | null = null
let emailService: EmailService | null = null
let autoRegService: AutoRegService | null = null
let pageFarmService: PageFarmService | null = null
let isQuitting = false

// ================================================================
// LIVE CONSOLE: Pipe all console.log/warn/error to the UI
// ================================================================
const _origLog = console.log.bind(console)
const _origWarn = console.warn.bind(console)
const _origError = console.error.bind(console)

const logBuffer: { time: string, message: string, level: string }[] = []
function sendLogToUI(level: 'info' | 'warning' | 'error', ...args: any[]) {
  try {
    const message = args.map(a =>
      typeof a === 'object' ? JSON.stringify(a, null, 2) : String(a)
    ).join(' ')
    const time = new Date().toLocaleTimeString('vi-VN')
    logBuffer.push({ time, message, level })
    if (logBuffer.length > 500) logBuffer.shift()

    if (!mainWindow || mainWindow.isDestroyed()) return
    mainWindow.webContents.send('worker:log', { message, level, time })
  } catch (_) {}
}

ipcMain.handle('app:getRecentLogs', () => {
  return logBuffer
})

console.log = (...args: any[]) => {
  _origLog(...args)
  sendLogToUI('info', ...args)
}
console.warn = (...args: any[]) => {
  _origWarn(...args)
  sendLogToUI('warning', ...args)
}
console.error = (...args: any[]) => {
  _origError(...args)
  sendLogToUI('error', ...args)
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 900,
    height: 640,
    minWidth: 800,
    minHeight: 580,
    frame: false,          // Custom titlebar
    transparent: false,
    backgroundColor: '#0f0f0f',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
    icon: path.join(__dirname, '../assets/icon.png'),
    show: false,           // Hiển thị sau khi đã sẵn sàng
  })

  if (isDev) {
    mainWindow.loadURL('http://localhost:5173')
    // mainWindow.webContents.openDevTools()
  } else {
    mainWindow.loadFile(path.join(__dirname, '../dist/index.html'))
  }

  mainWindow.once('ready-to-show', () => {
    // Ép kiểu (any) để tránh lỗi TS trên một số phiên bản Electron cũ/mới
    const settings = app.getLoginItemSettings() as any
    const isHidden = process.argv.includes('--hidden') || settings.wasOpenedAsHidden === true
    if (!isHidden) {
      mainWindow?.show()
    }
  })

  // Thoát hẳn phần mềm khi bấm X
  mainWindow.on('close', () => {
    isQuitting = true
  })
}

function createTray() {
  const icon = nativeImage.createEmpty()
  tray = new Tray(icon)

  const contextMenu = Menu.buildFromTemplate([
    { label: 'Mở FollowFree', click: () => mainWindow?.show() },
    { type: 'separator' },
    {
      label: 'Trạng thái: Đang chạy',
      enabled: false,
    },
    { type: 'separator' },
    {
      label: 'Thoát',
      click: () => {
        isQuitting = true
        workerService?.stop()
        app.quit()
      },
    },
  ])

  tray.setToolTip('FollowFree - Đang chạy ngầm')
  tray.setContextMenu(contextMenu)
  tray.on('double-click', () => mainWindow?.show())
}

// ================================================================
// IPC HANDLERS - Kênh giao tiếp giữa Renderer (React) và Main
// ================================================================

function setupIpcHandlers(
  authService: AuthService,
  storeService: StoreService,
  campaignService: CampaignService,
  depositService: DepositService,
  emailService: EmailService,
  accountSyncService: AccountSyncService,
) {
  // Auth
  ipcMain.handle('auth:login', async (_e, { username, password }) => {
    const result = await authService.login(username, password)
    // Đăng nhập ở máy mới: kéo nick đã lưu trên server về trước khi UI load danh sách
    if (result.success) await accountSyncService.pull()
    return result
  })

  ipcMain.handle('auth:register', async (_e, { username, email, password }) => {
    return authService.register(username, email, password)
  })

  ipcMain.handle('auth:getMe', async () => {
    return authService.getMe()
  })

  ipcMain.handle('auth:changePassword', async (_e, { oldPassword, newPassword }) => {
    return authService.changePassword(oldPassword, newPassword)
  })

  ipcMain.handle('auth:logout', async () => {
    storeService.clearSession()
    workerService?.stop()
    return { success: true }
  })

  ipcMain.handle('auth:getSession', async () => {
    return storeService.getSession()
  })

  // Worker controls
  ipcMain.handle('worker:start', async () => {
    const session = storeService.getSession()
    if (!session?.token) return { error: 'Chưa đăng nhập' }
    await workerService?.start()
    return { success: true }
  })

  ipcMain.handle('worker:stop', async () => {
    workerService?.stop()
    return { success: true }
  })

  ipcMain.handle('worker:getStatus', async () => {
    return workerService?.getStatus() ?? { running: false, tasksCompleted: 0, points: 0 }
  })

  ipcMain.handle('worker:getAccounts', async () => {
    return storeService.getAccounts()
  })

  ipcMain.handle('worker:addAccount', async (_e, account) => {
    const newAcc = { 
      ...account, 
      id: 'manual_' + Date.now(), 
      isManual: true, 
      status: 'ACTIVE' 
    }
    storeService.addAccounts([newAcc])
    workerService?.reportCapacityUpdate()
    return { success: true }
  })

  ipcMain.handle('worker:removeAccount', async (_e, id: string) => {
    const accounts = storeService.getAccounts()
    const filtered = accounts.filter(a => a.id !== id)
    storeService.saveAccounts(filtered)
    workerService?.reportCapacityUpdate()
    return { success: true }
  })

  const getPlatformConfig = (platform: string) => {
    const p = platform.toUpperCase()
    if (p === 'GMAIL' || p === 'GMAIL_OAUTH') return { domain: 'https://mail.google.com', loginUrl: 'https://accounts.google.com/signin', cookieDomain: '.google.com' }
    if (p === 'TIKTOK') return { domain: 'https://www.tiktok.com', loginUrl: 'https://www.tiktok.com/login', cookieDomain: '.tiktok.com' }
    if (p === 'YOUTUBE') return { domain: 'https://www.youtube.com', loginUrl: 'https://accounts.google.com/ServiceLogin?service=youtube', cookieDomain: '.youtube.com' }
    if (p === 'INSTAGRAM') return { domain: 'https://www.instagram.com', loginUrl: 'https://www.instagram.com/accounts/login/', cookieDomain: '.instagram.com' }
    if (p === 'THREADS') return { domain: 'https://www.threads.net', loginUrl: 'https://www.threads.net/login', cookieDomain: '.threads.net' }
    if (p === 'X' || p === 'TWITTER') return { domain: 'https://x.com', loginUrl: 'https://x.com/i/flow/login', cookieDomain: '.x.com' }
    return { domain: 'https://www.facebook.com', loginUrl: 'https://www.facebook.com/login', cookieDomain: '.facebook.com' }
  }

  ipcMain.handle('account:openBrowser', async (_e, { id, platform, cookieStr }) => {
    return new Promise((resolve) => {
      const randomUserAgent = getRandomUserAgent(id)
      const config = getPlatformConfig(platform)
      const domain = config.domain
      
      const loginWin = new BrowserWindow({
        width: 1000,
        height: 800,
        title: `Kiểm tra tài khoản ${platform}`,
        autoHideMenuBar: false,
        webPreferences: {
          partition: `persist:account-${id}`,
          nodeIntegration: false,
          contextIsolation: true
        }
      })
      
      loginWin.webContents.userAgent = randomUserAgent

      let cookiesToSet: any[] = []
      try {
        if (platform === 'GMAIL_OAUTH') {
          const parsed = JSON.parse(cookieStr)
          if (parsed.cookies) {
            cookiesToSet = parsed.cookies
          }
        } else if (cookieStr.startsWith('[')) {
          cookiesToSet = JSON.parse(cookieStr)
        } else {
          cookieStr.split(';').forEach((pair: string) => {
            const [name, ...rest] = pair.trim().split('=')
            if (name && rest.length > 0) {
              cookiesToSet.push({ name, value: rest.join('='), domain: config.cookieDomain, path: '/' })
            }
          })
        }
      } catch (e) {
        console.error("Error parsing cookies:", e)
      }

      // Luôn bơm cookie mới nhất vào session (kể cả khi đã có cookie cũ)
      // để đảm bảo tài khoản không bị logout sau khi cookie hết hạn
      const finalUrl = (platform === 'GMAIL' || platform === 'GMAIL_OAUTH')
        ? 'https://mail.google.com/mail/u/0/#inbox'
        : domain

      // Dùng async IIFE để dùng await bên trong Promise callback (vốn không phải async)
      ;(async () => {
        // Trường hợp đặc biệt: GMAIL_OAUTH chỉ lưu token, không có web cookie
        // → Dùng token để lấy link đăng nhập trực tiếp vào Gmail
        if ((platform === 'GMAIL_OAUTH' || platform === 'GMAIL') && cookiesToSet.length === 0) {
          try {
            const parsed = JSON.parse(cookieStr)
            const token = parsed?.token
            if (token?.access_token) {
              // Dùng Google OAuth implicit flow để đăng nhập vào Gmail qua Electron session
              // Mở trang Gmail bình thường, người dùng tự đăng nhập 1 lần rồi cookie sẽ được lưu tự động
              const refreshToken = token.refresh_token
              if (refreshToken) {
                // Dùng refresh_token để lấy access_token mới rồi redirect vào Gmail
                const tokenUrl = `https://accounts.google.com/o/oauth2/token`
                const clientId = '1075088201776-p22gg2en7gsp5vdqfq24jhvphafq0r4i.apps.googleusercontent.com'
                const clientSecret = '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'
                const body = new URLSearchParams({
                  client_id: clientId,
                  client_secret: clientSecret,
                  refresh_token: refreshToken,
                  grant_type: 'refresh_token'
                })
                const res = await fetch(tokenUrl, { method: 'POST', body: body.toString(), headers: { 'Content-Type': 'application/x-www-form-urlencoded' } }).catch(() => null)
                if (res?.ok) {
                  const newToken = await res.json()
                  if (newToken?.access_token) {
                    // Google cho phép mở thẳng Gmail bằng token qua URL này
                    const gmailWithToken = `https://mail.google.com/mail/u/0/?authuser=0#inbox`
                    // Set Authorization header không được trong BrowserWindow, chỉ có thể inject JS sau khi load
                    loginWin.loadURL(gmailWithToken)
                    // Sau khi load xong, inject token để bypass login
                    loginWin.webContents.once('did-finish-load', async () => {
                      if (!loginWin.isDestroyed()) {
                        await loginWin.webContents.executeJavaScript(`
                          // Thử dùng fetch với Authorization header để kiểm tra token còn sống không
                          fetch('https://www.googleapis.com/gmail/v1/users/me/profile', {
                            headers: { 'Authorization': 'Bearer ${newToken.access_token}' }
                          }).then(r => r.json()).then(d => {
                            if (d.emailAddress) window.location.href = 'https://mail.google.com/mail/u/0/#inbox';
                          }).catch(() => {});
                        `).catch(() => {})
                      }
                    })
                    return
                  }
                }
              }
            }
          } catch (e) {
            console.error('[openBrowser] Error handling GMAIL_OAUTH token:', e)
          }
          // Fallback: mở trang đăng nhập Gmail bình thường
          if (!loginWin.isDestroyed()) loginWin.loadURL('https://accounts.google.com/ServiceLogin?service=mail')
          return
        }

        if (cookiesToSet.length > 0) {
          const promises = cookiesToSet.map(c => {
            let url = domain
            if (c.domain) {
              url = c.domain.startsWith('.') ? `https://www${c.domain}` : `https://${c.domain}`
            }
            
            const cookieDetails: any = {
              url: url,
              name: c.name,
              value: c.value,
              path: c.path || '/',
              secure: c.secure !== undefined ? c.secure : true,
              httpOnly: c.httpOnly || false,
              sameSite: c.sameSite === 'no_restriction' ? 'no_restriction' : 'unspecified'
            }

            // __Host- cookies MUST NOT have a domain attribute, and MUST have path '/'
            if (c.name.startsWith('__Host-')) {
               cookieDetails.path = '/';
            } else if (c.domain) {
               cookieDetails.domain = c.domain;
            }

            return loginWin.webContents.session.cookies.set(cookieDetails)
              .catch(e => console.error("Error setting cookie", c.name, e))
          })

          await Promise.all(promises).catch(console.error)
        }

        if (!loginWin.isDestroyed()) loginWin.loadURL(finalUrl)
      })()

      let isClosing = false;
      loginWin.on('close', async (e) => {
        if (isClosing) return;
        e.preventDefault();
        isClosing = true;
        
        try {
          // 1. Thu thập cookie mới nhất từ session của cửa sổ TRƯỚC KHI bị đóng
          // get({}) lấy TẤT CẢ cookie của mọi domain (quan trọng với Google vì có cả accounts.google.com và mail.google.com)
          const freshCookies = await loginWin.webContents.session.cookies.get({})
          if (freshCookies.length === 0) {
            loginWin.destroy();
            resolve({ success: true })
            return
          }

          let newCookieStr = JSON.stringify(freshCookies);
          if (platform === 'GMAIL_OAUTH') {
            try {
              const parsed = JSON.parse(cookieStr);
              parsed.cookies = freshCookies;
              newCookieStr = JSON.stringify(parsed);
            } catch(e) {}
          }

          // 2. Lưu local ngay lập tức
          storeService.updateAccountCookie(id, newCookieStr)
          storeService.updateAccountStatus(id, 'ACTIVE')
          workerService?.reportCapacityUpdate()

          // 3. Best-effort sync lên Server (để nick không mất cookie khi đổi máy)
          // Chỉ sync nick do Server cấp (không phải nick manual của nông dân)
          const acc = storeService.getAccounts().find(a => a.id === id)
          if (acc && !acc.isManual) {
            authService.syncCookieToServer(id, newCookieStr).then(result => {
              if (result.success) {
                console.log(`[openBrowser] Cookie synced to server for account: ${id}`)
              }
            })
          }
        } catch (err) {
          console.error('[openBrowser] Error capturing cookies on close:', err)
        }
        
        loginWin.destroy();
        resolve({ success: true })
      })
    })
  })

  ipcMain.handle('account:autoLogin', async (_e, platform: string) => {
    return new Promise((resolve) => {
      const randomUserAgent = getRandomUserAgent()
      
      const loginWin = new BrowserWindow({
        width: 450,
        height: 700,
        title: `Đăng nhập ${platform}`,
        autoHideMenuBar: true,
        webPreferences: {
          partition: `login_${Date.now()}`,
          nodeIntegration: false,
          contextIsolation: true
        }
      })
      
      loginWin.webContents.userAgent = randomUserAgent
      
      const config = getPlatformConfig(platform)
      const domain = config.domain
      const loginUrl = config.loginUrl
      
      loginWin.loadURL(loginUrl)
      
      loginWin.webContents.on('dom-ready', () => {
        if (platform.toUpperCase() === 'FACEBOOK') {
          loginWin.webContents.executeJavaScript(`
            document.addEventListener('input', (e) => {
              if (e.target && (e.target.name === 'email' || e.target.id === 'email' || e.target.id === 'm_login_email')) {
                window.localStorage.setItem('followfree_captured_email', e.target.value);
              }
            });
          `).catch(() => {});
        }
      });

      let isResolved = false

      // Polling check for cookies to auto-close
      const checkInterval = setInterval(async () => {
        if (loginWin.isDestroyed()) {
          clearInterval(checkInterval)
          return
        }
        
        try {
          const cookies = await loginWin.webContents.session.cookies.get({})
          const cookieNames = cookies.map(c => c.name)
          
          // Facebook uses c_user, TikTok uses sessionid, Google uses SID/HSID
          const isLoggedIn = (platform.toUpperCase() === 'FACEBOOK' && cookieNames.includes('c_user')) || 
                             (platform.toUpperCase() === 'TIKTOK' && cookieNames.includes('sessionid')) ||
                             (platform.toUpperCase() === 'GMAIL' && (cookieNames.includes('SID') || cookieNames.includes('HSID')))
                             
          if (isLoggedIn && !isResolved) {
            isResolved = true
            clearInterval(checkInterval)
            const cookieStr = cookies.map(c => `${c.name}=${c.value}`).join('; ')
            
            let extractedName = platform.toUpperCase() === 'FACEBOOK' ? 'Tài khoản Facebook' : platform.toUpperCase() === 'GMAIL' ? 'Tài khoản Gmail' : 'Tài khoản TikTok'
            let avatarUrl = ''
            
            try {
              if (platform.toUpperCase() === 'FACEBOOK') {
                const userId = cookies.find(c => c.name === 'c_user')?.value
                
                // Lấy email đã lưu trong localStorage của trang đăng nhập
                const capturedEmail = await loginWin.webContents.executeJavaScript(`window.localStorage.getItem('followfree_captured_email')`).catch(() => null)
                
                if (capturedEmail) {
                  extractedName = capturedEmail
                } else if (userId) {
                  extractedName = `FB_${userId}`
                }
              } else if (platform.toUpperCase() === 'TIKTOK') {
                // Tương tự với TikTok
                const res = await fetch('https://www.tiktok.com/@me', {
                  headers: {
                    'Cookie': cookieStr,
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
                  },
                  redirect: 'follow'
                })
                const html = await res.text()
                
                const titleMatch = html.match(/<title>(.*?)<\/title>/)
                if (titleMatch && titleMatch[1]) {
                  const cleanTitle = titleMatch[1].split('(@')[0].trim()
                  if (cleanTitle && cleanTitle !== 'TikTok') {
                    extractedName = cleanTitle
                  }
                }
              }
            } catch (err) {
              console.log('Không lấy được thông tin tài khoản:', err)
            }
            
              const newAcc = { 
                id: 'auto_' + Date.now(), 
                platform: platform.toUpperCase(), 
                username: extractedName, 
                avatarUrl: avatarUrl,
                cookieData: JSON.stringify(cookies),
                status: 'ACTIVE',
                isManual: true,
                userAgent: randomUserAgent
              }
              
              storeService.addAccounts([newAcc])
              workerService?.reportCapacityUpdate()
              loginWin.close()
              resolve({ success: true, account: newAcc })
            }
          } catch (err) {
            console.error('Error in cookie polling:', err)
          }
        }, 1000)
        
        loginWin.on('closed', () => {
          clearInterval(checkInterval)
          if (!isResolved) {
            resolve({ success: false, error: 'User closed window before login' })
          }
        })
      })
    })

    ipcMain.handle('account:addGmailByCookie', async (_e, cookieStr: string) => {
      try {
        let cookiesToSet: any[] = []
        if (cookieStr.startsWith('[')) {
          cookiesToSet = JSON.parse(cookieStr)
        } else {
          cookieStr.split(';').forEach((pair: string) => {
            const [name, ...rest] = pair.trim().split('=')
            if (name && rest.length > 0) {
              cookiesToSet.push({ 
                name: name.trim(), 
                value: rest.join('=').trim(), 
                domain: '.google.com', 
                path: '/',
                secure: true,
                httpOnly: name.trim() === 'SID' || name.trim() === 'HSID' || name.trim() === 'SSID'
              })
            }
          })
        }
        
        const newAcc = { 
          id: 'gmail_' + Date.now(), 
          platform: 'GMAIL', 
          username: 'Gmail Cookie Import', 
          avatarUrl: '',
          cookieData: JSON.stringify(cookiesToSet),
          status: 'ACTIVE',
          isManual: true,
          userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
        }
        
        storeService.addAccounts([newAcc])
        workerService?.reportCapacityUpdate()
        return { success: true, account: newAcc }
      } catch (err: any) {
        return { success: false, error: err.message }
      }
    })

    ipcMain.handle('account:loginGmailOAuth', async () => {
      // Admin cần thay thế bằng Client ID thực tế từ Google Cloud Console
      const CLIENT_ID = '402293795356-v5jk9tt6sij56188c9qa4asuekodd5vs.apps.googleusercontent.com';
      const CLIENT_SECRET = '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';
      const REDIRECT_URI = 'http://localhost:3333/oauth2callback';
      
      const authUrl = `https://accounts.google.com/o/oauth2/v2/auth?client_id=${CLIENT_ID}&redirect_uri=${REDIRECT_URI}&response_type=code&scope=https://www.googleapis.com/auth/gmail.readonly%20https://www.googleapis.com/auth/userinfo.email&access_type=offline&prompt=consent`;

      return new Promise((resolve) => {
        let server: http.Server;
        let oauthWin: BrowserWindow;
        
        server = http.createServer(async (req, res) => {
          try {
            if (req.url && req.url.startsWith('/oauth2callback')) {
              const parsedUrl = url.parse(req.url, true);
              const code = parsedUrl.query.code as string;
              
              if (code) {
                res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
                res.end('<h1>Đang xử lý đăng nhập...</h1><p>Vui lòng đợi trong giây lát, cửa sổ sẽ tự động đóng.</p>');
                
                // Đóng server
                server.close();
                
                // Gọi API lấy Token
                const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
                  method: 'POST',
                  headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
                  body: new URLSearchParams({
                    code,
                    client_id: CLIENT_ID,
                    client_secret: CLIENT_SECRET,
                    redirect_uri: REDIRECT_URI,
                    grant_type: 'authorization_code'
                  })
                });
                
                const tokenData = await tokenRes.json();
                
                if (tokenData.access_token) {
                  // Lấy email
                  const userInfoRes = await fetch('https://www.googleapis.com/oauth2/v2/userinfo', {
                    headers: { Authorization: `Bearer ${tokenData.access_token}` }
                  });
                  const userInfo = await userInfoRes.json();
                  
                  // Thu thập Web Cookies - KHÔNG CẦN THIẾT NỮA VÌ DÙNG BROWSER NGOÀI VÀ ĐÃ CÓ OAUTH TOKEN
                  let webCookies: any[] = [];

                  const newAcc = { 
                    id: 'gmail_' + Date.now(), 
                    platform: 'GMAIL_OAUTH', 
                    username: userInfo.email || 'OAuth Gmail', 
                    avatarUrl: userInfo.picture || '',
                    cookieData: JSON.stringify({ token: tokenData, cookies: webCookies }), // Lưu CẢ token VÀ cookies
                    status: 'ACTIVE',
                    isManual: true,
                    userAgent: ''
                  }
                  
                  storeService.addAccounts([newAcc]);
                  workerService?.reportCapacityUpdate();
                  
                  resolve({ success: true, account: newAcc });
                } else {
                  resolve({ success: false, error: 'Failed to get token: ' + JSON.stringify(tokenData) });
                }
              } else {
                res.end('Error: No code provided');
                server.close();
                resolve({ success: false, error: 'No code provided' });
              }
            }
          } catch (e: any) {
            resolve({ success: false, error: e.message });
            if (server) server.close();
          }
        });
        
        server.on('error', (e: any) => {
          if (e.code === 'EADDRINUSE') {
            resolve({ success: false, error: 'Một phiên đăng nhập Gmail đang được mở hoặc Cổng 3333 đang bị chiếm dụng. Vui lòng đóng cửa sổ cũ rồi thử lại.' });
          } else {
            resolve({ success: false, error: e.message });
          }
        });

        server.listen(3333, () => {
          // Mở bằng trình duyệt mặc định của hệ điều hành (Chrome/Safari thật) để vượt qua bài kiểm tra bảo mật của Google 100%
          shell.openExternal(authUrl);
        });
        
        // Timeout sau 2 phút nếu user không đăng nhập
        setTimeout(() => {
          if (server && server.listening) {
            server.close();
            resolve({ success: false, error: 'Timeout waiting for OAuth login' });
          }
        }, 120000);
      });
    });

  // Campaigns
  ipcMain.handle('campaign:create', async (_e, data) => {
    return campaignService.createCampaign(data.platform, data.actionType, data.targetUrl, data.targetCount, data.startCount, data.metadata)
  })

  ipcMain.handle('campaign:cancel', async (_e, id: string) => {
    return campaignService.cancelCampaign(id)
  })

  ipcMain.handle('campaign:preview', async (_e, url: string, actionType: string) => {
    return workerService?.previewTarget(url, actionType)
  })

  ipcMain.handle('campaign:list', async () => {
    return campaignService.getCampaigns()
  })

  // Deposits
  ipcMain.handle('deposit:getInfo', async () => {
    return depositService.getDepositInfo()
  })
  ipcMain.handle('deposit:mock', async (_e, { amount, syntax }) => {
    return depositService.mockDeposit(amount, syntax)
  })

  // Email
  ipcMain.handle('email:connect', async (_e, { email, password }) => {
    storeService.saveEmailConfig({ email, password })
    const success = await emailService.connect(email, password)
    return { success }
  })

  ipcMain.handle('email:disconnect', async () => {
    emailService.disconnect()
    return { success: true }
  })

  ipcMain.handle('email:getConfig', async () => {
    return storeService.getEmailConfig()
  })

  // Reg Auto
  ipcMain.handle('autoreg:start', async (_e, config: any) => {
    return autoRegService!.startReg(config)
  })

  ipcMain.handle('autoreg:stop', async () => {
    return autoRegService!.stopReg()
  })

  // Page Farm Auto Create
  ipcMain.handle('pagefarm:start', async (_e, { accountId, cookieStr, userAgent }) => {
    return pageFarmService!.createSinglePage(accountId, cookieStr, userAgent)
  })

  // Settings
  ipcMain.handle('settings:get', async () => {
    return storeService.getSettings()
  })

  ipcMain.handle('settings:update', async (_e, settings) => {
    storeService.updateSettings(settings)
    return { success: true }
  })

  // Dialog
  ipcMain.handle('dialog:openFiles', async () => {
    if (!mainWindow) return { canceled: true, filePaths: [] };
    const result = await dialog.showOpenDialog(mainWindow, {
      properties: ['openFile', 'multiSelections'],
      filters: [
        { name: 'Images', extensions: ['jpg', 'png', 'gif', 'jpeg', 'webp'] }
      ]
    });
    return result;
  })

  // Window controls
  ipcMain.on('window:minimize', () => mainWindow?.minimize())
  ipcMain.on('window:maximize', () => {
    if (mainWindow?.isMaximized()) mainWindow?.unmaximize()
    else mainWindow?.maximize()
  })
  ipcMain.on('window:hide', () => mainWindow?.hide())
  ipcMain.on('window:close', () => mainWindow?.hide())
}

// ================================================================
// APP LIFECYCLE
// ================================================================

app.whenReady().then(async () => {
  const storeService = new StoreService()
  const authService = new AuthService(storeService)
  const accountSyncService = new AccountSyncService(storeService)
  const campaignService = new CampaignService(storeService)
  const depositService = new DepositService(storeService)
  emailService = new EmailService()
  
  autoRegService = new AutoRegService((msg) => {
    mainWindow?.webContents.send('autoreg:log', msg)
  }, storeService)

  pageFarmService = new PageFarmService((msg) => {
    mainWindow?.webContents.send('pagefarm:log', msg)
  }, storeService)
  
  workerService = new WorkerService(storeService, (event, data) => {
    // Push realtime updates to React UI
    mainWindow?.webContents.send(event, data)
  })

  emailService.on('new_code', (codeInfo) => {
    mainWindow?.webContents.send('email:new_code', codeInfo)
  })
  emailService.on('connected', (email) => {
    mainWindow?.webContents.send('email:connected', email)
  })
  emailService.on('disconnected', () => {
    mainWindow?.webContents.send('email:disconnected')
  })
  emailService.on('error', (err) => {
    mainWindow?.webContents.send('email:error', err?.message || 'Lỗi IMAP')
  })

  setupIpcHandlers(authService, storeService, campaignService, depositService, emailService, accountSyncService)
  createWindow()
  createTray()
  
  // ===== Auto Update =====
  const isMac = process.platform === 'darwin'
  const sendUpdateStatus = (message: string, kind: 'info' | 'error' | 'success' = 'info') => {
    console.log('[Updater]', message)
    mainWindow?.webContents.send('app:updateStatus', { message, kind })
  }

  autoUpdater.autoDownload = !isMac // macOS bản chưa ký số không tự cài được
  autoUpdater.autoInstallOnAppQuit = true

  autoUpdater.on('checking-for-update', () => sendUpdateStatus('Đang kiểm tra bản cập nhật...'))
  autoUpdater.on('update-available', (info) => {
    if (isMac) {
      sendUpdateStatus(`Có bản mới v${info.version}. macOS cần tải file .dmg thủ công từ GitHub Releases.`, 'info')
    } else {
      sendUpdateStatus(`Đã tìm thấy bản v${info.version}, đang tải xuống...`)
    }
    mainWindow?.webContents.send('app:updateAvailable', { version: info.version, manual: isMac })
  })
  autoUpdater.on('update-not-available', () => sendUpdateStatus('Bạn đang dùng phiên bản mới nhất!', 'success'))
  autoUpdater.on('error', (err) => sendUpdateStatus('Lỗi cập nhật: ' + (err?.message || err), 'error'))
  autoUpdater.on('download-progress', (progressObj) => {
    mainWindow?.webContents.send('app:updateProgress', progressObj)
  })
  autoUpdater.on('update-downloaded', () => {
    mainWindow?.webContents.send('app:updateDownloaded')
  })

  ipcMain.handle('app:checkUpdate', async () => {
    if (isDev) return { success: false, message: 'Tính năng cập nhật bị vô hiệu hóa trong môi trường Dev' }
    try {
      await autoUpdater.checkForUpdates()
      return { success: true }
    } catch (err: any) {
      return { success: false, message: 'Lỗi kiểm tra cập nhật: ' + err.message }
    }
  })

  ipcMain.handle('app:installUpdate', () => {
    autoUpdater.quitAndInstall(false, true)
  })

  ipcMain.handle('app:openReleasePage', () => {
    void shell.openExternal('https://github.com/hoanmeliora/followfree-client/releases/latest')
  })

  if (!isDev) {
    autoUpdater.checkForUpdates().catch(err => console.log('Update Error:', err))
    // Kiểm tra lại mỗi 30 phút
    setInterval(() => {
      autoUpdater.checkForUpdates().catch(err => console.log('Update Error:', err))
    }, 30 * 60 * 1000)
  }

  ipcMain.handle('app:getVersion', () => app.getVersion())

  // Auto-start worker if already logged in
  const session = storeService.getSession()
  if (session?.token) {
    void accountSyncService.pull()
    // Đã bỏ tính năng auto-start worker theo yêu cầu của user
  }

  // Tự động khởi động cùng hệ điều hành (chạy ngầm)
  app.setLoginItemSettings({
    openAtLogin: true,
    args: ['--hidden'], // Windows
  })
})

app.on('window-all-closed', () => {
  // Không thoát khi đóng cửa sổ (vì còn Tray)
})

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow()
})

// removed app.isQuitting declaration
