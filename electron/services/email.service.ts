import { EventEmitter } from 'events'
import * as imaps from 'imap-simple'
import { simpleParser } from 'mailparser'

export interface FbCodeInfo {
  code: string
  toEmail: string
  timestamp: number
  subject: string
}

export class EmailService extends EventEmitter {
  private connection: imaps.ImapSimple | null = null
  private userEmail: string = ''
  private password: string = ''
  private isConnecting: boolean = false
  private autoReconnect: boolean = false
  private checkInterval: NodeJS.Timeout | null = null

  constructor() {
    super()
  }

  /**
   * Kết nối tới Gmail IMAP
   */
  async connect(user: string, pass: string): Promise<boolean> {
    if (this.isConnecting) return false
    this.isConnecting = true
    this.userEmail = user
    this.password = pass
    this.autoReconnect = true

    const config = {
      imap: {
        user: this.userEmail,
        password: this.password,
        host: 'imap.gmail.com',
        port: 993,
        tls: true,
        authTimeout: 10000,
        tlsOptions: { rejectUnauthorized: false }
      },
    }

    try {
      this.connection = await imaps.connect(config)
      
      this.connection.on('error', (err) => {
        console.error('[EmailService] IMAP Error:', err)
        this.emit('error', err)
      })

      this.connection.on('close', () => {
        console.log('[EmailService] IMAP Connection closed')
        this.emit('disconnected')
        if (this.autoReconnect) {
          setTimeout(() => this.reconnect(), 5000)
        }
      })

      await this.connection.openBox('INBOX')
      console.log(`[EmailService] ✅ Kết nối IMAP thành công tới: ${this.userEmail}`)
      this.emit('connected', this.userEmail)

      // Listen for new mail using IMAP IDLE (if supported, otherwise fallback to polling)
      this.connection.on('mail', (numNewMsgs) => {
        console.log(`[EmailService] 📬 Có ${numNewMsgs} email mới! Đang quét...`)
        this.checkForNewFacebookCodes()
      })

      // Cứ 30s quét lại 1 lần cho chắc ăn (phòng hờ sự kiện mail không bắt được)
      if (this.checkInterval) clearInterval(this.checkInterval)
      this.checkInterval = setInterval(() => this.checkForNewFacebookCodes(), 30000)

      this.isConnecting = false
      return true
    } catch (err) {
      console.error('[EmailService] ❌ Lỗi kết nối IMAP:', err)
      this.isConnecting = false
      this.emit('error', err)
      return false
    }
  }

  /**
   * Ngắt kết nối IMAP
   */
  disconnect() {
    this.autoReconnect = false
    if (this.checkInterval) {
      clearInterval(this.checkInterval)
      this.checkInterval = null
    }
    if (this.connection) {
      this.connection.end()
      this.connection = null
    }
    this.emit('disconnected')
  }

  private async reconnect() {
    if (!this.autoReconnect || !this.userEmail || !this.password) return
    console.log('[EmailService] Đang thử kết nối lại IMAP...')
    await this.connect(this.userEmail, this.password)
  }

  /**
   * Quét các email chưa đọc để tìm thư từ Facebook
   */
  async checkForNewFacebookCodes() {
    if (!this.connection) return

    try {
      const searchCriteria = ['UNSEEN']
      const fetchOptions = {
        bodies: ['HEADER', 'TEXT', ''],
        markSeen: true // Đánh dấu là đã đọc để không quét lại
      }

      const messages = await this.connection.search(searchCriteria, fetchOptions)
      
      for (const msg of messages) {
        const allPart = msg.parts.find((part: any) => part.which === '')
        if (!allPart) continue

        const parsed = await simpleParser(allPart.body)
        const fromObj: any = parsed.from
        const toObj: any = parsed.to
        const from = fromObj?.value?.[0]?.address?.toLowerCase() || ''
        const to = (Array.isArray(toObj) ? toObj[0]?.value?.[0]?.address : toObj?.value?.[0]?.address)?.toLowerCase() || ''
        const subject = parsed.subject || ''
        const text = parsed.text || ''
        
        // Kiểm tra xem có phải email từ Facebook không
        if (from.includes('facebookmail.com') || subject.toLowerCase().includes('facebook')) {
          const code = this.extractFacebookCode(subject, text)
          if (code) {
            const fbCodeInfo: FbCodeInfo = {
              code,
              toEmail: to,
              timestamp: Date.now(),
              subject
            }
            console.log(`[EmailService] 🔑 Bắt được mã FB Code: ${code} cho email: ${to}`)
            this.emit('new_code', fbCodeInfo)
          }
        }
      }
    } catch (err) {
      console.error('[EmailService] Lỗi khi quét email:', err)
    }
  }

  /**
   * Bóc tách mã 8 số hoặc 6 số của Facebook từ Subject hoặc Body
   */
  private extractFacebookCode(subject: string, text: string): string | null {
    // Thường mã FB nằm ở Subject: "123456 is your Facebook recovery code"
    const subjectMatch = subject.match(/\b(\d{6,8})\b/)
    if (subjectMatch) return subjectMatch[1]

    // Hoặc nằm ở nội dung email (Text)
    const textMatch = text.match(/\b(\d{6,8})\b/)
    if (textMatch) return textMatch[1]

    return null
  }
}
