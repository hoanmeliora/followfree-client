import { BrowserWindow, ipcMain } from 'electron'
import { StoreService } from './store.service'
import { EmailService } from './email.service'
import { EventEmitter } from 'events'

const HO = ['Nguyễn', 'Trần', 'Lê', 'Phạm', 'Hoàng', 'Huỳnh', 'Phan', 'Vũ', 'Võ', 'Đặng', 'Bùi', 'Đỗ', 'Hồ', 'Ngô', 'Dương', 'Lý']
const TEN = ['Anh', 'Tuấn', 'Thảo', 'Linh', 'Hải', 'Trang', 'Hùng', 'Minh', 'Long', 'Duy', 'Hương', 'Nam', 'Hoa', 'Tâm', 'Đạt', 'Phương', 'Hà', 'Khang', 'Bảo', 'Ngọc', 'Mai']

function randomItem(arr: string[]) {
  return arr[Math.floor(Math.random() * arr.length)]
}

function getRandomUserAgent(): string {
  const agents = [
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/119.0.0.0 Safari/537.36',
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:109.0) Gecko/20100101 Firefox/119.0',
  ]
  return agents[Math.floor(Math.random() * agents.length)]
}

export class RegService extends EventEmitter {
  constructor(
    private storeService: StoreService,
    private emailService: EmailService
  ) {
    super()
  }

  generateEmailAlias(masterEmail: string): string {
    // Nếu là gmail, hỗ trợ alias bằng dấu +
    // VD: master@gmail.com -> master+rnd123@gmail.com
    // Nếu là domain riêng, tự chế alias
    // VD: admin@domain.com -> rnd123@domain.com (nếu bật catch-all)
    const randomStr = Math.random().toString(36).substring(2, 8)
    if (masterEmail.includes('@gmail.com')) {
      const parts = masterEmail.split('@')
      return `${parts[0]}+${randomStr}@${parts[1]}`
    } else {
      const parts = masterEmail.split('@')
      return `${randomStr}@${parts[1]}`
    }
  }

  async startRegFlow(onProgress: (msg: string) => void): Promise<{ success: boolean; error?: string; account?: any }> {
    const emailConfig = this.storeService.getEmailConfig()
    if (!emailConfig || !emailConfig.email) {
      return { success: false, error: 'Chưa cấu hình Email Master' }
    }

    const targetEmail = this.generateEmailAlias(emailConfig.email)
    const password = 'Aa1' + Math.random().toString(36).substring(2, 10) + '!'
    const ho = randomItem(HO)
    const ten = randomItem(TEN)
    
    onProgress(`Đang tạo thông tin: ${ho} ${ten} - Email: ${targetEmail}`)

    return new Promise((resolve) => {
      const randomUserAgent = getRandomUserAgent()
      const regWin = new BrowserWindow({
        width: 1000,
        height: 800,
        title: `Đăng ký Facebook - ${targetEmail}`,
        autoHideMenuBar: true,
        webPreferences: {
          partition: `reg_${Date.now()}`,
          nodeIntegration: false,
          contextIsolation: true
        }
      })
      
      regWin.webContents.userAgent = randomUserAgent

      const cleanup = () => {
        this.emailService.removeListener('new_code', onNewCode)
        if (!regWin.isDestroyed()) {
          regWin.close()
        }
      }

      // Xử lý bắt mã Email
      let expectedCode: string | null = null
      let isWaitingForCode = false

      const onNewCode = async (data: any) => {
        if (!isWaitingForCode) return
        
        // Kiểm tra xem mã có gửi về đúng email đăng ký không
        // Do alias Gmail, toEmail có thể không chứa dấu + mà trỏ thẳng về master,
        // Nhưng nếu là Catch-all domain thì toEmail sẽ chuẩn. 
        // Chúng ta tạm thời chấp nhận mã mới nhất nếu nó khớp thời gian gần đây
        if (data.toEmail.includes(targetEmail) || emailConfig.email.includes('@gmail.com')) {
          expectedCode = data.code
          onProgress(`Đã nhận được mã xác nhận: ${expectedCode}`)
          
          if (!regWin.isDestroyed()) {
            try {
              // Bơm script điền mã vào ô xác nhận
              await regWin.webContents.executeJavaScript(`
                (function() {
                  // Thử tìm ô input mã xác nhận
                  const codeInput = document.querySelector('input[name="code"]') || document.querySelector('input[id*="recovery_code"]');
                  if (codeInput) {
                    codeInput.value = '${expectedCode}';
                    codeInput.dispatchEvent(new Event('input', { bubbles: true }));
                    
                    // Thử tìm nút xác nhận
                    const confirmBtns = Array.from(document.querySelectorAll('button[type="submit"], input[type="submit"]'));
                    if (confirmBtns.length > 0) {
                      confirmBtns[0].click();
                    }
                  }
                })();
              `)
              onProgress(`Đã điền mã xác nhận... chờ phản hồi`)
              
              // Chờ một chút để FB xử lý, sau đó lấy cookie
              setTimeout(async () => {
                if (regWin.isDestroyed()) return
                const cookies = await regWin.webContents.session.cookies.get({ url: 'https://www.facebook.com' })
                const cUser = cookies.find(c => c.name === 'c_user')
                
                if (cUser) {
                  onProgress(`Tạo tài khoản thành công! UID: ${cUser.value}`)
                  const newAcc = {
                    id: `reg_${Date.now()}`,
                    platform: 'FACEBOOK',
                    username: `${ho} ${ten}`,
                    cookieData: JSON.stringify(cookies),
                    status: 'ACTIVE',
                    isManual: false,
                    userAgent: randomUserAgent
                  }
                  
                  // Lưu vào Store
                  this.storeService.addAccounts([newAcc])
                  
                  cleanup()
                  resolve({ success: true, account: newAcc })
                } else {
                  onProgress(`Điền mã xong nhưng không thấy cookie đăng nhập. Có thể bị checkpoint 282.`)
                  cleanup()
                  resolve({ success: false, error: 'Checkpoint 282 sau khi điền mã' })
                }
              }, 10000)
            } catch (e: any) {
              onProgress(`Lỗi khi điền mã: ${e.message}`)
            }
          }
        }
      }

      this.emailService.on('new_code', onNewCode)

      regWin.loadURL('https://www.facebook.com/reg')

      regWin.webContents.on('dom-ready', async () => {
        try {
          const url = regWin.webContents.getURL()
          
          if (url.includes('facebook.com/reg')) {
            onProgress(`Đang điền Form đăng ký...`)
            await regWin.webContents.executeJavaScript(`
              (function() {
                // Điền Họ và Tên
                const firstname = document.querySelector('input[name="firstname"]');
                const lastname = document.querySelector('input[name="lastname"]');
                if (firstname) { firstname.value = '${ho}'; firstname.dispatchEvent(new Event('input', { bubbles: true })); }
                if (lastname) { lastname.value = '${ten}'; lastname.dispatchEvent(new Event('input', { bubbles: true })); }
                
                // Điền Email
                const emailInput = document.querySelector('input[name="reg_email__"]');
                if (emailInput) { 
                  emailInput.value = '${targetEmail}'; 
                  emailInput.dispatchEvent(new Event('input', { bubbles: true })); 
                  
                  // Kích hoạt ô xác nhận lại email nếu có
                  setTimeout(() => {
                    const confirmEmail = document.querySelector('input[name="reg_email_confirmation__"]');
                    if (confirmEmail) {
                      confirmEmail.value = '${targetEmail}';
                      confirmEmail.dispatchEvent(new Event('input', { bubbles: true }));
                    }
                  }, 500);
                }
                
                // Điền Password
                const passInput = document.querySelector('input[name="reg_passwd__"]');
                if (passInput) { passInput.value = '${password}'; passInput.dispatchEvent(new Event('input', { bubbles: true })); }
                
                // Chọn ngày sinh ngẫu nhiên (18-30 tuổi)
                const day = document.querySelector('select[name="birthday_day"]');
                const month = document.querySelector('select[name="birthday_month"]');
                const year = document.querySelector('select[name="birthday_year"]');
                if (day) { day.value = Math.floor(Math.random() * 28) + 1; day.dispatchEvent(new Event('change', { bubbles: true })); }
                if (month) { month.value = Math.floor(Math.random() * 12) + 1; month.dispatchEvent(new Event('change', { bubbles: true })); }
                if (year) { year.value = 2005 - Math.floor(Math.random() * 10); year.dispatchEvent(new Event('change', { bubbles: true })); }
                
                // Chọn giới tính
                const gender = document.querySelector('input[name="sex"][value="1"]') || document.querySelector('input[name="sex"][value="2"]');
                if (gender) { gender.click(); }
                
                // Bấm nút Đăng Ký
                setTimeout(() => {
                  const submitBtn = document.querySelector('button[name="websubmit"]');
                  if (submitBtn) { submitBtn.click(); }
                }, 2000);
              })();
            `)
            onProgress(`Đã submit form đăng ký. Chờ xác minh...`)
          } else if (url.includes('confirmemail') || url.includes('checkpoint')) {
            onProgress(`Đang chờ mã xác nhận gửi về email ${targetEmail} (tối đa 3 phút)...`)
            isWaitingForCode = true
            
            // Timeout chờ mã
            setTimeout(() => {
              if (isWaitingForCode && !regWin.isDestroyed()) {
                onProgress(`Quá hạn chờ mã xác nhận. Đang hủy...`)
                cleanup()
                resolve({ success: false, error: 'Timeout chờ mã xác nhận' })
              }
            }, 180000)
          }
        } catch (e: any) {
          console.error(e)
          onProgress(`Lỗi DOM: ${e.message}`)
        }
      })

      regWin.on('closed', () => {
        cleanup()
        resolve({ success: false, error: 'Người dùng đóng cửa sổ giữa chừng' })
      })
    })
  }
}
