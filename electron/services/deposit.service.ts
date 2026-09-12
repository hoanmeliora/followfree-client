import axios from 'axios'
import { StoreService } from './store.service'

const SERVER_URL = process.env.SERVER_URL || 'https://followfree-server.onrender.com/api/v1'

export class DepositService {
  constructor(private readonly store: StoreService) {}

  private getHeaders() {
    const session = this.store.getSession()
    return {
      Authorization: `Bearer ${session?.token}`,
      'Content-Type': 'application/json',
    }
  }

  async getDepositInfo() {
    try {
      const res = await axios.get(`${SERVER_URL}/deposits/info`, { headers: this.getHeaders() })
      return { success: true, data: res.data }
    } catch (err: any) {
      const message = err.response?.data?.message ?? 'Không lấy được thông tin nạp tiền'
      return { success: false, error: message }
    }
  }

  async mockDeposit(amount: number, syntax: string) {
    try {
      const res = await axios.post(`${SERVER_URL}/deposits/webhook`, {
        transferAmount: amount,
        content: syntax
      })
      return { success: true, data: res.data }
    } catch (err: any) {
      return { success: false, error: 'Mock lỗi' }
    }
  }
}
