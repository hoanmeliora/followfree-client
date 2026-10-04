import axios from 'axios'
import { StoreService } from './store.service'

const SERVER_URL = process.env.SERVER_URL || 'https://followfree-server.onrender.com/api/v1'
const PUSH_DEBOUNCE_MS = 3000
const REQUEST_TIMEOUT_MS = 20000

/**
 * Đồng bộ danh sách nick local lên server theo user để đăng nhập máy khác vẫn còn nick.
 * - Push: debounce, gửi toàn bộ snapshot sau mỗi lần danh sách thay đổi.
 * - Pull: khi đăng nhập, gộp (union theo id) nick trên server vào local.
 * Mọi lỗi mạng đều best-effort: app vẫn dùng bình thường với dữ liệu local.
 */
export class AccountSyncService {
  private pushTimer: NodeJS.Timeout | null = null
  private isPulling = false

  constructor(private readonly store: StoreService) {
    this.store.onAccountsChanged(() => this.schedulePush())
  }

  async pull(): Promise<{ success: boolean; added: number }> {
    const token = this.store.getSession()?.token
    if (!token) return { success: false, added: 0 }

    this.isPulling = true
    try {
      const res = await axios.get(`${SERVER_URL}/accounts/sync`, {
        headers: { Authorization: `Bearer ${token}` },
        timeout: REQUEST_TIMEOUT_MS,
      })
      const remote: Array<{ id?: string }> = Array.isArray(res.data?.accounts) ? res.data.accounts : []
      const localIds = new Set(this.store.getAccounts().map((a) => a.id))
      const missing = remote.filter((a) => a?.id && !localIds.has(a.id))

      if (missing.length > 0) this.store.addAccounts(missing as any)
      return { success: true, added: missing.length }
    } catch (err: any) {
      console.error('[AccountSync] pull failed:', err.response?.data ?? err.message)
      return { success: false, added: 0 }
    } finally {
      this.isPulling = false
      // Đẩy lại bản gộp để server có đủ nick của mọi máy
      this.schedulePush()
    }
  }

  private schedulePush(): void {
    if (this.pushTimer) clearTimeout(this.pushTimer)
    this.pushTimer = setTimeout(() => void this.push(), PUSH_DEBOUNCE_MS)
  }

  private async push(): Promise<void> {
    this.pushTimer = null
    if (this.isPulling) return this.schedulePush()

    const token = this.store.getSession()?.token
    if (!token) return

    try {
      await axios.put(
        `${SERVER_URL}/accounts/sync`,
        { accounts: this.store.getAccounts() },
        { headers: { Authorization: `Bearer ${token}` }, timeout: REQUEST_TIMEOUT_MS },
      )
    } catch (err: any) {
      console.error('[AccountSync] push failed:', err.response?.data ?? err.message)
    }
  }
}
