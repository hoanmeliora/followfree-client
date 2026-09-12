import axios from 'axios'
import { StoreService } from './store.service'

const SERVER_URL = process.env.SERVER_URL || 'https://followfree-server.onrender.com/api/v1'

export class CampaignService {
  constructor(private readonly store: StoreService) {}

  private getHeaders() {
    const session = this.store.getSession()
    return {
      Authorization: `Bearer ${session?.token}`,
      'Content-Type': 'application/json',
    }
  }

  async createCampaign(platform: string, actionType: string, targetUrl: string, targetCount: number, startCount?: number, metadata?: any) {
    try {
      const res = await axios.post(
        `${SERVER_URL}/campaigns`,
        { platform, actionType, targetUrl, targetCount, startCount, metadata },
        { headers: this.getHeaders() }
      )
      return { success: true, data: res.data }
    } catch (err: any) {
      // Axios error
      const message = err.response?.data?.message ?? 'Lỗi kết nối đến máy chủ. Vui lòng thử lại.'
      return { success: false, error: message }
    }
  }

  async getCampaigns() {
    try {
      const res = await axios.get(`${SERVER_URL}/campaigns`, { headers: this.getHeaders() })
      return { success: true, data: res.data }
    } catch (err: any) {
      return { success: false, error: 'Không thể lấy danh sách chiến dịch' }
    }
  }

  async cancelCampaign(id: string) {
    try {
      const res = await axios.delete(`${SERVER_URL}/campaigns/${id}`, { headers: this.getHeaders() })
      return { success: true, data: res.data }
    } catch (err: any) {
      const message = err.response?.data?.message ?? 'Lỗi kết nối đến máy chủ.'
      return { success: false, error: message }
    }
  }
}
