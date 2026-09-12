import { BrowserWindow } from 'electron';

export class GmailWebService {
  private cookies: any[];
  private targetEmail: string;

  constructor(targetEmail: string, cookies: any[]) {
    this.targetEmail = targetEmail;
    this.cookies = cookies;
  }

  // Chờ và đọc OTP của một email mục tiêu
  public async fetchLatestOtp(maxWaitTimeMs: number = 60000, onLog?: (msg: string) => void): Promise<string | null> {
    const log = onLog || console.log;
    const startTime = Date.now();

    return new Promise(async (resolve) => {
      let checkInterval: any = null;
      let isResolved = false;
      
      const partitionId = `gmail_reader_${Date.now()}_${Math.floor(Math.random() * 1000)}`;

      const win = new BrowserWindow({
        width: 800,
        height: 600,
        show: false, // Chạy ngầm hoàn toàn
        webPreferences: {
          partition: partitionId,
          nodeIntegration: false,
          contextIsolation: true
        }
      });

      try {
        log(`[GmailWeb] Bắt đầu phiên làm việc ngầm để đọc thư của ${this.targetEmail}...`);
        
        // Gắn cookies
        for (const cookie of this.cookies) {
          try {
            await win.webContents.session.cookies.set({
              url: 'https://mail.google.com',
              name: cookie.name,
              value: cookie.value,
              domain: cookie.domain,
              path: cookie.path,
              secure: cookie.secure,
              httpOnly: cookie.httpOnly,
              expirationDate: cookie.expirationDate
            });
          } catch (e) {
            // ignore bad cookies
          }
        }

        // Truy cập bản Basic HTML / Mobile của Gmail để cho nhẹ và dễ cào HTML
        await win.loadURL('https://mail.google.com/mail/mu/mp/');
        
        log(`[GmailWeb] Đã load giao diện Web của Gmail. Bắt đầu quét tìm OTP...`);

        // Hàm JavaScript sẽ tiêm vào trang Web
        const extractScript = `
          (() => {
            try {
              // Gmail Mobile (Basic HTML) thường chứa nội dung thư ở dạng list item
              // Quét toàn bộ body text
              const text = document.body.innerText;
              
              // Cào mã OTP Facebook (5, 6 hoặc 8 chữ số)
              const match = text.match(/(?:FB-)?(\\d{5,8})\\s+is your Facebook confirmation/i)
                         || text.match(/FB-(\\d{5,8})/i)
                         || text.match(/mã xác nhận.*?(\\d{5,8})/i)
                         || text.match(/mã bảo mật.*?(\\d{5,8})/i)
                         || text.match(/(\\d{5,8})\\s+là mã xác nhận/i)
                         || text.match(/confirmation code.*?(\\d{5,8})/i)
                         || text.match(/\\b(\\d{5,8})\\b/); // Fallback: 5-8 số bất kỳ trong email mới
            
              if (match && match[1]) {
                return match[1];
              }
              
              // Thử nhấp vào tab/thư mới nếu cần (làm mới trang)
              const refreshBtn = document.querySelector('a[href*="?v=b"]'); // Link Inbox
              if (refreshBtn) refreshBtn.click();
              
              return null;
            } catch (e) {
              return null;
            }
          })();
        `;

        checkInterval = setInterval(async () => {
          if (win.isDestroyed()) {
            clearInterval(checkInterval);
            return;
          }

          if (Date.now() - startTime > maxWaitTimeMs) {
            if (!isResolved) {
              isResolved = true;
              clearInterval(checkInterval);
              win.destroy();
              log('[GmailWeb] Đã hết thời gian chờ mà không thấy mã OTP.');
              resolve(null);
            }
            return;
          }

          try {
            // Ép trang làm mới (F5) nếu đang ở inbox mỗi 5 giây
            await win.webContents.executeJavaScript(`location.reload()`);
            
            // Chờ load xong mới quét
            setTimeout(async () => {
              if (win.isDestroyed()) return;
              const otp = await win.webContents.executeJavaScript(extractScript);
              
              if (otp && !isResolved) {
                isResolved = true;
                log(`[GmailWeb] Tuyệt vời! Đã đọc được mã OTP từ Web: ${otp}`);
                clearInterval(checkInterval);
                win.destroy();
                resolve(otp);
              }
            }, 3000); // Đợi 3s sau khi reload
            
          } catch (err: any) {
            // ignore execute error during navigation
          }
        }, 10000); // Check mỗi 10s (reload + scan)

      } catch (err: any) {
        log(`[GmailWeb] Lỗi khởi tạo: ${err.message}`);
        if (!isResolved) {
          isResolved = true;
          if (checkInterval) clearInterval(checkInterval);
          if (!win.isDestroyed()) win.destroy();
          resolve(null);
        }
      }
    });
  }
}
