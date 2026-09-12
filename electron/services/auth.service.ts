import axios from 'axios'
import { StoreService } from './store.service'

const SERVER_URL = process.env.SERVER_URL || 'https://followfree-server.onrender.com/api/v1'

export class AuthService {
  constructor(private readonly store: StoreService) {}

  async login(username: string, password: string) {
    try {
      const res = await axios.post(`${SERVER_URL}/auth/login`, {
        username,
        password,
      })

      const { user, token } = res.data
      this.store.saveSession({ token, user })

      return { success: true, user, token }
    } catch (err: any) {
      const message =
        err.response?.data?.message ?? 'Không thể kết nối đến server'
      return { success: false, error: message }
    }
  }

  async register(username: string, email: string, password: string) {
    try {
      const res = await axios.post(`${SERVER_URL}/auth/register`, {
        username,
        email,
        password,
      })

      const { user, token } = res.data
      this.store.saveSession({ token, user })

      return { success: true, user, token }
    } catch (err: any) {
      const message =
        err.response?.data?.message ?? 'Không thể kết nối đến server'
      return { success: false, error: message }
    }
  }

  async getMe() {
    try {
      const session = this.store.getSession()
      if (!session) return { success: false, error: 'Chưa đăng nhập' }

      const res = await axios.get(`${SERVER_URL}/auth/me`, {
        headers: { Authorization: `Bearer ${session.token}` },
      })
      
      // Update store with new user data (e.g. points)
      this.store.saveSession({ token: session.token, user: res.data })
      
      return { success: true, data: res.data }
    } catch (err: any) {
      return { success: false, error: 'Lỗi tải dữ liệu người dùng' }
    }
  }

  async changePassword(oldPassword: string, newPassword: string) {
    try {
      const session = this.store.getSession()
      if (!session) return { success: false, error: 'Chưa đăng nhập' }

      const res = await axios.post(`${SERVER_URL}/auth/change-password`, {
        oldPassword, newPassword
      }, {
        headers: { Authorization: `Bearer ${session.token}` },
      })
      
      return { success: true, data: res.data }
    } catch (err: any) {
      const message = err.response?.data?.message ?? 'Không thể đổi mật khẩu'
      return { success: false, error: message }
    }
  }

  /**
   * Đồng bộ cookie mới lên Server sau khi nông dân gỡ checkpoint.
   * Server sẽ mã hóa và lưu an toàn, đảm bảo nick không bị mất cookie khi đổi máy.
   */
  async syncCookieToServer(accountId: string, cookieData: string): Promise<{ success: boolean }> {
    try {
      const session = this.store.getSession()
      if (!session) return { success: false }

      await axios.patch(`${SERVER_URL}/accounts/${encodeURIComponent(accountId)}/cookie`, {
        cookieData,
      }, {
        headers: { Authorization: `Bearer ${session.token}` },
      })

      return { success: true }
    } catch (err: any) {
      // Không throw lỗi - việc sync lấy cookie lên server là best-effort
      console.error('[AuthService] syncCookieToServer failed:', err.response?.data ?? err.message)
      return { success: false }
    }
  }
}
