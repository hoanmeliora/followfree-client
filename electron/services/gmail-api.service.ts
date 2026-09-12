export class GmailApiService {
  private accessToken: string;
  private refreshToken: string;
  private clientId: string = '402293795356-v5jk9tt6sij56188c9qa4asuekodd5vs.apps.googleusercontent.com';
  private clientSecret: string = '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';

  constructor(tokenData: any) {
    this.accessToken = tokenData.access_token;
    this.refreshToken = tokenData.refresh_token;
  }

  private async refreshAccessToken(): Promise<boolean> {
    if (!this.refreshToken) return false;
    try {
      const res = await fetch('https://oauth2.googleapis.com/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          client_id: this.clientId,
          client_secret: this.clientSecret,
          refresh_token: this.refreshToken,
          grant_type: 'refresh_token'
        })
      });
      const data = await res.json();
      if (data.access_token) {
        this.accessToken = data.access_token;
        return true;
      }
      return false;
    } catch (e) {
      return false;
    }
  }

  private async getMessageList(): Promise<any[]> {
    const res = await fetch('https://gmail.googleapis.com/gmail/v1/users/me/messages?maxResults=5&q=in:inbox', {
      headers: { Authorization: `Bearer ${this.accessToken}` }
    });
    
    if (res.status === 401) {
      const refreshed = await this.refreshAccessToken();
      if (refreshed) {
        return this.getMessageList();
      }
      return [];
    }
    
    const data = await res.json();
    return data.messages || [];
  }

  private async getMessageContent(messageId: string): Promise<string> {
    const res = await fetch(`https://gmail.googleapis.com/gmail/v1/users/me/messages/${messageId}?format=full`, {
      headers: { Authorization: `Bearer ${this.accessToken}` }
    });
    const data = await res.json();
    
    let bodyData = '';
    
    // Đệ quy tìm đoạn text trong payload
    const getBody = (part: any) => {
      if (part.body && part.body.data) {
        // Base64URL decode
        const decoded = Buffer.from(part.body.data.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
        bodyData += decoded + ' ';
      }
      if (part.parts) {
        for (const p of part.parts) {
          getBody(p);
        }
      }
    };

    if (data.payload) {
      getBody(data.payload);
    }
    
    return bodyData;
  }

  public async fetchLatestOtp(maxWaitTimeMs: number = 60000, onLog?: (msg: string) => void): Promise<string | null> {
    const log = onLog || console.log;
    const startTime = Date.now();
    let seenMessageIds = new Set<string>();

    log(`[GmailAPI] Bắt đầu lấy OTP qua Google REST API...`);

    return new Promise((resolve) => {
      let isResolved = false;

      const checkInterval = setInterval(async () => {
        if (Date.now() - startTime > maxWaitTimeMs) {
          if (!isResolved) {
            isResolved = true;
            clearInterval(checkInterval);
            log('[GmailAPI] Đã hết thời gian chờ mà không thấy mã OTP.');
            resolve(null);
          }
          return;
        }

        try {
          const messages = await this.getMessageList();
          
          for (const msg of messages) {
            if (!seenMessageIds.has(msg.id)) {
              seenMessageIds.add(msg.id);
              const content = await this.getMessageContent(msg.id);
              
              // Cào mã OTP (Hỗ trợ 5, 6 hoặc 8 số)
              const match = content.match(/(?:FB-)?(\d{5,8})\s+is your Facebook confirmation/i) 
                         || content.match(/FB-(\d{5,8})/i)
                         || content.match(/mã xác nhận.*?(\d{5,8})/i)
                         || content.match(/mã bảo mật.*?(\d{5,8})/i)
                         || content.match(/(\d{5,8})\s+là mã xác nhận/i)
                         || content.match(/confirmation code.*?(\d{5,8})/i)
                         || content.match(/\b(\d{5,8})\b/); // Fallback: Lấy chuỗi số bất kỳ trong email (vì mới nhận)
                         
              if (match && match[1] && !isResolved) {
                isResolved = true;
                log(`[GmailAPI] Tuyệt vời! Đã lấy được OTP siêu tốc qua API: ${match[1]}`);
                clearInterval(checkInterval);
                resolve(match[1]);
                return;
              }
            }
          }
        } catch (err: any) {
          log(`[GmailAPI] Lỗi trong quá trình check: ${err.message}`);
        }
      }, 5000); // Check 5 giây 1 lần
    });
  }
}
