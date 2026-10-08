import { contextBridge, ipcRenderer } from 'electron'

// Expose safe APIs to React renderer
contextBridge.exposeInMainWorld('electronAPI', {
  // Auth
  login: (username: string, password: string) =>
    ipcRenderer.invoke('auth:login', { username, password }),
  register: (username: string, email: string, password: string) =>
    ipcRenderer.invoke('auth:register', { username, email, password }),
  logout: () => ipcRenderer.invoke('auth:logout'),
  getSession: () => ipcRenderer.invoke('auth:getSession'),
  getMe: () => ipcRenderer.invoke('auth:getMe'),
  changePassword: (oldPassword: string, newPassword: string) => 
    ipcRenderer.invoke('auth:changePassword', { oldPassword, newPassword }),

  // Worker
  startWorker: () => ipcRenderer.invoke('worker:start'),
  stopWorker: () => ipcRenderer.invoke('worker:stop'),
  getWorkerStatus: () => ipcRenderer.invoke('worker:getStatus'),
  getAccounts: () => ipcRenderer.invoke('worker:getAccounts'),
  addAccount: (account: any) => ipcRenderer.invoke('worker:addAccount', account),
  removeAccount: (id: string) => ipcRenderer.invoke('worker:removeAccount', id),
  autoLoginPlatform: (platform: string) => ipcRenderer.invoke('account:autoLogin', platform),
  loginGmailOAuth: () => ipcRenderer.invoke('account:loginGmailOAuth'),
  addGmailByCookie: (cookieStr: string) => ipcRenderer.invoke('account:addGmailByCookie', cookieStr),
  openBrowser: (id: string, platform: string, cookieStr: string) => ipcRenderer.invoke('account:openBrowser', { id, platform, cookieStr }),
  selectFiles: () => ipcRenderer.invoke('dialog:openFiles'),

  // Campaigns
  createCampaign: (data: any) => ipcRenderer.invoke('campaign:create', data),
  createLocalCampaign: (data: any) => ipcRenderer.invoke('campaign:local', data),
  getCampaigns: () => ipcRenderer.invoke('campaign:list'),
  cancelCampaign: (id: string) => ipcRenderer.invoke('campaign:cancel', id),
  previewTarget: (url: string, actionType: string) => ipcRenderer.invoke('campaign:preview', url, actionType),

  // Deposits
  getDepositInfo: () => ipcRenderer.invoke('deposit:getInfo'),
  mockDeposit: (amount: number, syntax: string) => ipcRenderer.invoke('deposit:mock', { amount, syntax }),

  // Email
  getEmailConfig: () => ipcRenderer.invoke('email:getConfig'),
  connectEmail: (email: string, password: string) => ipcRenderer.invoke('email:connect', { email, password }),
  disconnectEmail: () => ipcRenderer.invoke('email:disconnect'),

  // Reg Auto
  autoRegStart: (config: any) => ipcRenderer.invoke('autoreg:start', config),
  autoRegStop: () => ipcRenderer.invoke('autoreg:stop'),
  onAutoRegLog: (callback: (e: any, msg: string) => void) => {
    ipcRenderer.on('autoreg:log', callback);
    return () => {
      ipcRenderer.removeListener('autoreg:log', callback);
    };
  },

  // Page Farm
  pageFarmStart: (accountId: string, cookieStr: string, userAgent: string) => ipcRenderer.invoke('pagefarm:start', { accountId, cookieStr, userAgent }),

  // Scanner (Săn khách)
  scannerGetConfig: () => ipcRenderer.invoke('scanner:getConfig'),
  scannerSaveConfig: (input: { groups: string[]; keywords: string[]; intervalMinutes: number; notifyRecipient?: string }) => ipcRenderer.invoke('scanner:saveConfig', input),
  scannerStart: () => ipcRenderer.invoke('scanner:start'),
  scannerStop: () => ipcRenderer.invoke('scanner:stop'),
  scannerGetLeads: () => ipcRenderer.invoke('scanner:getLeads'),
  scannerUpdateLeadStatus: (id: string, status: string) => ipcRenderer.invoke('scanner:updateLeadStatus', id, status),
  scannerClearLeads: () => ipcRenderer.invoke('scanner:clearLeads'),
  scannerOpenExternal: (url: string) => ipcRenderer.invoke('scanner:openExternal', url),

  // AutoPost
  getAutoPostConfig: () => ipcRenderer.invoke('getAutoPostConfig'),
  setAutoPostConfig: (config: any) => ipcRenderer.invoke('setAutoPostConfig', config),

  // Window controls
  minimizeWindow: () => ipcRenderer.send('window:minimize'),
  maximizeWindow: () => ipcRenderer.send('window:maximize'),
  hideWindow: () => ipcRenderer.send('window:hide'),
  closeWindow: () => ipcRenderer.send('window:close'),
  checkUpdate: () => ipcRenderer.invoke('app:checkUpdate'),
  installUpdate: () => ipcRenderer.invoke('app:installUpdate'),
  openReleasePage: () => ipcRenderer.invoke('app:openReleasePage'),
  getVersion: () => ipcRenderer.invoke('app:getVersion'),
  getRecentLogs: () => ipcRenderer.invoke('app:getRecentLogs'),


  // Settings
  getSettings: () => ipcRenderer.invoke('settings:get'),
  updateSettings: (settings: any) => ipcRenderer.invoke('settings:update', settings),

  // Listen to events from main process
  on: (channel: string, callback: (...args: any[]) => void) => {
    ipcRenderer.on(channel, (_event, ...args) => callback(...args))
  },
  off: (channel: string, callback: (...args: any[]) => void) => {
    ipcRenderer.removeListener(channel, callback)
  },
  onScannerEvent: (channel: 'scanner:new_lead' | 'scanner:status' | 'scanner:log', callback: (data: any) => void) => {
    const listener = (_event: unknown, data: any) => callback(data)
    ipcRenderer.on(channel, listener)
    return () => {
      ipcRenderer.removeListener(channel, listener)
    }
  },
})
