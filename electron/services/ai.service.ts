import axios from 'axios'

export interface AiConfig {
  jobList?: string[]
  jobsText?: string
  systemPrompt?: string
}

const VNVM_POOL_URL = 'https://vnvm-api-pool.hoanglazio17.workers.dev'
const VNVM_CLIENT_TOKEN = 'VNVM_PREMIUM_a2b09889f1eb48ec'

export const DEFAULT_AI_SYSTEM_PROMPT = `Bạn là trợ lý tư vấn tuyển dụng việc làm chuyên nghiệp, thân thiện và nhiệt tình trên mạng xã hội Facebook.
Nhiệm vụ của bạn là:
1. Đọc kỹ nội dung bài viết tìm việc của người dùng Facebook.
2. Đối chiếu với danh sách các công việc được cung cấp để chọn ra 1 công việc (hoặc tối đa 2) phù hợp nhất về địa điểm, thời gian, mức lương hoặc kỹ năng.
3. Soạn MỘT câu bình luận ngắn gọn (dưới 35 từ), xưng hô lịch sự, thân thiện (ví dụ: "mình - bạn", "em - anh/chị"), đi thẳng vào công việc phù hợp và mời nhắn tin/inbox.
4. Yêu cầu quan trọng:
- Tuyệt đối KHÔNG spam, không viết hoa toàn bộ, không dùng từ ngữ đa cấp/lừa đảo.
- Viết tự nhiên như một người thật đang hỗ trợ tìm việc.
- Trả về DUY NHẤT nội dung bình luận cần đăng, không thêm lời giải thích hay trích dẫn nào khác.`

export class AiService {
  constructor() {}

  async generateLeadComment(
    postContent: string,
    authorName: string,
    config: AiConfig
  ): Promise<{ success: boolean; comment?: string; error?: string }> {
    let jobDatabaseText = ''
    if (config.jobList && config.jobList.length > 0) {
      const validJobs = config.jobList.map(j => j.trim()).filter(j => j.length > 0)
      jobDatabaseText = validJobs.map((j, i) => `[Công việc ${i + 1}]:\n${j}`).join('\n\n')
    } else if (config.jobsText && config.jobsText.trim()) {
      jobDatabaseText = config.jobsText.trim()
    }

    if (!jobDatabaseText) {
      return { success: false, error: 'Chưa có thông tin công việc nào được nạp vào AI. Hãy thêm ít nhất 1 ô công việc.' }
    }

    const userPrompt = `DƯỚI ĐÂY LÀ DANH SÁCH CÁC CÔNG VIỆC HIỆN CÓ:
${jobDatabaseText}

------------------------------------
BÀI VIẾT TÌM VIỆC CỦA KHÁCH HÀNG:
Tác giả: ${authorName}
Nội dung bài viết: "${postContent}"
------------------------------------

Hãy chọn 1 công việc phù hợp nhất và tạo 1 câu bình luận ngắn gọn, tự nhiên dưới 35 từ.`

    const systemInstruction = config.systemPrompt && config.systemPrompt.trim()
      ? config.systemPrompt.trim()
      : DEFAULT_AI_SYSTEM_PROMPT

    // Ưu tiên 1: Gọi thẳng qua Gateway /v1/chat/completions của Pool
    try {
      const gatewayRes = await axios.post(
        `${VNVM_POOL_URL}/v1/chat/completions`,
        {
          messages: [
            { role: 'system', content: systemInstruction },
            { role: 'user', content: userPrompt },
          ],
          temperature: 0.7,
          max_tokens: 200,
        },
        {
          headers: {
            Authorization: `Bearer ${VNVM_CLIENT_TOKEN}`,
            'Content-Type': 'application/json',
          },
          timeout: 25000,
        }
      )

      const answer = gatewayRes.data?.choices?.[0]?.message?.content
      if (answer && typeof answer === 'string') {
        const clean = answer.replace(/^["'\s]+|["'\s]+$/g, '').trim()
        return { success: true, comment: clean }
      }
    } catch (gatewayErr: any) {
      console.warn('[VNVM Pool] Gateway /v1/chat/completions warning:', gatewayErr.message)
    }

    // Phương án dự phòng (Fallback): Lấy trực tiếp Active Key từ Pool (/v1/key) để gọi Gemini trực tiếp
    try {
      const keyRes = await axios.get(`${VNVM_POOL_URL}/v1/key`, {
        headers: {
          Authorization: `Bearer ${VNVM_CLIENT_TOKEN}`,
        },
        timeout: 10000,
      })

      const apiKey = keyRes.data?.key
      if (!apiKey) {
        return { success: false, error: 'Không lấy được API key từ VNVM Pool Gateway' }
      }

      // Gọi Google AI Studio với Key được dispense từ Pool
      const geminiEndpoint = `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${apiKey.trim()}`
      const geminiRes = await axios.post(
        geminiEndpoint,
        {
          systemInstruction: {
            parts: [{ text: systemInstruction }],
          },
          contents: [
            {
              role: 'user',
              parts: [{ text: userPrompt }],
            },
          ],
          generationConfig: {
            temperature: 0.7,
            maxOutputTokens: 200,
          },
        },
        { timeout: 20000 }
      )

      const candidate = geminiRes.data?.candidates?.[0]?.content?.parts?.[0]?.text
      if (candidate) {
        const clean = candidate.replace(/^["'\s]+|["'\s]+$/g, '').trim()
        return { success: true, comment: clean }
      }
      return { success: false, error: 'AI không trả về nội dung' }
    } catch (fallbackErr: any) {
      const errMsg = fallbackErr.response?.data?.detail || fallbackErr.response?.data?.error?.message || fallbackErr.message || 'Lỗi kết nối VNVM Pool'
      return { success: false, error: `Lỗi VNVM Pool: ${errMsg}` }
    }
  }
}
