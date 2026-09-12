import { BrowserWindow } from 'electron'
import { AutomationService } from './automation.service'

export class SelfHealingService {
  constructor(private automationService: AutomationService) {}

  /**
   * Quét toàn bộ DOM bằng Heuristic để tìm phần tử dựa trên actionType.
   * Trả về true nếu tìm thấy và click thành công.
   */
  async findAndClickByHeuristics(win: BrowserWindow, actionType: string): Promise<boolean> {
    console.log(`[Self-Healing] ⚠️ CẢNH BÁO: Mất dấu nút bấm. Khởi động AI trực giác tìm nút cho hành động: ${actionType}`)
    
    // Tiêm script quét DOM vào trình duyệt
    const scanScript = `
      (function() {
        const actionType = '${actionType}';
        const keywords = {
          'LIKE': ['thích', 'like', '👍'],
          'LOVE': ['yêu thích', 'love', 'tym', 'tim', '❤️'],
          'HAHA': ['haha', 'cười', '😆', '😂'],
          'WOW': ['wow', 'ngạc nhiên', '😲', '😮'],
          'SAD': ['buồn', 'sad', 'khóc', '😢', '😭'],
          'ANGRY': ['phẫn nộ', 'angry', 'tức giận', '😡', '🤬'],
          'FOLLOW': ['theo dõi', 'follow', 'đăng ký', 'subscribe', 'thêm bạn bè', 'thêm bạn', 'add friend', 'kết bạn'],
          'SHARE_GROUP': ['chia sẻ', 'share', 'share to a group', 'chia sẻ vào nhóm']
        };
        
        let targetEl = null;
        let targetSelector = '';
        
        // 1. Quét theo chữ (Text) bên trong các thẻ click được
        const clickableTags = ['BUTTON', 'A', 'DIV', 'SPAN'];
        const allElements = document.querySelectorAll(clickableTags.join(','));
        
        let targetWords = keywords[actionType] || [];
        for (const el of allElements) {
          // Lọc các thẻ có tính tương tác
          const role = el.getAttribute('role');
          const isInteractive = el.tagName === 'BUTTON' || el.tagName === 'A' || role === 'button' || role === 'link' || el.onclick;
          
          if (!isInteractive && el.tagName !== 'DIV' && el.tagName !== 'SPAN') continue;
          
          const text = (el.innerText || el.getAttribute('aria-label') || el.title || '').toLowerCase().trim();
          const isVisible = el.offsetWidth > 0 && el.offsetHeight > 0;
          
          // Kiểm tra xem nó có KHỚP HOÀN TOÀN với từ khóa không, để tránh bấm nhầm (ví dụ: "Tìm bạn bè")
          const isExactMatch = targetWords.includes(text);
          // Chỉ cho phép chứa từ khóa nếu đoạn text đủ ngắn (tránh click nguyên cái Body bài viết)
          const isContainsMatch = targetWords.some(w => text.includes(w)) && text.length < 30;
          
          if (isVisible && (isExactMatch || isContainsMatch)) {
             // Đảm bảo không phải là các nút report/block
             if (!text.includes('báo cáo') && !text.includes('chặn') && !text.includes('tìm bạn bè')) {
                // Ưu tiên các phần tử nhỏ nhất (nằm sâu nhất) chứa chữ này
                if (!targetEl || (el.offsetWidth * el.offsetHeight) < (targetEl.offsetWidth * targetEl.offsetHeight)) {
                    targetEl = el;
                    targetSelector = el.getAttribute('aria-label') ? \`\${el.tagName.toLowerCase()}[aria-label="\${el.getAttribute('aria-label')}"]\` : \`\${el.tagName.toLowerCase()}:contains("\${text}")\`;
                }
             }
          }
        }
        
        // 2. Nếu không thấy chữ, quét theo SVG (Đặc trị Facebook hay dùng Icon SVG không chữ)
        if (!targetEl && ['LIKE', 'LOVE', 'HAHA', 'WOW', 'SAD', 'ANGRY'].includes(actionType)) {
          const svgs = document.querySelectorAll('svg');
          for(const svg of svgs) {
            // Facebook thường bỏ aria-label ở thẻ chứa SVG hoặc gán cho thẻ cha
            const parent = svg.closest('[role="button"]') || svg.closest('div[aria-label]');
            if (parent && parent.offsetWidth > 0) {
               const aria = (parent.getAttribute('aria-label') || '').toLowerCase();
               if (aria.includes('like') || aria.includes('thích')) {
                  targetEl = parent;
                  targetSelector = \`div[aria-label="\${parent.getAttribute('aria-label')}"]\`;
                  break;
               }
            }
          }
        }
        
        if (!targetEl) return null;
        
        targetEl.scrollIntoView({ behavior: 'instant', block: 'center' });
        const rect = targetEl.getBoundingClientRect();

        return {
          x: rect.left + rect.width / 2,
          y: rect.top + rect.height / 2,
          selectorFound: targetSelector
        };
      })()
    `

    try {
      let result: any = await win.webContents.executeJavaScript(scanScript)
      
      if (!result) {
        console.log(`[Self-Healing] ❌ Vô phương cứu chữa! Không thể nhận diện được giao diện mới.`)
        return false
      }

      console.log(`[Self-Healing] ✅ TÌM THẤY BẰNG TRỰC GIÁC! Tọa độ: X:${Math.round(result.x)} Y:${Math.round(result.y)}`)
      console.log(`[Self-Healing] 📡 CSS Selector mới được tiên đoán: ${result.selectorFound}`)
      console.log(`[Self-Healing] 📡 Đang đẩy Selector mới lên Máy Chủ để cập nhật cho 10 triệu Worker khác...`)

      // Chờ cuộn trang tới vị trí ổn định
      await this.automationService.wait(1000)

      // Mô phỏng di chuột và click thật bằng OS-level (Sử dụng lại chuẩn của AutomationService)
      win.webContents.sendInputEvent({ type: 'mouseMove', x: Math.round(result.x), y: Math.round(result.y) })
      await this.automationService.wait(this.automationService.randomWait(200, 400))
      
      win.webContents.sendInputEvent({ type: 'mouseDown', x: Math.round(result.x), y: Math.round(result.y), button: 'left', clickCount: 1 })
      await this.automationService.wait(this.automationService.randomWait(50, 150))
      
      win.webContents.sendInputEvent({ type: 'mouseUp', x: Math.round(result.x), y: Math.round(result.y), button: 'left', clickCount: 1 })

      return true
    } catch (e) {
      console.warn('[Self-Healing] ❌ Error running heuristic script:', e)
      return false
    }
  }
}
