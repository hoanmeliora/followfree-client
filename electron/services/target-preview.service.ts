import { BrowserWindow } from 'electron'

/**
 * TargetPreviewService
 * Quét số liệu hiện tại của một URL mục tiêu (followers, likes)
 * trước khi người dùng tạo chiến dịch.
 * Tách biệt hoàn toàn với luồng thực thi task.
 */
export class TargetPreviewService {
  /**
   * @param url         URL bài viết / trang cá nhân
   * @param actionType  'FOLLOW' | 'LIKE' | 'LOVE' | ...
   * @param account     Tài khoản dùng để quét (có cookie), null = quét ẩn danh
   */
  async previewTarget(url: string, actionType: string, account: any | null): Promise<number | null> {
    const hiddenWin = new BrowserWindow({
      width: 1280,
      height: 800,
      show: false,
      webPreferences: {
        nodeIntegration: false,
        contextIsolation: true,
        partition: account ? `persist:${account.id}` : `preview_${Date.now()}`,
      },
    })

    if (account?.userAgent) {
      hiddenWin.webContents.setUserAgent(account.userAgent)
    }

    try {
      await this.injectCookies(hiddenWin, url, account)
      await hiddenWin.loadURL(url)
      await new Promise((r) => setTimeout(r, 2000))

      const currentLoadedUrl = hiddenWin.webContents.getURL()
      console.log(`[Preview] 🌐 Loaded: ${currentLoadedUrl} | Target: ${url}`)

      if (actionType === 'FOLLOW') {
        return await this.scanFollowerCount(hiddenWin)
      }

      if (['LIKE', 'LOVE', 'HAHA', 'WOW', 'SAD', 'ANGRY'].includes(actionType)) {
        return await this.scanReactionCount(hiddenWin)
      }

      return null
    } finally {
      hiddenWin.destroy()
    }
  }

  // ---------------------------------------------------------------------------

  private async injectCookies(win: BrowserWindow, url: string, account: any | null): Promise<void> {
    if (!account?.cookieData) return

    let cookies: any[] = []
    try {
      cookies = JSON.parse(account.cookieData)
    } catch {
      cookies = account.cookieData.split(';').map((pair: string) => {
        const [name, ...rest] = pair.trim().split('=')
        return { name, value: rest.join('='), domain: '.facebook.com', path: '/' }
      })
    }

    const baseUrl = url.includes('tiktok') ? 'https://www.tiktok.com' : 'https://www.facebook.com'
    for (const cookie of cookies) {
      try {
        const { hostOnly, session, sameSite, ...validCookie } = cookie
        validCookie.url = baseUrl
        if (['no_restriction', 'lax', 'strict'].includes(sameSite)) {
          validCookie.sameSite = sameSite
        }
        await win.webContents.session.cookies.set(validCookie)
      } catch {}
    }
  }

  // ---------------------------------------------------------------------------
  // FACEBOOK FOLLOW: Quét số người theo dõi
  // ---------------------------------------------------------------------------

  private async scanFollowerCount(win: BrowserWindow): Promise<number | null> {
    const result = await win.webContents.executeJavaScript(`
      (async function() {
        let logs = [];
        for (let attempt = 0; attempt < 12; attempt++) {
          if (!document || !document.body) {
            await new Promise(r => setTimeout(r, 1000));
            continue;
          }

          if (attempt === 0) console.log("[Preview Page Title]: " + document.title);

          // 1. Quét theo thẻ link/span liên quan đến followers
          const candidateEls = Array.from(document.querySelectorAll('a[href*="follower"], a[href*="followers"], span, div'));
          for (let el of candidateEls) {
            const text = (el.innerText || el.getAttribute('aria-label') || '').trim();
            if (text && (text.includes('người theo dõi') || text.toLowerCase().includes('followers'))) {
              const m = text.match(/([0-9.,]+)\\s*(K|M|B)?\\s*(người theo dõi|followers)/i)
                     || text.match(/(followers|người theo dõi)\\s*[:•]?\\s*([0-9.,]+)\\s*(K|M|B)?/i);
              if (m) {
                const rawNum = m[1] && /[0-9]/.test(m[1]) ? m[1] : m[2];
                const unit   = m[2] && !/[0-9]/.test(m[2]) ? m[2] : (m[3] || '');
                let num = parseFloat(rawNum.replace(/,/g, '.'));
                if (unit.toUpperCase() === 'K') num *= 1000;
                if (unit.toUpperCase() === 'M') num *= 1000000;
                if (unit.toUpperCase() === 'B') num *= 1000000000;
                if (num >= 0) return { result: Math.floor(num), logs: ['Found element text: ' + text] };
              }
            }
          }

          // 2. Fallback: Regex toàn bodyText
          const bodyText = document.body.innerText;
          if (bodyText) {
            const match = bodyText.match(/([0-9.,]+)\\s*(K|M|B)?\\s*(người theo dõi|followers)/i);
            if (match) {
              logs.push("Regex matched: " + match[0]);
              let num = parseFloat(match[1].replace(/,/g, '.'));
              if (match[2]?.toUpperCase() === 'K') num *= 1000;
              if (match[2]?.toUpperCase() === 'M') num *= 1000000;
              if (match[2]?.toUpperCase() === 'B') num *= 1000000000;
              if (num >= 0) return { result: Math.floor(num), logs };
            }
          }
          await new Promise(r => setTimeout(r, 1000));
        }
        return { result: null, logs, bodySnippet: document.body?.innerText.substring(0, 300) || '' };
      })()
    `)

    console.log('[Preview] 🔍 Follower scan result:', result)
    return result.result
  }

  // ---------------------------------------------------------------------------
  // FACEBOOK LIKE: Quét số reaction
  // ---------------------------------------------------------------------------

  private async scanReactionCount(win: BrowserWindow): Promise<number | null> {
    const result = await win.webContents.executeJavaScript(`
      (async function() {
        let logs = [];
        for (let attempt = 0; attempt < 12; attempt++) {
          if (!document || !document.body) {
            await new Promise(r => setTimeout(r, 1000));
            continue;
          }

          let candidates = [];

          let foundLikeBtn = false;
          // 1. Quét nút Like/button có số đi kèm
          const buttons = Array.from(document.querySelectorAll('div[role="button"], span[role="button"], div[aria-label]'));
          for (let btn of buttons) {
            const text = (btn.innerText || '').toLowerCase().replace(/[\u200B-\u200D\uFEFF]/g, '').trim();
            const html = (btn.innerHTML || '').toLowerCase();
            const aria = (btn.getAttribute('aria-label') || '').toLowerCase();

            const isLikeBtn = (html.includes('thích') || html.includes('like') || aria.includes('thích') || aria.includes('like') || aria.includes('cảm xúc')
                            || html.includes('love') || html.includes('yêu') || aria.includes('love') || aria.includes('yêu')
                            || html.includes('haha') || aria.includes('haha') || html.includes('wow') || aria.includes('wow')
                            || html.includes('sad') || html.includes('buồn') || aria.includes('sad') || aria.includes('buồn')
                            || html.includes('angry') || html.includes('phẫn nộ') || aria.includes('angry') || aria.includes('phẫn nộ')
                            || html.includes('care') || html.includes('thương') || aria.includes('care') || aria.includes('thương'))
                           && !html.includes('bình luận') && !html.includes('chia sẻ')
                           && !html.includes('comment') && !html.includes('share')
                           && !aria.includes('bình luận') && !aria.includes('chia sẻ') && !aria.includes('comment') && !aria.includes('share');

            if (isLikeBtn) {
              foundLikeBtn = true;
              if (text.length > 0 && text.length < 50) {
                const numMatch = text.match(/^([0-9.,]+)\\s*(K|M|B)?$/i) || text.match(/([0-9.,]+)\\s*(K|M|B)?/i);
                if (numMatch) {
                  let num = parseFloat(numMatch[1].replace(/,/g, '.'));
                  if (numMatch[2]?.toUpperCase() === 'K') num *= 1000;
                  if (numMatch[2]?.toUpperCase() === 'M') num *= 1000000;
                  logs.push("isLikeBtn matched text: " + text + " -> " + num);
                  if (num > 0) candidates.push(Math.floor(num));
                }
              }
            }
          }
          
          // 1.5 AGGRESSIVE: TÌM SỐ CẠNH NÚT LIKE
          if (candidates.length === 0) {
             const likeActionBtn = Array.from(document.querySelectorAll('div[role="button"], span[role="button"]'))
                .find(b => {
                   const t = b.innerText.trim().toLowerCase();
                   return (t === 'thích' || t === 'like') && !b.innerHTML.toLowerCase().includes('bình luận');
                });
             if (likeActionBtn) {
                // Nút Like nằm ở thanh công cụ. Số đếm nằm ở thẻ Div phía trên thanh công cụ.
                // Tìm tất cả các số có thể nhìn thấy nằm trên trang, lấy số gần nhất phía trên nút Like!
                const allNodes = Array.from(document.querySelectorAll('span, div[role="button"]'));
                for (let node of allNodes) {
                   const t = (node.innerText || '').trim();
                   // Chỉ lấy những node có đúng 1 con số, không chứa chữ linh tinh
                   if (/^[0-9.,]+$/.test(t)) {
                      // Kiểm tra xem node này có chứa biểu tượng cảm xúc không (hoặc nằm trong vùng biểu tượng)
                      const p = node.parentElement?.parentElement?.innerHTML.toLowerCase() || '';
                      if (p.includes('thích') || p.includes('yêu') || p.includes('love') || p.includes('cảm xúc')) {
                         let num = parseFloat(t.replace(/,/g, '.'));
                         logs.push("Aggressive DOM match: " + t);
                         candidates.push(Math.floor(num));
                      }
                   }
                }
             }
          }

          // 2. Quét aria-label chứa số reaction
          const xpath = '//*[@aria-label]';
          const nodes = document.evaluate(xpath, document, null, XPathResult.UNORDERED_NODE_SNAPSHOT_TYPE, null);
          for (let i = 0; i < nodes.snapshotLength; i++) {
            const label = nodes.snapshotItem(i).getAttribute('aria-label');
            if (label && /thích|cảm xúc|reactions|like|love|yêu|haha|wow|buồn|sad|phẫn nộ|angry|care|thương|người khác/i.test(label)) {
              const labelLower = label.toLowerCase();
              if (label === 'Thích' || label === 'Like' || label === 'Bỏ thích' || labelLower.includes('bình luận') || labelLower.includes('chia sẻ') || labelLower.includes('comment') || labelLower.includes('share')) continue;
              
              logs.push("Found label: " + label); // DUMP FOR DEBUG
              
              let cleanLabel = label.replace(/^[\\s\\u200B\\uFEFF]*(Thích|Cảm xúc|Like|Reactions|Yêu thích|Love|Yêu|Haha|Wow|Buồn|Sad|Phẫn nộ|Angry|Thương thương|Care)[\\s:]*,?[\\s]*/i, '').replace(/[\\u200B-\\u200D\\uFEFF]/g, '').trim();
              
              // Pattern 1: "A, B và X người khác"
              const vaMatch = cleanLabel.match(/(.+)\\s+và\\s+([0-9.,]+)\\s*(K|M|B)?\\s*(người khác)/i);
              if (vaMatch) {
                const prefix = vaMatch[1];
                let num = parseFloat(vaMatch[2].replace(/,/g, '.'));
                const unit = vaMatch[3];
                if (unit?.toUpperCase() === 'K') num *= 1000;
                if (unit?.toUpperCase() === 'M') num *= 1000000;
                
                const commas = (prefix.match(/,/g) || []).length;
                let finalNum = Math.floor(num + commas + 1);
                logs.push("Matched Pattern 1: " + finalNum);
                if (finalNum > 0) candidates.push(finalNum);
              } else {
                // Pattern 2: "3 cảm xúc", "1,5K lượt thích"
                const directMatch = cleanLabel.match(/([0-9.,]+)\\s*(K|M|B)?\\s*(cảm xúc|người|lượt|thích|like)/i);
                if (directMatch) {
                  let num = parseFloat(directMatch[1].replace(/,/g, '.'));
                  const unit = directMatch[2];
                  if (unit?.toUpperCase() === 'K') num *= 1000;
                  if (unit?.toUpperCase() === 'M') num *= 1000000;
                  logs.push("Matched Pattern 2: " + num);
                  if (num > 0) candidates.push(Math.floor(num));
                } else {
                  logs.push("Failed to parse cleanLabel: " + cleanLabel);
                }
              }
            }
          }

          // 3. Fallback: Regex bodyText
          const bodyText = document.body.innerText;
          if (bodyText && candidates.length === 0) {
            const m1 = bodyText.match(/([0-9.,]+)\\s*(K|M|B)?\\s*(cảm xúc|lượt thích|người khác)/i);
            if (m1) {
              let num = parseFloat(m1[1].replace(/,/g, '.'));
              if (m1[2]?.toUpperCase() === 'K') num *= 1000;
              if (m1[2]?.toUpperCase() === 'M') num *= 1000000;
              if (num > 0) candidates.push(Math.floor(num));
            }
          }
          
          if (candidates.length > 0) {
            const valid = candidates.filter(c => c > 0);
            if (valid.length > 0) {
               return { result: Math.max(...valid), logs };
            }
          }
          if (foundLikeBtn && candidates.length === 0) {
             return { result: 0, logs: ['Found like button but no numbers'] };
          }
          
          await new Promise(r => setTimeout(r, 1000));
        }
        return { result: null, logs };
      })()
    `)

    console.log('[Preview] 🔍 Reaction scan result:', result)
    return result.result
  }
}
