import { Page } from 'playwright'

/**
 * Contract chung cho tất cả Platform Executor.
 * WorkerService chỉ biết về interface này — không import trực tiếp Facebook hay TikTok.
 * Thêm platform mới: tạo file mới implement interface này + register vào WorkerService.
 */
export interface IPlatformExecutor {
  readonly platform: string

  /**
   * Thực hiện hành động (Like, Follow, Share...)
   * @param page Instance của trình duyệt Playwright
   * @param task Toàn bộ thông tin của nhiệm vụ
   * @returns true nếu thành công, false nếu lỗi, chuỗi nếu có lỗi cụ thể
   */
  performAction(page: Page, task: any, account?: any): Promise<boolean | string>

  /**
   * Thực thi tính năng "Nuôi Nick" (Tự động lướt Newsfeed/Video để tạo Trust Score)
   * @param page Playwright Page đã inject cookie, sẵn sàng mô phỏng người dùng.
   * @returns true nếu hoàn thành việc nuôi.
   */
  performNurturing(page: Page): Promise<boolean>
}
