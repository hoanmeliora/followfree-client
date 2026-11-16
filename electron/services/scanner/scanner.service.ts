import { BrowserContext, Page } from 'playwright'
import { createHash } from 'crypto'
import { StoreService, ScannerConfig, ScrapedLead } from '../store.service'
import { Ipv6Service } from '../ipv6.service'
import { LocalProxyService } from '../local-proxy.service'

type PushEvent = (channel: string, data: unknown) => void
type ScannerAccount = ReturnType<StoreService['getAccounts']>[number]
type CreateContext = (account: ScannerAccount, proxyUrl?: string) => Promise<{ context: BrowserContext; page: Page }>

interface RawPost {
  authorName: string
  authorUrl: string
  content: string
  postUrl: string
  postTimeText?: string
}

export function parsePostAgeDays(timeStr?: string, referenceDate: Date = new Date()): number | null {
  if (!timeStr) return null
  const s = timeStr.trim().toLowerCase()

  // Vừa xong / Just now / Vừa đăng
  if (/vừa xong|vừa đăng|just now/i.test(s)) return 0

  // Phút / minutes: "15 phút", "15m", "15 mins", "15min"
  if (/(\d+)\s*(?:phút|phut|p|m|min|mins)(?:\s+trước|[^\w\u00C0-\u1EF9]|$)/i.test(s)) return 0

  // Giờ / hours: "2 giờ", "2h", "2 hrs", "2 hr"
  if (/(\d+)\s*(?:giờ|gio|tiếng|tieng|h|hr|hrs)(?:\s+trước|[^\w\u00C0-\u1EF9]|$)/i.test(s)) return 0

  // Hôm qua / Yesterday
  if (/hôm qua|yesterday/i.test(s)) return 1

  // Ngày / days: "2 ngày", "2d", "2 days", "2 ngày trước"
  const dayMatch = s.match(/(\d+)\s*(?:ngày|ngay|d|day|days)(?:\s+trước|[^\w\u00C0-\u1EF9]|$)/i)
  if (dayMatch) return parseInt(dayMatch[1], 10)

  // Tuần / weeks: "1 tuần", "1w", "1 week", "2 tuần"
  const weekMatch = s.match(/(\d+)\s*(?:tuần|tuan|w|week|weeks)(?:\s+trước|[^\w\u00C0-\u1EF9]|$)/i)
  if (weekMatch) return parseInt(weekMatch[1], 10) * 7

  // Tháng / months: "1 tháng", "1 month"
  const monthMatch = s.match(/(\d+)\s*(?:tháng|thang|month|months)\s*(?:trước|ago)?$/i)
  if (monthMatch) return parseInt(monthMatch[1], 10) * 30

  // Ngày tháng cụ thể: "24 Tháng 10 lúc 14:00" hoặc "24 tháng 10" hoặc "24 thg 10"
  const vnDateMatch = s.match(/(\d{1,2})\s+(?:tháng|thg)\s+(\d{1,2})(?:\s+năm\s+(\d{4}))?/i)
  if (vnDateMatch) {
    const day = parseInt(vnDateMatch[1], 10)
    const month = parseInt(vnDateMatch[2], 10) - 1
    const year = vnDateMatch[3] ? parseInt(vnDateMatch[3], 10) : referenceDate.getFullYear()
    const postDate = new Date(year, month, day)
    const diffMs = referenceDate.getTime() - postDate.getTime()
    return Math.max(0, Math.floor(diffMs / (24 * 60 * 60 * 1000)))
  }

  return null
}

const MIN_INTERVAL_MINUTES = 5
const MAX_GROUPS = 50
const TARGET_POSTS_PER_GROUP = 150
const MAX_SCROLL_ROUNDS = 30
const STALLED_ROUNDS_LIMIT = 2
const BUSY_RETRY_MS = 60 * 1000
const GROUP_URL_PATTERN = /^https:\/\/(www|m|web)\.facebook\.com\/groups\/[\w.-]+/i
const NUMERIC_OR_SLUG_PATTERN = /^[\w.-]+$/

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))
const randomBetween = (min: number, max: number): number => min + Math.floor(Math.random() * (max - min))

/** Lowercase and strip Vietnamese diacritics so "tìm việc" matches "tim viec". */
export function normalizeText(text: string): string {
  return text
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/đ/g, 'd')
    .replace(/Đ/g, 'd')
    .replace(/\s+/g, ' ')
    .toLowerCase()
    .trim()
}

/**
 * Chuẩn hoá tiếng lóng, viết tắt, teencode và lỗi gõ phổ biến của người tìm việc trên MXH:
 * - "vc" -> "viec" (khi đi kèm tim, can, xin, kiem, lam, co...)
 * - "timm", "tìn" -> "tim"
 * - "vjec", "vjek", "viecc", "viẹc", "việt" (trong tim viet, can viet...) -> "viec"
 * - "ng" -> "nguoi" (trong can ng, nhan ng, thieu ng...)
 * - "partime", "pat time" -> "part time"
 * - "k", "ko", "kh" -> "khong"
 */
export function normalizeTeencode(norm: string): string {
  return norm
    .replace(/\b(t|c|s|l|k|d|m|p|n)i+m+\b/g, '$1im')
    .replace(/\bvie+c+\b/g, 'viec')
    .replace(/\bvje+[ck]+\b/g, 'viec')
    .replace(/\b(tim|can|xin|kiem|lam|co|muon)\s+viet\b/g, '$1 viec')
    .replace(/\b(tim|can|xin|kiem|lam|co|muon|cong)\s+vc\b/g, '$1 viec')
    .replace(/\bvc\s+(lam|ban\s*hang|part\s*time|ca\s*toi|phuc\s*vu)\b/g, 'viec $1')
    .replace(/\b(can|nhan|thieu|tuyen|tim)\s+ng\b/g, '$1 nguoi')
    .replace(/\b(cog|coq)\s+(viec|vc)\b/g, 'cong viec')
    .replace(/\b(ban|giao)\s+(hag|hanq|hg)\b/g, '$1 hang')
    .replace(/\b(?:partime|pattime|pat\s*time|part-time)\b/g, 'part time')
    .replace(/\b(?:fulltime|fultime|ful\s*time|full-time)\b/g, 'full time')
    .replace(/\b(?:bit|pit|piet)\b/g, 'biet')
    .replace(/\bch[oô]\s*l[aà]o\b/g, 'cho nao')
}

export const DEFAULT_BUYER_INTENT_KEYWORDS: string[] = [
  'cần mua', 'tìm mua', 'cần tìm', 'tìm', 'mua', 'xin giá', 'báo giá',
  'ai có', 'ai bán', 'bác nào có', 'bác nào bán', 'em cần', 'mình cần',
  'pass lại', 'tư vấn giúp', 'cho em hỏi', 'còn không', 'inbox mình',
  'ib mình', 'giá sao', 'bao nhiêu ạ', 'hỏi mua', 'muốn mua', 'cần thuê', 'tìm phòng', 'tìm xe'
]

export const DEFAULT_EXCLUDE_KEYWORDS: string[] = [
  'xả kho', 'sẵn hàng', 'tuyển sỉ', 'tuyển ctv', 'tuyển cộng tác viên',
  'bảng giá', 'free ship', 'freeship', 'ship cod', 'bảo hành', 'chính sách',
  'combo', 'new seal', 'tài xỉu', 'cờ bạc', 'vay vốn',
  'hoa hồng', 'kiếm tiền online', 'kiếm tiền tại nhà', 'tuyển dụng',
  'tuyển gấp', 'lcb', 'lương cơ bản', 'phụ cấp', 'quyền lợi',
  'lắp mạng', 'lắp wifi', 'fpt', 'viettel', 'vnpt', 'lắp camera', 'cáp quang', 'sim 4g',
  'mỗi mẫu', 'mẫu', 'thanh lý', 'thanh lí', 'trả góp', 'góp', 'giá rẻ', 'sale rẻ', 'siêu rẻ',
  'giá để trong ảnh', 'miễn phí vận chuyển', 'lắp đặt tận nhà',
  'liệt sĩ', 'mộ liệt sĩ', 'rơi giấy tờ', 'nhặt được cccd', 'tai nạn', 'từ thiện'
]

export const SPAM_SELLER_PATTERNS = [
  /(?:hotline|zalo|sđt|sdt|liên hệ|lh|call|phone)\s*[:.-]?\s*(?:0|\+84)[3|5|7|8|9](?:[0-9][.-]?\s*){7,9}\b/i,
  /(?:stk|số tài khoản|ngân hàng|mb bank|vietcombank|techcombank|vietinbank)\s*[:.-]?\s*\d{6,15}/i,
  /(?:địa chỉ shop|địa chỉ kho|showroom|store)\s*[:.-]/i,
  /(?:shopee\.vn|lazada\.vn|tiktok\.com|tiki\.vn)\/[\w./?=&#%-]+/i,
  /#(?:sale|xakho|hangchinhhang|giare|order|shipcod)\b/i,
]

/** Các mẫu bài viết bán hàng, thanh lý, thương mại của Shop / Cá nhân */
export const HARD_SELLER_PATTERNS = [
  // Các từ khóa bán hàng: Mỗi mẫu, sale rẻ, thanh lý, trả góp, giá...
  /\b(?:moi\s*mau|moi\s*loai|moi\s*size|moi\s*mau\s*e\s*con|con\s*\d+c\b|con\s*\d+\s*cai|con\s*it\s*mau)\b/,
  /\b(?:sale\s*re|gia\s*re|sieu\s*re|re\s*nhat|re\s*nhu\s*cho|re\s*beo|re\s*cho\s*bac\s*nao\s*can)\b/,
  /\b(?:thanh\s*ly|thanh\s*li|xa\s*thanh\s*ly|thanh\s*ly\s*gap|thanh\s*ly\s*nhanh|thanh\s*ly\s*re)\b/,
  /\b(?:tra\s*gop|ho\s*tro\s*tra\s*gop|gop\s*0%|ban\s*tra\s*gop|gop\s*qua\s*cccd|lai\s*suat\s*0%|gop\s*ngay|mua\s*gop)\b/,
  /\b(?:gia\s*e\s*de|gia\s*trong\s*anh|gia\s*de\s*trong\s*anh|gia\s*cong\s*khai|gia\s*mem|gia\s*tot|bao\s*gia|ha\s*gia|giam\s*gia)\b/,
  /\b(?:mien\s*phi\s*van\s*chuyen|lap\s*dat\s*tan\s*nha|giao\s*hang\s*tan\s*nha|van\s*chuyen\s*tan\s*nha)\b/,
  /\b(?:tu\s*quan\s*ao|ban\s*ghe|tu\s*bep|ke\s*tivi|sofa|giuong\s*ngu)\b/,
  // Dịch vụ sửa chữa, công trình, thông tắc cống, hút bể phốt, điện nước
  /\b(?:thong\s*tac|hut\s*be\s*phot|bon\s*cau|ong\s*thoat\s*nuoc|sua\s*chua\s*dien\s*nuoc|chong\s*tham|khoan\s*cat\s*be\s*tong|ve\s*sinh\s*moi\s*truong|sua\s*dieu\s*hoa|nap\s*gas\s*dieu\s*hoa|sua\s*may\s*giat)\b/,
  /\b(?:khao\s*sat\s*mien\s*phi|bao\s*gia\s*ro\s*rang|thi\s*cong\s*nhanh)\b/,
  // Dịch vụ nhà mạng, viễn thông, lắp wifi / internet / camera / sim data
  /\b(?:lap\s*mang|lap\s*dat\s*mang|lap\s*wifi|lap\s*dat\s*wifi|lap\s*internet|lap\s*camera|lap\s*dat\s*camera)\b/,
  /\b(?:dang\s*k[yi]\s*lap\s*mang|dang\s*k[yi]\s*wifi|dang\s*k[yi]\s*mang)\b/,
  /\b(?:fpt|viettel|vnpt|vinaphone|mobifone)\s*(?:telecom|wifi|internet|mang|fiber)\b/,
  /\b(?:wifi\s*fpt|mang\s*fpt|wifi\s*viettel|mang\s*viettel|wifi\s*vnpt|mang\s*vnpt)\b/,
  /\b(?:cap\s*quang|cuoc\s*mang|goi\s*cuoc\s*mang|goi\s*cuoc\s*internet|router\s*wifi|modem\s*wifi)\b/,
  /\b(?:sim\s*4g|sim\s*5g|sim\s*so\s*dep|sim\s*data|dang\s*ky\s*4g|dang\s*ky\s*5g)\b/,
  // Miễn phí ship, freeship, ship cod, giao hàng tận nơi
  /\b(?:mien\s*phi\s*ship|free\s*ship|freeship|ship\s*cod|ship\s*toan\s*quoc|dong\s*kiem|ship\s*tan\s*noi|giao\s*tan\s*noi)\b/,
  // Bán điện thoại, máy tính, xe cộ, đồ công nghệ
  /\b(?:mua\s*ban|trao\s*doi|sua\s*chua)\s*(?:dien\s*thoai|xe\s*may|o\s*to|laptop|may\s*tinh)\b/,
  /\b(?:zin\s*all|net\s*keng|pin\s*zin|khong\s*spa|bao\s*check\s*test|bao\s*test|bao\s*hanh\s*\d+\s*(?:thang|ngay)|chinh\s*hang|nguyen\s*seal)\b/,
  /\b(?:pro\s*max|iphone|galaxy\s*s\d+|macbook|ipad|airpods)\b/,
  // Bán xe cộ, xe máy, ô tô
  /\b(?:chinh\s*chu\s*can\s*ban|xe\s*chinh\s*chu|bien\s*so|may\s*em|giay\s*to\s*day\s*du|odo\s*\d+)\b/,
  // Báo giá bán hàng, xả hàng, giảm giá, thanh lý
  /\b(?:gia\s*de\s*tiep\s*can|chi\s*\d+[.x]+|chi\s*\d+k|gia\s*yeu\s*thuong|gia\s*chi\s*\d+|gia\s*hat\s*de|gia\s*cong\s*khai)\b/,
  /\b\d+k\s+(?:mien\s*phi\s*ship|free\s*ship|freeship|ship)\b/,
  /\b(?:xa\s*kho|san\s*hang|chuyen\s*si|si\s*le|gia\s*si|gia\s*le|thanh\s*ly\s*gia\s*re|gia\s*sale|sale\s*\d+%|dong\s*gia\s*\d+k?)\b/,
  /\b(?:pass\s*lai|pass\s*nhanh|thanh\s*ly\s*nhanh)\b/,
  // Bán chăn ga, đệm, đồ gia dụng, nội thất
  /\b(?:chan\s*ga|ruot\s*bong|chan\s*long|nem|chieu\s*dieu\s*hoa|chan\s*coco)\b/,
  /\b(?:thanh\s*ly\s*ban|thanh\s*ly\s*ghe|thanh\s*ly\s*tu|thanh\s*ly\s*ke)\b/,
  // Bất động sản, cho thuê nhà, chung cư, phòng trọ, đất nền
  /\b(?:quy\s*can|cho\s*thue\s*sun|can\s*ho|chung\s*cu|phong\s*ngu|full\s*do|nguyen\s*ban|gia\s*tung\s*can)\b/,
  /\b(?:cho\s*thue\s*nha|cho\s*thue\s*phong|phong\s*tro|nha\s*tro|tim\s*phong\s*tro|o\s*ghep)\b/,
  /\b(?:bat\s*dong\s*san|bds|dat\s*nen|so\s*do|so\s*hong|chinh\s*chu\s*gui\s*ban)\b/,
  // Thời trang, mỹ phẩm, ăn uống, bánh ngọt
  /\b(?:freesize|free\s*size|bang\s*size|du\s*size|chat\s*vai|chuyen\s*order)\b/,
  /\b(?:an\s*vat|menu|com\s*hop|tra\s*sua|dat\s*mon|ship\s*do\s*an|tiem\s*banh|bakery|banh\s*sinh\s*nhat|dat\s*banh|banh\s*kem|banh\s*ngot|banh\s*xinh|lich\s*tiec|inbox\s*de\s*dat)\b/,
  // Số điện thoại bán hàng có dấu chấm (0363.182.999 // 0335.105.745)
  /(?:0|\+84)[3|5|7|8|9]\d{1,2}[.-]\d{3}[.-]\d{3,4}/,
]

/** Các bài viết tin tức xã hội, tìm người thân/liệt sĩ, rơi đồ, tai nạn, từ thiện không liên quan đến tìm việc */
export const COMMUNITY_NON_JOB_PATTERNS = [
  // Liệt sĩ, tâm linh, tìm mộ, hài cốt
  /\b(?:liet\s*si|ls\s*que|hai\s*cot|mo\s*liet\s*si|nghia\s*trang|hy\s*sinh|tu\s*si|cau\s*sieu|phong\s*sinh|niem\s*phat|kinh\s*phat)\b/,
  // Rơi đồ, nhặt được giấy tờ, CCCD
  /\b(?:nhat\s*duoc|roi\s*giay\s*to|roi\s*vi|nhat\s*duoc\s*vi|nhat\s*duoc\s*cccd|roi\s*cccd|tim\s*giay\s*to|tim\s*do\s*that\s*lac|tim\s*cho|tim\s*meo)\b/,
  // Tai nạn, chia buồn, đám tang
  /\b(?:tai\s*nan|tngt|va\s*cham\s*giao\s*thong|cap\s*cuu|tu\s*vong|qua\s*doi|chia\s*buon|xin\s*chia\s*buon|dam\s*tang|vinh\s*biet|an\s*nghi)\b/,
  // Từ thiện, cứu trợ, hoàn cảnh khó khăn
  /\b(?:quyen\s*gop|tu\s*thien|ung\s*ho|hoan\s*canh\s*kho\s*khan|la\s*lanh\s*dum\s*la\s*rach|keu\s*goi\s*ung\s*ho|manh\s*thuong\s*quan)\b/,
  // Cảnh báo lừa đảo, bóc phốt
  /\b(?:canh\s*bao\s*lua\s*dao|boc\s*phot|phot\s*lua\s*dao|can\s*than\s*bi\s*lua|tra\s*no|doi\s*no)\b/,
]

/** Dấu hiệu đặc trưng cho thấy bài viết của ỨNG VIÊN đang tìm việc thật sự */
export const CANDIDATE_SEEKING_PATTERNS = [
  /\b(?:tim\s*viec|xin\s*viec|can\s*viec|kiem\s*viec|muon\s*tim\s*viec|can\s*tim\s*viec|dang\s*can\s*viec|dang\s*tim\s*viec)\b/,
  /\b(?:tim\s*vc|xin\s*vc|can\s*vc|kiem\s*vc|tim\s*job|xin\s*job|can\s*job|kiem\s*job)\b/,
  /\b(?:xin\s*di\s*lam|muon\s*di\s*lam|can\s*di\s*lam|di\s*lam\s*ngay|di\s*lam\s*luon|di\s*lam\s*lien|co\s*the\s*di\s*lam)\b/,
  /\b(?:em\s*sinh\s*vien|minh\s*sinh\s*vien|chau\s*sinh\s*vien|em\s*sv|chau\s*sv|minh\s*sv)\b/,
  /\b(?:em|minh|toi|chau|e)\s*(?:sinh\s*nam|sn)\s*(?:19\d{2}|20\d{2}|[89]\d|2k\d?)\b/,
  /\b(?:sn|sinh\s*nam)\s*(?:19\d{2}|20\d{2}|[89]\d|2k\d?).*(?:tim|can|xin|muon|viec|di\s*lam)\b/,
  /\b(?:em|minh|chau|e|nam|nu)\s*\d{1,2}\s*tuoi.*(?:tim|can|xin|muon|viec|di\s*lam)\b/,
  /\b(?:ai\s*co\s*viec|ai\s*biet\s*(?:cho|o\s*dau)|co\s*cho\s*nao|co\s*ai\s*nhan)\b/,
  /\b(?:can\s*viec|tim\s*viec|xin\s*viec)\s+(?:gap|nhanh|ngay|luon)\b/,
]

export const RECRUITER_AUTHOR_PATTERN =
  /^(?:hr\b|tuyen\s*dung|nhan\s*su|viec\s*lam|cty\b|cong\s*ty\b)|\b(?:hr|job|hdjob|tuyen\s*dung|nhan\s*su|viec\s*lam|recruiter|headhunter|agency)\b/i

/** Chạy trên chuỗi đã chuẩn hoá không dấu (normContent) để tránh lỗi ranh giới từ \b với dấu tiếng Việt */
export const RECRUITER_NORMALIZED_PATTERNS = [
  /\btuyen\s*dung\b/,
  /\btuyen\s*gap\b/,
  /\blcb\b/,
  /\bpvtt\b/,
  /(?<!ai\s)(?<!nao\s)(?<!dang\s)(?<!can\s)\btuyen\s+(?:gap|them|moi|lien\s*tuc|so\s*luong|cong\s*nhan|nhan\s*vien|lao\s*dong|ldpt|nam|nu|tho|bao\s*ve|tap\s*vu|tai\s*xe|lai\s*xe|phuc\s*vu|phu\s*bep|ban\s*hang|thu\s*ngan|kho|dong\s*goi|lap\s*rap|ky\s*thuat|ke\s*toan|sale|tu\s*van|cong\s*tac\s*vien|ctv|si)\b/,
  /\b(?:luong\s*(?:&|va)\s*phu\s*cap|luong\s*co\s*ban|tong\s*phu\s*cap|tro\s*cap\s*ky\s*thuat|tong\s*thu\s*nhap)\b|\b(?:phu\s*cap|muc\s*luong|thu\s*nhap)(?:\s*[:.-]|\b)/,
  /\b(?:mo\s*ta\s*cong\s*viec|yeu\s*cau\s*(?:cong\s*viec|ung\s*vien)|nop\s*ho\s*so)\b|\b(?:quyen\s*loi|ho\s*so\s*(?:bao\s*gom|gom))(?:\s*[:.-]|\b)/,
  /\b(?:chuyen\s*can|tham\s*nien|an\s*ca\s*mien\s*phi|ho\s*tro\s*an\s*ca|dao\s*tao\s*khi\s*nhan\s*viec|phong\s*van\s*truc\s*tiep|ung\s*tuyen\s*ngay)\b/,
  /\b(?:co\.?\s*ltd|cong\s*ty\s*tnhh|cong\s*ty\s*co\s*phan|(?:mo|tao)\s*co\s*hoi\s*cho\s*ung\s*vien)\b/,
]

const RECRUITING_PHRASE_PATTERN = /\b(?:can|dang)\s+tuyen\b/
const SALARY_OR_BENEFIT_PATTERNS = [
  /\b(?:quyen\s*loi|phu\s*cap|tro\s*cap|luong|thu\s*nhap|hoa\s*hong|che\s*do|thuong)\b/,
  /\b\d{1,3}(?:[.,]\d{3})+(?:\s*(?:d|vnd))?\b/,
  /\b\d+(?:[.,-]\d+)?\s*(?:tr|trieu|k|nghin|ngan|cu|m)\b/,
]

export interface EvaluationResult {
  matched: boolean
  matchedKeywords: string[]
  rejectReason?: string
}

/**
 * Nhận diện câu hỏi tìm việc của người lao động:
 * - "Có cty nào tuyển nữ không ạ"
 * - "Tuyển nam có cty nào thời vụ không mn"
 * - "Có cty nào thời vụ không ạ"
 * - "Cho e hỏi ở đây có cty nào tuyển..."
 * - "Quanh KCN Đồng Văn có cty nào tuyển ko"
 */
export const CANDIDATE_INQUIRY_PATTERN =
  /\b(?:co\s+(?:cty|cong\s*ty|cho|quan|xuong|noi|kcn)\s+(?:nao\s+)?(?:dang\s+)?(?:tuyen|nhan|thoi\s*vu|can\s*nguoi)|(?:ai\s*biet|cho\s*e\s*hoi|cho\s*em\s*hoi|mn\s*cho\s*e\s*hoi)\s+(?:o\s*dau|cho\s*nao|cty\s*nao|cong\s*ty\s*nao)?.*(?:tuyen|nhan|thoi\s*vu|can\s*nguoi)|(?:quanh|o)\s+(?:day|khu\s*vuc|kcn|dong\s*van|ha\s*nam)\s+co\s+(?:cty|cong\s*ty|cho|xuong).*(?:tuyen|nhan)|co\s+viec\s+gi\s+(?:lam|cho|thoi\s*vu)|ai\s+tuyen\s+(?:gi|nam|nu|thoi\s*vu|ldpt)\s+(?:khong|ko|\?))\b/i

/**
 * Tự động nhận diện bản tin tuyển dụng dài có cấu trúc (Structured Recruiter JD).
 * Thường dài >= 250 ký tự và có từ 2 mục trở lên: Địa điểm:, Công việc:, Thu nhập:, Yêu cầu:, Quyền lợi:, Liên hệ:...
 */
export function isStructuredRecruiterJD(content: string): boolean {
  if (content.length < 250) return false
  const norm = normalizeText(content)
  const sections = [
    /\b(?:dia\s*diem|khu\s*vuc|dia\s*chi)\s*[:.-]/,
    /\b(?:cong\s*viec|mo\s*ta)\s*[:.-]/,
    /\b(?:thu\s*nhap|muc\s*luong|luong)\s*[:.-]/,
    /\b(?:yeu\s*cau|ho\s*so)\s*[:.-]/,
    /\b(?:quyen\s*loi|che\s*do)\s*[:.-]/,
    /\b(?:lien\s*he|ung\s*tuyen|sdt|zalo|hotline)\s*[:.-]/,
    /\b(?:thoi\s*gian|lich\s*(?:nghi|lam))\s*[:.-]/,
  ]
  let hitCount = 0
  for (const sec of sections) {
    if (sec.test(norm)) hitCount++
  }
  return hitCount >= 2
}

/** Làm sạch text bài viết (bỏ rác tên tác giả, tên nhóm, nút bấm Thích/Bình luận của Facebook) để đếm số từ chuẩn xác */
export function getCleanPostWords(text: string, authorName = '', groupName = ''): string[] {
  let clean = text
  if (authorName && authorName.length > 2) {
    clean = clean.split(authorName).join(' ')
  }
  if (groupName && groupName.length > 2) {
    clean = clean.split(groupName).join(' ')
  }

  // Loại bỏ các từ rác giao diện Facebook và mốc thời gian an toàn với Unicode tiếng Việt
  const junkWords = [
    'thích', 'bình luận', 'chia sẻ', 'chia', 'sẻ', 'like', 'comment', 'share',
    'gửi', 'send', 'xem thêm', 'see more', 'ẩn bớt', 'xem bản dịch', 'phù hợp nhất',
    'tất cả bình luận', 'người đóng góp nhiều nhất', 'quản trị viên', 'tác giả',
    'thành viên nhóm', 'công khai', 'vừa xong', 'hôm qua', 'just now', 'yesterday',
    'phút', 'giờ', 'tiếng', 'ngày', 'tháng', 'tuần', 'năm', 'trước', 'ago', 'facebook'
  ]

  for (const w of junkWords) {
    const escaped = w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    clean = clean.replace(new RegExp(`(^|\\s|[.,!?;:()\\/\\-\\[\\]{}"'\`“”])${escaped}($|\\s|[.,!?;:()\\/\\-\\[\\]{}"'\`“”])`, 'gi'), ' ')
  }

  return clean.trim().split(/\s+/).filter((w) => w.length > 0 && !/^[\p{P}\p{S}\d]+$/u.test(w))
}

export function evaluatePostMatch(
  content: string,
  config: Pick<ScannerConfig, 'keywords' | 'intentKeywords' | 'excludeKeywords' | 'autoFilterSpam' | 'maxPostLength'>,
  authorName?: string,
  groupName?: string
): EvaluationResult {
  // Loại bỏ tên nhóm khỏi nội dung để tên nhóm (VD: "Việc Làm Hà Nam - Tìm Việc Hà Nam")
  // không tự động biến bài viết rỗng thành bài viết khớp từ khóa "tìm việc" / "việc làm"!
  let effectiveContent = content
  if (groupName && groupName.length > 2) {
    effectiveContent = effectiveContent.split(groupName).join(' ')
  }

  const normContent = normalizeText(effectiveContent)
  const teencodeContent = normalizeTeencode(normContent)
  if (!normContent || normContent.length < 5) {
    return {
      matched: false,
      matchedKeywords: [],
      rejectReason: 'Bài viết không có nội dung chữ thực tế (rỗng hoặc chỉ có ảnh/banner quảng cáo)',
    }
  }

  // 1. Kiểm tra từ khóa LOẠI TRỪ (Exclude / Blacklist)
  const excludeList = config.excludeKeywords ?? []
  for (const exKw of excludeList) {
    const normEx = normalizeText(exKw.trim())
    if (normEx.length > 0 && (normContent.includes(normEx) || teencodeContent.includes(normEx))) {
      return {
        matched: false,
        matchedKeywords: [],
        rejectReason: `Trúng từ khóa loại trừ: "${exKw}"`,
      }
    }
  }

  // Nhận diện nếu bài là câu hỏi tìm việc của ứng viên (VD: "Có cty nào tuyển nữ ko", "Tuyển nam có cty nào thời vụ ko")
  const isCandidateInquiryMatch =
    CANDIDATE_INQUIRY_PATTERN.test(normContent) || CANDIDATE_INQUIRY_PATTERN.test(teencodeContent)

  // Nhận diện nếu bài có dấu hiệu rõ ràng của ứng viên đang tìm việc (hỗ trợ cả teencode, viết tắt, ngữ nghĩa tự nhiên)
  const isCandidateSeeking =
    isCandidateInquiryMatch ||
    CANDIDATE_SEEKING_PATTERNS.some((p) => p.test(normContent) || p.test(teencodeContent)) ||
    CANDIDATE_INTENT_PATTERNS.some((p) => p.test(normContent) || p.test(teencodeContent))

  // 2. Kiểm tra bộ nhận diện bài viết bán hàng của Shop & bài đăng Tuyển dụng của HR/Công ty
  if (config.autoFilterSpam !== false) {
    if (authorName && RECRUITER_AUTHOR_PATTERN.test(normalizeText(authorName))) {
      return {
        matched: false,
        matchedKeywords: [],
        rejectReason: `Phát hiện tài khoản nhà tuyển dụng/HR ("${authorName}")`,
      }
    }

    // Tự động lọc các bài viết quá dài (quy tắc: bản tin tuyển dụng dài của HR/đối thủ)
    const cleanWords = getCleanPostWords(content, authorName, groupName)
    const maxWords = (config.maxPostLength && config.maxPostLength > 0) ? config.maxPostLength : 100
    const lengthLimit = isCandidateSeeking ? Math.max(maxWords, 150) : maxWords
    if (cleanWords.length > lengthLimit) {
      return {
        matched: false,
        matchedKeywords: [],
        rejectReason: `Bài viết nhiều hơn ${lengthLimit} từ (${cleanWords.length} từ - bản tin tuyển dụng của HR/đối thủ)`,
      }
    }

    // Tự động chặn các bài viết KHÔNG CÓ NỘI DUNG hoặc chỉ có ảnh / chữ quá cụt ngủn (< 2 từ)
    if (cleanWords.length < 2 && !isCandidateSeeking) {
      return {
        matched: false,
        matchedKeywords: [],
        rejectReason: `Bài viết không có nội dung thực tế (${cleanWords.length} từ - chỉ có ảnh/tờ rơi quảng cáo)`,
      }
    }

    // Nếu bài viết chứa nút "Xem thêm" / "See more" / "Ẩn bớt" và nội dung dài (> 50 từ)
    const hasSeeMore =
      /\b(?:xem\s*them|see\s*more|an\s*bot)\b/i.test(normContent) ||
      /\b(?:xem\s*thêm|ẩn\s*bớt)\b/i.test(content) ||
      /[.…]\s*(?:xem\s*thêm|see\s*more)/i.test(content)

    if (hasSeeMore && !isCandidateSeeking && cleanWords.length > 50) {
      return {
        matched: false,
        matchedKeywords: [],
        rejectReason: 'Bài viết dài bị cắt ngắn bởi nút "Xem thêm" (Bản tin tuyển dụng/bán hàng dài của HR)',
      }
    }

    // Tự động nhận diện bản tin tuyển dụng dài có cấu trúc (Địa điểm, Thu nhập, Công việc, Yêu cầu...)
    if (isStructuredRecruiterJD(content)) {
      return {
        matched: false,
        matchedKeywords: [],
        rejectReason: `Phát hiện bài viết dài có cấu trúc bản tin tuyển dụng/JD của HR (${content.length} ký tự)`,
      }
    }

    // Kiểm tra các mẫu CHẮC CHẮN LÀ NHÀ TUYỂN DỤNG (Cần tìm CTV, Ứng tuyển ngay, lương ngày/ca...)
    // Ngoại lệ: Nếu là câu hỏi của ứng viên hỏi có ai tuyển không ("Có cty nào tuyển nữ không", "Tuyển nam có cty nào ko")
    // thì KHÔNG chặn vì đây là người đi tìm việc thật.
    if (!isCandidateInquiryMatch) {
      for (const pattern of HARD_RECRUITER_PATTERNS) {
        if (pattern.test(normContent) || pattern.test(teencodeContent)) {
          return {
            matched: false,
            matchedKeywords: [],
            rejectReason: 'Phát hiện bài đăng của Nhà tuyển dụng/Đối thủ (Cần tìm CTV/Nhân viên/Lương ngày/Ứng tuyển)',
          }
        }
      }
    }

    // Bài bán hàng của shop:
    // Nếu ứng viên đang tìm việc để lại Zalo/SĐT để liên hệ, không chặn nhầm họ.
    // Nhưng nếu có STK, link Shopee/Lazada, địa chỉ showroom/kho thì vẫn chặn bình thường.
    for (let i = 0; i < SPAM_SELLER_PATTERNS.length; i++) {
      const pattern = SPAM_SELLER_PATTERNS[i]
      if (i === 0 && isCandidateSeeking) {
        continue // Không chặn SĐT/Zalo của người tìm việc
      }
      if (pattern.test(content)) {
        return {
          matched: false,
          matchedKeywords: [],
          rejectReason: 'Phát hiện bài bán hàng/quảng cáo của shop (Hotline/STK/Link sàn TMĐT)',
        }
      }
    }

    // Chặn các bài viết bán hàng, thanh lý, thương mại của shop/cá nhân
    if (!isCandidateSeeking) {
      for (const pattern of HARD_SELLER_PATTERNS) {
        if (pattern.test(normContent) || pattern.test(teencodeContent)) {
          return {
            matched: false,
            matchedKeywords: [],
            rejectReason: 'Phát hiện bài bán hàng/quảng cáo sản phẩm của shop (Freeship/Điện thoại/Chăn ga/Giá bán)',
          }
        }
      }
    }

    // Chặn các bài viết tin tức xã hội, liệt sĩ, rơi giấy tờ, tai nạn, từ thiện
    for (const pattern of COMMUNITY_NON_JOB_PATTERNS) {
      if (pattern.test(normContent) || pattern.test(teencodeContent)) {
        return {
          matched: false,
          matchedKeywords: [],
          rejectReason: 'Phát hiện bài viết tin tức xã hội/liệt sĩ/rơi giấy tờ/tai nạn không liên quan đến tìm việc',
        }
      }
    }

    for (const pattern of RECRUITER_NORMALIZED_PATTERNS) {
      if (pattern.test(normContent)) {
        // Ngoại lệ: Nếu là bài ứng viên hỏi việc (VD: "Ai biết ở đâu tuyển...", "Có chỗ nào tuyển...")
        // và KHÔNG có cấu trúc tuyển dụng của HR (LCB, lương cơ bản, phụ cấp, quyền lợi, công ty TNHH)
        if (
          isCandidateSeeking &&
          !/\b(?:lcb|luong\s*co\s*ban|tong\s*phu\s*cap|tong\s*thu\s*nhap|cong\s*ty\s*tnhh|co\.?\s*ltd)\b|\b(?:quyen\s*loi|phu\s*cap|muc\s*luong)(?:\s*[:.-]|\b)/.test(normContent)
        ) {
          continue
        }
        return {
          matched: false,
          matchedKeywords: [],
          rejectReason: 'Phát hiện bài đăng tuyển dụng của HR/Công ty (LCB/Tuyển gấp/Phụ cấp/Quyền lợi)',
        }
      }
    }

    if (
      RECRUITING_PHRASE_PATTERN.test(normContent) &&
      SALARY_OR_BENEFIT_PATTERNS.some((p) => p.test(normContent))
    ) {
      if (
        !isCandidateSeeking ||
        /\b(?:cong\s*ty|tuyen\s*dung|co\s*hoi\s*cho\s*ung\s*vien)\b/.test(normContent)
      ) {
        return {
          matched: false,
          matchedKeywords: [],
          rejectReason: 'Phát hiện bài có "đang tuyển/cần tuyển" kèm quyền lợi hoặc số tiền',
        }
      }
    }
  }

  // 3. Kiểm tra từ khóa quét bài viết (Keywords) - BẮT BUỘC PHẢI KHỚP TỪ KHÓA CỦA BẠN!
  const targetMatched = findMatchedKeywords(effectiveContent, config.keywords)
  if (targetMatched.length === 0) {
    return {
      matched: false,
      matchedKeywords: [],
      rejectReason: 'Không trùng bất kỳ từ khóa nào trong danh sách bạn đã cài đặt',
    }
  }

  // 4. Nếu bạn đang ở chế độ tìm việc (cài từ khóa tìm việc/xin việc/có việc/có vc/có cty/em tìm...),
  // thì ngoài việc trùng từ khóa, BẮT BUỘC bài viết phải có ý định của ứng viên đi tìm việc thật sự!
  const isJobSeekingMode = (config.keywords || []).some((k) => {
    const nk = normalizeText(k)
    return nk.includes('tim viec') || nk.includes('xin viec') || nk.includes('can viec') || nk.includes('viec lam') || nk.includes('tim job') || nk.includes('co viec') || nk.includes('co vc') || nk.includes('co cty') || nk.includes('em tim')
  })

  if (isJobSeekingMode && !isCandidateSeeking) {
    return {
      matched: false,
      matchedKeywords: [],
      rejectReason: 'Không phát hiện ý định tìm việc của ứng viên (không khớp từ ngữ công nhân/người tìm việc)',
    }
  }

  return {
    matched: true,
    matchedKeywords: targetMatched,
  }
}

/** Các dấu hiệu CHẮC CHẮN 100% LÀ NHÀ TUYỂN DỤNG / ĐỐI THỦ */
export const HARD_RECRUITER_PATTERNS = [
  /\b(?:team\s*minh|ben\s*minh|cty|cong\s*ty)\s*(?:dang|can)?\s*tim\b/,
  /(?<!ai\s)(?<!em\s)(?<!minh\s)\b(?:dang|can)\s*tim\s+(?:ctv|cong\s*tac\s*vien|nhan\s*su|nhan\s*vien|cong\s*nhan|nguoi\s*lam|tho|tai\s*xe|ung\s*vien)\b/,
  /(?<!ai\s)(?<!nao\s)(?<!dang\s)(?<!can\s)(?<!o\s)(?<!quan\s)(?<!cho\s)\btuyen\s+(?:gap|ctv|cong\s*tac\s*vien|nhan\s*vien|cong\s*nhan|nguoi\s*lam|tho|tai\s*xe|so\s*luong|nam|nu|ldpt|lao\s*dong|thoi\s*vu)\b/,
  /\b(?:store|shop|kho|xuong|quan|nha\s*hang|cty|cong\s*ty|ben\s*minh|team\s*minh)\s*(?:can|dang|lien\s*tuc)?\s*tuyen\b/,
  /\b(?:can|dang|lien\s*tuc)?\s*tuyen\s+(?:gap|nhan\s*vien|cong\s*nhan|ctv|nam|nu|ca\s*doi|ldpt|tho|lai\s*xe|tai\s*xe|phu\s*xe|dong\s*goi|boc\s*xep|tap\s*vu|phuc\s*vu|ban\s*hang)\b/,
  /\btuyen\s+ca\s+doi\b/,
  /\bkhong\s+nhan\s+(?:part\s*time|thoi\s*vu|sinh\s*vien|hoc\s*sinh)\b/,
  /\b(?:ho\s*tro\s*an\s*o\s*mien\s*phi|ho\s*tro\s*tien\s*xe|ve\s*sinh\s*khep\s*kin|co\s*phong\s*rieng|day\s*du\s*tien\s*nghi)\b/,
  /\b(?:dong\s*goi|boc\s*xep|phu\s*xe|tai\s*xe|phuc\s*vu|tap\s*vu)\s*[:.-]?\s*\d+\s*(?:-\s*\d+)?\s*(?:trieu|tr|k|m)\b/,
  /\blay\s+luong\s+theo\s+tuan\b/,
  /\btuyen\s*dung\b|\btuyen\s*gap\b|\blcb\b|\bpvtt\b|\bung\s*tuyen\s*ngay\b|\blien\s*he\s*ung\s*tuyen\b/,
  // Chặn tuyệt đối các bài đăng báo giá/định mức thù lao tuyển dụng: LCB, số tiền/giờ, số tiền/ngày, số tiền/ca, số tiền/tháng...
  // Ví dụ: lcb 5.500.000, 300.000 / ngày, 35k/1h, 35k/h, 420k/11h, 10 - 13 triệu/tháng, 303k/8,67h
  /\b(?:lcb|luong\s*co\s*ban|luong\s*cung)\b/,
  /\b\d{1,3}(?:[.,]\d{3})*(?:\s*k|\s*tr|\s*trieu)?\s*(?:d|vnd|dong)?\s*(?:-\s*\d+\s*(?:k|tr|trieu)?\s*)?\/\s*(?:\d+(?:[.,]\d+)?\s*)?(?:ngay|ca|thang|gio|buoi|h|tieng)\b/,
  /\b(?:muc\s*luong|thu\s*nhap|luong)\s*[:.-]?\s*\d+/,
  /\bca\s*(?:\d+|[a-z]+|[0-9h:]+).*?(?::\s*|\s+la\s+|\s+duoc\s+)\d+.*?(?:\/|moi\s*)(?:ngay|ca|thang|gio|buoi|h)\b/,
  /\b(?:tra|nhan)\s+luong\s+(?:theo\s+)?ca\s*[:.-]?\s*\d+/,
  /\b(?:thu\s*nhap|luong)\s*(?:&|va)\s*thanh\s*toan\b/,
  /\b(?:quyen\s*loi|ho\s*so\s*bao\s*gom|mo\s*ta\s*cong\s*viec|theo\s*cu\s*phap)\s*[:.-]/,
  /\b(?:yeu\s*cau\s*(?:ung\s*vien|cong\s*viec|ho\s*so|kinh\s*nghiem))\s*[:.-]/,
  /\b(?:chuyen\s*khoan\s*luong|chuyen\s*can|tham\s*nien|an\s*ca\s*mien\s*phi|dao\s*tao\s*khi\s*nhan\s*viec)\b/,
  /\b(?:cong\s*ty\s*tnhh|cong\s*ty\s*co\s*phan|co\.?\s*ltd)\b/,
  /\b(?:ho\s*tro\s*thanh\s*toan|thuong\s*ngay\s*\d+k|thuong\s*nong)\b/,
  /\b(?:tuyen\s+(?:thoi\s*vu|chinh\s*thuc))\b/,
]

/**
 * Nhận diện ý định tìm việc tự nhiên (không cần gõ đúng từ "tìm việc"):
 * - Em muốn đi làm ngay, ai có việc gì hú em với
 * - Có quán nào / chỗ nào nhận người / thiếu người không ạ
 * - Em rảnh ca tối, ai thuê em làm gì không
 * - Kiếm thêm thu nhập phụ giúp gia đình
 * - Tìm việc lương ngày / lương tuần, lấy lương theo ngày
 */
export const CANDIDATE_INTENT_PATTERNS = [
  /\b(?:tim|can|xin|kiem|muon)\s+(?:viec|job|vc|viet|lam)\b/,
  /\b(?:muon|can|xin|muon\s*xin)\s+(?:di\s*lam|lam|di\s*lam\s*ngay|lam\s*lien|lam\s*luon)\b/,
  /\b(?:ranh|trong)\s+(?:ca|gio|buoi|ngay|thoi\s*gian).*(?:nhan|lam|viec|job)/,
  /\b(?:co\s*cho\s*nao|co\s*quan\s*nao|ai\s*nhan|ai\s*thue|co\s*ai\s*thue).*(?:lam|nhan|nguoi|phu)/,
  /\b(?:cho\s*e\s*hoi|ai\s*biet|co\s*ai\s*biet).*(?:thieu\s*nguoi|can\s*nguoi|nhan\s*nguoi|tuyen\s*nguoi)/,
  /\b(?:em|minh|toi|chau|e)\s*(?:muon|can|tim)\s*(?:kiem\s*them\s*)?(?:thu\s*nhap|tien|viec)\b/,
  /\bkiem\s*them\s*thu\s*nhap\s*phu\s*giup\b/,
  /\b(?:tim|can|xin|kiem|co|lam)\s+(?:viec\s+)?luong\s+(?:ngay|tuan)\b/,
  /\b(?:muon|can|tim|xin)\s+(?:viec\s+)?(?:lay|nhan)\s+luong\s+(?:theo\s+)?(?:ngay|tuan)\b/,
  /\b(?:muon|can|tim|xin)\s+(?:viec\s+)?(?:thoi\s*vu|chinh\s*thuc|part\s*time|full\s*time|ca\s*dem|ca\s*ngay|xoay\s*ca|hanh\s*chinh)\b/,
  /\b(?:muon|can|tim|xin)\s+(?:viec\s+)?(?:phu\s*xe|lai\s*xe|tai\s*xe|boc\s*xep|dong\s*goi|co\s*khi|han|dien|nuoc|phu\s*bep|phuc\s*vu|tap\s*vu|bao\s*ve|ban\s*hang|thu\s*ngan|kho|giao\s*hang|shipper)\b/,
]

export function findMatchedKeywords(content: string, keywords: string[]): string[] {
  const norm = normalizeText(content)
  const teencode = normalizeTeencode(norm)

  const matched = keywords.filter((keyword) => {
    const rawNeedle = keyword.trim()
    if (!rawNeedle) return false
    const needle = normalizeText(rawNeedle)
    const teencodeNeedle = normalizeTeencode(needle)

    // Với các từ ngắn (<= 3 ký tự như ib, cv, jd, chấm...) so khớp theo ranh giới từ để tránh nhầm
    if (needle.length <= 3) {
      const escaped = needle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
      const regex = new RegExp(`(^|\\s|[.,!?;:()\\/\\-\\[\\]{}"'“”])${escaped}($|\\s|[.,!?;:()\\/\\-\\[\\]{}"'“”])`, 'i')
      return regex.test(norm) || regex.test(teencode)
    }

    // Khớp chuỗi thông thường (hỗ trợ cả text gốc chuẩn hoá VÀ text sau khi giải mã teencode/lỗi gõ)
    return norm.includes(needle) || teencode.includes(needle) || teencode.includes(teencodeNeedle)
  })

  return matched
}

/** Accepts a full group URL, a group slug or a numeric id, returns a canonical group URL or null. */
export function normalizeGroupInput(input: string): string | null {
  const value = input.trim()
  if (!value) return null
  if (GROUP_URL_PATTERN.test(value)) {
    const match = value.match(/groups\/([\w.-]+)/i)
    return match ? `https://www.facebook.com/groups/${match[1]}` : null
  }
  if (NUMERIC_OR_SLUG_PATTERN.test(value)) return `https://www.facebook.com/groups/${value}`
  // Nếu không phải là URL hay ID, thì nó là một từ khóa (keyword). Trả về nguyên gốc.
  return value
}

const RESERVED_PROFILE_PATHS = new Set(['groups', 'messages', 'pages', 'watch', 'marketplace', 'login', 'profile.php'])
const MAX_LEADS_PER_DIGEST = 10

/**
 * Accepts a profile link, messenger link, username or numeric id.
 * Returns the canonical Messenger thread URL, or null when the input is not a valid target.
 */
export function normalizeRecipientInput(input: string): string | null {
  const value = input.trim()
  if (!value) return null

  if (/^https?:\/\//i.test(value)) {
    let url: URL
    try {
      url = new URL(value)
    } catch {
      return null
    }
    if (!/(^|\.)(facebook|messenger)\.com$/i.test(url.hostname)) return null

    const threadMatch = url.pathname.match(/\/(?:messages\/)?t\/([\w.-]+)/i)
    if (threadMatch) return `https://www.facebook.com/messages/t/${threadMatch[1]}`

    const profileId = url.pathname === '/profile.php' ? url.searchParams.get('id') : null
    if (profileId && /^\d+$/.test(profileId)) return `https://www.facebook.com/messages/t/${profileId}`

    const username = url.pathname.split('/').filter(Boolean)[0]
    if (username && !RESERVED_PROFILE_PATHS.has(username) && NUMERIC_OR_SLUG_PATTERN.test(username)) {
      return `https://www.facebook.com/messages/t/${username}`
    }
    return null
  }

  return NUMERIC_OR_SLUG_PATTERN.test(value) ? `https://www.facebook.com/messages/t/${value}` : null
}

/** Chuẩn hóa link bài viết Facebook để khớp bình luận với bài viết gốc */
export function normalizePostUrl(url: string): string {
  if (!url) return ''
  const m = url.match(/(https:\/\/[^/]+\/groups\/[^/]+\/(?:posts|permalink)\/\d+)/i)
  if (m) return m[1]
  const fbid = url.match(/(?:story_fbid=|fbid=)(\d+)/i)
  if (fbid) return fbid[1]
  return url.split('?')[0].split('&')[0]
}

/** Các mẫu bình luận của HR/đối thủ (trả lời ứng viên hoặc cmt tuyển ké dạo) */
export const HR_COMMENT_PATTERN =
  /\b(?:check\s*(?:ib|inbox)|da\s*(?:ib|inbox)|(?:ib|inbox|nhan\s*tin)\s*(?:minh|anh|chi|em)\s*(?:tu\s*van|nhe|nha|di|trao\s*doi)|lien\s*he\s*zalo|nhan\s*zalo|ben\s*(?:minh|anh|chi|em)\s*(?:dang|can)?\s*tuyen)\b/i

export class ScannerService {
  private timer: NodeJS.Timeout | null = null
  private cycleInProgress = false
  private accountRotation = 0
  private quickScanGroupIndex = 0 // Xoay vòng nhóm khi quét luân phiên
  private currentContext: BrowserContext | null = null

  constructor(
    private readonly store: StoreService,
    private readonly ipv6Service: Ipv6Service,
    private readonly localProxyService: LocalProxyService,
    private readonly createContext: CreateContext,
    private readonly isWorkerBusy: () => boolean,
    private readonly pushEvent: PushEvent,
  ) { }

  getConfig(): ScannerConfig {
    return this.store.getScannerConfig()
  }

  /** Validates and persists config. Returns error message when invalid. */
  saveConfig(input: {
    groups: string[]
    keywords: string[]
    intentKeywords?: string[]
    commentKeywords?: string[]
    excludeKeywords?: string[]
    autoFilterSpam?: boolean
    scanComments?: boolean
    maxPostAgeDays?: number
    maxPostLength?: number
    intervalMinutes: number
    notifyRecipient?: string
  }): { success: boolean; error?: string } {
    const groups = Array.from(
      new Set(input.groups.map(normalizeGroupInput).filter((g): g is string => g !== null)),
    )
    const keywords = Array.from(new Set(input.keywords.map((k) => k.trim()).filter((k) => k.length > 0)))
    const intentKeywords = Array.from(new Set((input.intentKeywords ?? []).map((k) => k.trim()).filter((k) => k.length > 0)))
    const commentKeywords = Array.from(new Set((input.commentKeywords ?? []).map((k) => k.trim()).filter((k) => k.length > 0)))
    const excludeKeywords = Array.from(new Set((input.excludeKeywords ?? []).map((k) => k.trim()).filter((k) => k.length > 0)))

    if (groups.length === 0) return { success: false, error: 'Cần ít nhất 1 nhóm hợp lệ' }
    if (groups.length > MAX_GROUPS) return { success: false, error: `Tối đa ${MAX_GROUPS} nhóm` }
    if (keywords.length === 0) return { success: false, error: 'Cần ít nhất 1 từ khóa tìm kiếm' }

    const rawRecipient = (input.notifyRecipient ?? '').trim()
    const notifyRecipient = rawRecipient ? normalizeRecipientInput(rawRecipient) : ''
    if (rawRecipient && !notifyRecipient) {
      return { success: false, error: 'Người nhận thông báo không hợp lệ (dán link trang cá nhân Facebook, username hoặc ID)' }
    }

    const intervalMinutes = Math.max(MIN_INTERVAL_MINUTES, Math.floor(Number(input.intervalMinutes) || 15))
    const maxPostAgeDays = Math.max(1, Math.min(30, Math.floor(Number(input.maxPostAgeDays) || 3)))
    const maxPostLength = Math.max(0, Math.floor(Number(input.maxPostLength) || 0))
    this.store.updateScannerConfig({
      groups,
      keywords,
      intentKeywords,
      commentKeywords,
      excludeKeywords,
      autoFilterSpam: input.autoFilterSpam ?? true,
      scanComments: input.scanComments ?? false,
      maxPostAgeDays,
      maxPostLength,
      intervalMinutes,
      notifyRecipient: notifyRecipient || undefined,
    })
    return { success: true }
  }

  isRunning(): boolean {
    return this.store.getScannerConfig().isRunning
  }

  start(): { success: boolean; error?: string } {
    const config = this.store.getScannerConfig()
    if (config.groups.length === 0 || config.keywords.length === 0) {
      return { success: false, error: 'Hãy lưu danh sách nhóm và từ khóa trước' }
    }
    this.store.updateScannerConfig({ isRunning: true })
    this.log('▶️ Bắt đầu săn khách')
    this.scheduleNext(0)
    this.emitStatus()
    return { success: true }
  }

  async stop(): Promise<void> {
    this.store.updateScannerConfig({ isRunning: false })
    if (this.timer) {
      clearTimeout(this.timer)
      this.timer = null
    }
    if (this.currentContext) {
      try {
        await this.currentContext.close()
      } catch (err) {
        console.warn('[Scanner] Failed to close context:', (err as Error).message)
      }
      this.currentContext = null
    }
    this.log('⏹ Đã dừng săn khách')
    this.emitStatus()
  }

  /** Called on app boot to resume a scan the user left running. */
  resumeIfNeeded(): void {
    if (this.isRunning()) this.scheduleNext(30 * 1000)
  }

  private scheduleNext(delayMs: number): void {
    if (this.timer) clearTimeout(this.timer)
    if (!this.isRunning()) return
    this.timer = setTimeout(() => {
      this.runCycle().catch((err) => console.error('[Scanner] Cycle crashed:', err))
    }, delayMs)
  }

  private async runCycle(): Promise<void> {
    if (!this.isRunning()) return
    const intervalMs = this.store.getScannerConfig().intervalMinutes * 60 * 1000

    if (this.cycleInProgress || this.isWorkerBusy()) {
      this.scheduleNext(BUSY_RETRY_MS)
      return
    }

    this.cycleInProgress = true
    this.emitStatus()
    try {
      await this.scanAllGroups()
    } catch (err) {
      this.log(`❌ Lỗi khi quét: ${(err as Error).message}`)
    } finally {
      this.cycleInProgress = false
      this.currentContext = null
      this.emitStatus()
      this.scheduleNext(intervalMs)
    }
  }

  private pickAccount() {
    const accounts = this.store
      .getAccounts()
      .filter((a) => (a.platform || '').toUpperCase() === 'FACEBOOK' && a.status === 'ACTIVE')
    if (accounts.length === 0) return null
    return accounts[this.accountRotation++ % accounts.length]
  }

  private async scanAllGroups(): Promise<void> {
    const config = this.store.getScannerConfig()
    const account = this.pickAccount()
    if (!account) {
      this.log('⚠️ Không có tài khoản Facebook ACTIVE để quét')
      return
    }

    this.log(`🔍 Bắt đầu lượt quét ${config.groups.length} nhóm bằng tài khoản ${account.username}`)

    let proxyUrl: string | undefined
    if (this.ipv6Service.isAvailable) {
      const fixedIp = this.ipv6Service.generateFixedIpv6ForAccount(account.id)
      const bound = await this.ipv6Service.bindIpToSystem(fixedIp)
      if (bound) {
        this.localProxyService.start(8888)
        this.localProxyService.setBindIp(fixedIp)
        proxyUrl = 'http://127.0.0.1:8888'
      }
    }

    const { context, page: initialPage } = await this.createContext(account, proxyUrl)
    let page = initialPage
    this.currentContext = context
    let browserClosedExternally = false
    let stoppedByUs = false
    context.on('close', () => {
      if (!stoppedByUs) browserClosedExternally = true
    })

    // Bật chế độ tiết kiệm RAM: chặn video/reels tự tải ngầm
    await this.enableMemorySaver(page)
    // Cài đặt bộ lắng nghe phát hiện người dùng can thiệp để tạm dừng 30s
    await this.setupUserInteractionDetector(page)

    let newLeads = 0
    const cycleLeads: ScrapedLead[] = []
    let totalPostsRead = 0
    let groupsScanned = 0

    try {
      // 1. KIỂM TRA VÀ CHUYỂN NGAY VỀ TÀI KHOẢN CÁ NHÂN NẾU ĐANG KẸT Ở FANPAGE
      await this.ensurePersonalProfile(page)

      // Biến đổi danh sách đầu vào (chứa cả URL và Từ khóa) thành danh sách URL nhóm thuần
      const targetGroupUrls = new Set<string>()
      for (const input of config.groups) {
        if (!this.isRunning()) break
        if (input.includes('facebook.com/groups/')) {
          targetGroupUrls.add(input)
          continue
        }

        // Nếu là từ khoá, tiến hành tìm kiếm nhóm
        this.log(`🔍 Tìm kiếm các nhóm cho từ khoá: "${input}"...`)
        try {
          await page.goto(`https://www.facebook.com/groups/search/groups/?q=${encodeURIComponent(input)}`, { waitUntil: 'domcontentloaded' })
          await sleep(3000)

          let foundCount = 0
          for (let i = 0; i < 5; i++) { // Scroll 5 lần để kiếm cỡ 10-20 nhóm là đẹp
            const urls = await page.evaluate(() => {
              const resultUrls: string[] = []
              const groupPattern = /https:\/\/(?:www|m|web)\.facebook\.com\/groups\/([a-zA-Z0-9._-]+)/i

              // 1. Tìm toàn bộ các thẻ <a>
              const allLinks = Array.from(document.querySelectorAll('a[href]'))
              for (const a of allLinks) {
                const href = a.getAttribute('href') || ''
                const match = href.match(groupPattern)
                if (match) {
                  const slug = match[1]
                  if (slug && !['search', 'discover', 'feed', 'joins', 'create'].includes(slug.toLowerCase())) {
                    resultUrls.push(`https://www.facebook.com/groups/${slug}`)
                  }
                }
              }

              // 2. Tìm trong role="link" hoặc các thẻ div chứa thuộc tính data
              const clickableNodes = Array.from(document.querySelectorAll('[role="link"], [data-headline], div[aria-label]'))
              for (const node of clickableNodes) {
                const href = (node as any).href || node.getAttribute('href') || ''
                const match = href.match(groupPattern)
                if (match) {
                  const slug = match[1]
                  if (slug && !['search', 'discover', 'feed', 'joins', 'create'].includes(slug.toLowerCase())) {
                    resultUrls.push(`https://www.facebook.com/groups/${slug}`)
                  }
                }
              }

              return Array.from(new Set(resultUrls))
            })

            for (const url of urls) {
              if (!targetGroupUrls.has(url)) {
                targetGroupUrls.add(url)
                foundCount++
              }
            }
            if (foundCount >= 15) break // Lấy tối đa 15 nhóm tốt nhất mỗi từ khóa
            await page.evaluate(() => window.scrollBy(0, 1500))
            await sleep(2000)
          }
          this.log(`✅ Đã tìm thấy ${foundCount} nhóm cho từ khóa "${input}"`)
        } catch (err) {
          this.log(`⚠️ Lỗi khi tìm nhóm cho từ khóa "${input}": ${(err as Error).message}`)
        }
      }

      const finalGroupList = Array.from(targetGroupUrls)
      this.log(`🚀 Bắt đầu quét tổng cộng ${finalGroupList.length} nhóm...`)

      for (const groupUrl of finalGroupList) {
        if (!this.isRunning()) break
        if (browserClosedExternally) {
          this.log('⚠️ Trình duyệt bị đóng giữa chừng, kết thúc lượt quét sớm')
          break
        }

        // Dọn dẹp DOM & giải phóng RAM định kỳ sau mỗi 2 nhóm
        if (groupsScanned > 0 && groupsScanned % 2 === 0) {
          this.log(`🧹 Đang thu hồi bộ nhớ RAM (${groupsScanned}/${finalGroupList.length} nhóm)...`)
          try {
            await page.close().catch(() => { })
            page = await context.newPage()
            await this.enableMemorySaver(page)
          } catch (e) {
            console.warn('[Scanner] Failed to recycle tab:', (e as Error).message)
          }
        }

        try {
          const result = await this.scanGroup(page, groupUrl, config)
          cycleLeads.push(...result.newLeads)
          newLeads += result.newLeads.length
          totalPostsRead += result.postsRead
          groupsScanned++
        } catch (err) {
          if ((err as Error).message === 'SESSION_EXPIRED') {
            this.log(`🚨 Tài khoản ${account.username} hết phiên đăng nhập/bị yêu cầu xác minh -> đánh dấu CHECKPOINT`)
            this.store.updateAccountStatus(account.id, 'CHECKPOINT')
            break
          }
          this.log(`⚠️ Bỏ qua nhóm ${groupUrl}: ${(err as Error).message}`)
        }
        await sleep(randomBetween(5000, 12000))
      }

      if (this.isRunning() && !browserClosedExternally && cycleLeads.length > 0 && config.notifyRecipient) {
        try {
          await this.sendDigest(page, config.notifyRecipient, cycleLeads)
          this.log(`📨 Đã nhắn Messenger báo ${cycleLeads.length} khách mới`)
        } catch (err) {
          this.log(`⚠️ Không gửi được tin nhắn báo khách: ${(err as Error).message}`)
        }
      }

      if (this.isRunning() && !browserClosedExternally) {
        const cookies = await context.cookies()
        if (cookies.length > 0) this.store.updateAccountCookie(account.id, JSON.stringify(cookies))
      }
    } finally {
      stoppedByUs = true
      try {
        await context.close()
      } catch (err) {
        console.warn('[Scanner] Failed to close context:', (err as Error).message)
      }
    }

    this.log(`✅ Xong lượt quét: ${groupsScanned}/${config.groups.length} nhóm, đọc ${totalPostsRead} bài, ${newLeads} khách mới`)
  }

  private async scanGroup(page: Page, groupUrl: string, config: ScannerConfig): Promise<{ postsRead: number; newLeads: ScrapedLead[] }> {
    if (page.isClosed()) throw new Error('PAGE_CLOSED')
    await page.goto(`${groupUrl}?sorting_setting=CHRONOLOGICAL`, { waitUntil: 'domcontentloaded', timeout: 45000 }).catch(async (err) => {
      if (err.message?.includes('crash') || err.message?.includes('Target closed') || page.isClosed()) {
        throw new Error('PAGE_CRASHED')
      }
      // Thử reload lại một lần nếu gặp lỗi tải trang
      await page.reload({ waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => { })
    })
    await sleep(randomBetween(3000, 5000))

    if (page.isClosed()) throw new Error('PAGE_CRASHED')

    const isLoginScreen = await page
      .evaluate(() => !!document.querySelector('input[name="email"], input[name="pass"]') || /login|checkpoint/i.test(location.href))
      .catch(() => false)
    if (isLoginScreen) throw new Error('SESSION_EXPIRED')

    // Kích hoạt bộ cảm biến phát hiện người dùng chạm/thao tác màn hình để tạm dừng 30s
    await this.setupUserInteractionDetector(page)

    const groupName = (await page.title()).replace(/\s*\|\s*Facebook.*$/i, '').trim()
    const newLeads: ScrapedLead[] = []

    // Facebook virtualizes the feed (old posts leave the DOM), so accumulate posts across scroll rounds
    const collected = new Map<string, RawPost>()
    const maxAgeDays = config.maxPostAgeDays ?? 3
    const MAX_CONSECUTIVE_OLD_POSTS = 25
    let consecutiveOldPosts = 0

    const collect = async (): Promise<boolean> => {
      try {
        // Tối ưu hóa hiệu năng cao: Xử lý trực tiếp trong DOM trình duyệt bằng 1 lệnh duy nhất
        // Giúp tốc độ quét nhanh gấp 100 lần, không còn bị đơ/lag/dừng giữa chừng
        await page.evaluate(() => {
          // 1. Tự động đóng và gỡ bỏ Popup / Modal nếu có để giải phóng giao diện
          const dialogs = Array.from(document.querySelectorAll('div[role="dialog"], div[aria-modal="true"]')) as HTMLElement[]
          for (const dialog of dialogs) {
            const closeBtn = dialog.querySelector('div[aria-label="Đóng"], div[aria-label="Close"], [role="button"][aria-label*="Đóng" i], [role="button"][aria-label*="Close" i], [role="button"][aria-label*="Thoát" i]') as HTMLElement | null
            if (closeBtn) {
              try { closeBtn.click() } catch { }
            }
            try { dialog.remove() } catch { }
          }
          if (document.body) document.body.style.overflow = 'auto'
          if (document.documentElement) document.documentElement.style.overflow = 'auto'
        })
        await sleep(100)
      } catch (err) { }

      // 1. Quét bình luận trước để biết bài viết nào đang có người cmt xin việc
      const matchedCommentsByPostUrl = new Map<string, Array<{ authorName: string; authorUrl?: string; content: string; matchedKeywords: string[] }>>()

      if (config.scanComments || (config.commentKeywords && config.commentKeywords.length > 0)) {
        const comments = await this.extractComments(page)
        const defaultCandidateCommentKws = [
          'xin viec', 'xin việc', 'tim viec', 'tìm việc', 'con tuyen', 'còn tuyển',
          'con tuyen ko', 'còn tuyển không', 'con nhan ko', 'còn nhận không',
          'xin jd', 'apply', 'nop cv', 'xin info cong viec', 'xin thong tin cong viec',
          'nhan nam', 'nhan nu', 'nhận nam', 'nhận nữ', 'nam duoc ko', 'nam được không',
          'nu duoc ko', 'nữ được không', 'chua du 18', 'chưa đủ 18', 'du 18 tuoi',
          'con ca', 'còn ca', 'ca dem', 'ca ngay', 'thoi vu', 'thời vụ',
          'co coc ko', 'có cọc không', 'lam duoc khong', 'làm được không', 'xin slot'
        ]
        const commentFilterKws = (config.commentKeywords && config.commentKeywords.length > 0)
          ? config.commentKeywords
          : [...(config.keywords || []), ...defaultCandidateCommentKws]

        for (const comment of comments) {
          // Bỏ qua bình luận của HR/đối thủ (Check ib, Đã ib, Ib mình tư vấn, Bên mình đang tuyển...)
          const normCmt = normalizeText(comment.content)
          if (HR_COMMENT_PATTERN.test(normCmt)) {
            continue
          }

          const evalCmt = evaluatePostMatch(
            comment.content,
            { ...config, keywords: commentFilterKws },
            comment.authorName,
          )
          if (evalCmt.matched && evalCmt.matchedKeywords.length > 0) {
            const cleanUrl = normalizePostUrl(comment.postUrl)
            const list = matchedCommentsByPostUrl.get(cleanUrl) ?? []
            list.push({
              authorName: comment.authorName,
              authorUrl: comment.authorUrl,
              content: comment.content,
              matchedKeywords: evalCmt.matchedKeywords,
            })
            matchedCommentsByPostUrl.set(cleanUrl, list)
          }
        }
      }

      const posts = await this.extractPosts(page)
      this.log(`[Debug] Lượt này bóc được ${posts.length} bài trên màn hình, tổng đã gom: ${collected.size + posts.length}`)

      const processedPostUrls = new Set<string>()

      // Quét và lọc bài viết ngay lập tức trong từng lượt cuộn (Real-time Stream)
      for (const post of posts) {
        const id = this.buildLeadId(post)
        if (!collected.has(id)) {
          collected.set(id, post)
          const cleanUrl = normalizePostUrl(post.postUrl)
          processedPostUrls.add(cleanUrl)

          // NẾU BÀI NÀY ĐÃ TỪNG ĐƯỢC BẮT VÀ LƯU VÀO DANH SÁCH TỪ TRƯỚC:
          // BỎ QUA NGAY LẬP TỨC! Tuyệt đối không quét lại bài cũ đã tìm được!
          const existingLeads = this.store.getLeads()
          const normAuthor = normalizeText(post.authorName || '')
          const normSnippet = normalizeText(post.content || '').slice(0, 50)

          const isAlreadyScraped = existingLeads.some(l => {
            if (l.id === id) return true
            if (l.postUrl && post.postUrl && l.postUrl.split('?')[0] === post.postUrl.split('?')[0] && !l.postUrl.endsWith('/groups/')) {
              return true
            }
            const lNormAuthor = normalizeText(l.authorName || '')
            const lNormContent = normalizeText(l.content || '')
            const authorMatch = normAuthor.length > 2 && (lNormAuthor.includes(normAuthor) || normAuthor.includes(lNormAuthor))
            const contentMatch = normSnippet.length > 10 && lNormContent.includes(normSnippet)
            return authorMatch && contentMatch
          })

          if (isAlreadyScraped) {
            this.log(`⏩ [Đã có trong danh sách]: "${post.authorName}" -> Bỏ qua, lướt tiếp...`)
            continue
          }

          // Lọc thời gian đăng bài (bỏ qua nếu đăng cũ hơn maxAgeDays)
          const ageDays = parsePostAgeDays(post.postTimeText)
          if (ageDays !== null && ageDays > maxAgeDays) {
            consecutiveOldPosts++
            this.log(`⏳ [Bỏ qua bài cũ] "${post.authorName}" đăng ${post.postTimeText || `${ageDays} ngày trước`} (${consecutiveOldPosts}/${MAX_CONSECUTIVE_OLD_POSTS} bài liên tiếp)`)
            if (consecutiveOldPosts >= MAX_CONSECUTIVE_OLD_POSTS && collected.size >= 25) {
              return true // Dừng cuộn nhóm khi đủ bài cũ liên tiếp và đã duyệt ít nhất 25 bài
            }
            continue
          } else if (ageDays !== null) {
            // Gặp bài đăng mới trong hạn quy định -> reset bộ đếm liên tiếp (tránh bị dừng nhầm do bài ghim)
            consecutiveOldPosts = 0
          }

          const candidateCmts = matchedCommentsByPostUrl.get(cleanUrl)
          const evalResult = evaluatePostMatch(post.content, config, post.authorName, groupName)

          // NẾU BÀI VIẾT KHỚP (ĐÃ LỌC SẠCH HR & KHÔNG QUÁ 30 TỪ):
          // Lưu bài viết đó vào danh sách khách hàng tiềm năng
          if (evalResult.matched) {
            let finalContent = post.content.slice(0, 2000)
            const allKeywords = [...evalResult.matchedKeywords]

            if (candidateCmts && candidateCmts.length > 0) {
              allKeywords.unshift(`Có ${candidateCmts.length} cmt xin việc`)
              const cmtSummary = candidateCmts.map((c) => `• ${c.authorName}: "${c.content}"`).join('\n')
              finalContent = `${finalContent}\n\n💬 ỨNG VIÊN BÌNH LUẬN XIN VIỆC (${candidateCmts.length}):\n${cmtSummary}`.slice(0, 3000)
            }

            const lead: ScrapedLead = {
              id,
              groupName,
              authorName: candidateCmts && candidateCmts.length > 0
                ? `📌 ${post.authorName} (${candidateCmts.length} cmt xin việc)`
                : post.authorName,
              authorUrl: post.authorUrl || undefined,
              content: finalContent,
              postUrl: post.postUrl,
              postTimeText: post.postTimeText,
              matchedKeywords: Array.from(new Set(allKeywords)),
              timestamp: Date.now(),
              status: 'new',
            }

            if (this.store.addLead(lead)) {
              newLeads.push(lead)
              this.pushEvent('scanner:new_lead', lead)
              if (candidateCmts && candidateCmts.length > 0) {
                this.log(`🎯 [Bắt bài viết có cmt xin việc]: "${post.authorName}" (${candidateCmts.length} ứng viên cmt)`)
              } else {
                this.log(`🎯 Khách mới: ${lead.authorName} (${evalResult.matchedKeywords.join(', ')})`)
              }
            }
          } else if (candidateCmts && candidateCmts.length > 0) {
            // NẾU BÀI VIẾT LÀ BÀI ĐĂNG TUYỂN DỤNG CỦA HR/CÔNG TY:
            // Chỉ giữ lại các bình luận của Ứng viên thật sự xin việc bên dưới bài đăng tuyển dụng đó.
            // Nếu bài viết gốc là BÀI BÁN HÀNG CỦA SHOP (bánh kem, quần áo, sim, đồ gia dụng, BĐS):
            // TUYỆT ĐỐI BỎ QUA 100% VÌ ĐÓ LÀ KHÁCH HỎI MUA HÀNG, KHÔNG PHẢI ỨNG VIÊN XIN VIỆC!
            const reason = evalResult.rejectReason || ''
            const isRecruiterPost = reason.includes('HR') || reason.includes('tuyển dụng') || reason.includes('Nhà tuyển dụng') || reason.includes('JD') || reason.includes('bản tin')
            const isSellerOrSpamPost = reason.includes('bán hàng') || reason.includes('shop') || reason.includes('quảng cáo') || reason.includes('xã hội') || reason.includes('liệt sĩ')

            if (isRecruiterPost && !isSellerOrSpamPost) {
              this.log(`🛡️ [Né bài HR/Cửa hàng] "${post.authorName}": ${evalResult.rejectReason}. Giữ lại ${candidateCmts.length} ứng viên cmt xin việc bên dưới.`)
              for (const cmt of candidateCmts) {
                const cmtLeadId = `fb_cmt_${createHash('sha1').update(`${cleanUrl}_${cmt.authorName}_${cmt.content}`).digest('hex').slice(0, 16)}`
                const cmtLead: ScrapedLead = {
                  id: cmtLeadId,
                  groupName,
                  authorName: `💬 ${cmt.authorName}`,
                  authorUrl: cmt.authorUrl || undefined,
                  content: `[Ứng viên bình luận xin việc]: "${cmt.content}"\n\n📌 Bài viết gốc: ${post.postUrl}`,
                  postUrl: post.postUrl,
                  postTimeText: post.postTimeText,
                  matchedKeywords: ['Ứng viên bình luận xin việc', ...cmt.matchedKeywords],
                  timestamp: Date.now(),
                  status: 'new',
                }
                if (this.store.addLead(cmtLead)) {
                  newLeads.push(cmtLead)
                  this.pushEvent('scanner:new_lead', cmtLead)
                  this.log(`🎯 [Bắt ứng viên từ cmt]: "${cmt.authorName}" - "${cmt.content.slice(0, 50)}"`)
                }
              }
            } else {
              this.log(`🛡️ [Né bài bán hàng/quảng cáo] "${post.authorName}": ${evalResult.rejectReason} (Bỏ qua toàn bộ cmt hỏi mua hàng)`)
            }
          } else if (evalResult.rejectReason) {
            this.log(`🛡️ [Né bài] "${post.authorName}": ${evalResult.rejectReason}`)
          }
        }
      }

      // Xử lý các bình luận xin việc ở các bài chưa kịp nạp postCards
      for (const [pUrl, cmts] of matchedCommentsByPostUrl.entries()) {
        if (!processedPostUrls.has(pUrl) && cmts.length > 0) {
          for (const cmt of cmts) {
            const fallbackCmtId = `fb_cmt_${createHash('sha1').update(`${pUrl}_${cmt.authorName}_${cmt.content}`).digest('hex').slice(0, 16)}`
            if (!collected.has(fallbackCmtId)) {
              collected.set(fallbackCmtId, { authorName: cmt.authorName, authorUrl: cmt.authorUrl || '', content: cmt.content, postUrl: pUrl })
              const cmtLead: ScrapedLead = {
                id: fallbackCmtId,
                groupName,
                authorName: `💬 ${cmt.authorName}`,
                authorUrl: cmt.authorUrl || undefined,
                content: `[Ứng viên bình luận xin việc]: "${cmt.content}"\n\n📌 Bài viết gốc: ${pUrl}`,
                postUrl: pUrl,
                matchedKeywords: ['Ứng viên bình luận xin việc', ...cmt.matchedKeywords],
                timestamp: Date.now(),
                status: 'new',
              }
              if (this.store.addLead(cmtLead)) {
                newLeads.push(cmtLead)
                this.pushEvent('scanner:new_lead', cmtLead)
                this.log(`🎯 [Bắt ứng viên từ cmt]: "${cmt.authorName}"`)
              }
            }
          }
        }
      }

      return false
    }

    // Đọc lứa bài đầu tiên trên màn hình
    await collect()

    let stalledRounds = 0
    const MAX_ROUNDS = 45

    for (let round = 0; round < MAX_ROUNDS && collected.size < TARGET_POSTS_PER_GROUP; round++) {
      if (!this.isRunning() || page.isClosed()) break

      // 0. Nếu người dùng vừa chạm/lăn chuột/thao tác vào màn hình -> Tạm dừng 30s để người dùng xem
      await this.checkUserPause(page)
      if (!this.isRunning() || page.isClosed()) break

      const sizeBefore = collected.size
      const scrollAmount = randomBetween(1400, 2000)

      // 1. Đánh dấu bot đang phát lệnh cuộn để bộ cảm biến hoàn toàn bỏ qua các sự kiện cuộn này
      await page.evaluate(() => {
        const w = window as any;
        w.__agy_bot_scrolling = true;
        w.__agy_bot_acting = Date.now();
      }).catch(() => { })

      // 2. Lăn chuột thật qua CDP Playwright vào giữa Bảng tin nhóm (x=650, y=450)
      await page.mouse.move(650, 450).catch(() => { })
      await page.mouse.wheel(0, scrollAmount)

      // 3. Cuộn trang kết hợp DOM: cuộn window, body và đưa bài viết cuối cùng vào tầm nhìn
      await page.evaluate((amount) => {
        // Gỡ bỏ triệt để Dialog nếu có để giải phóng lớp overlay chặn cuộn màn hình
        const dialogs = Array.from(document.querySelectorAll('div[role="dialog"], div[aria-modal="true"]')) as HTMLElement[]
        for (const dialog of dialogs) {
          const closeBtn = dialog.querySelector('div[aria-label="Đóng"], div[aria-label="Close"], [role="button"][aria-label*="Đóng" i], [role="button"][aria-label*="Close" i], [role="button"][aria-label*="Thoát" i]') as HTMLElement | null
          if (closeBtn) {
            try { closeBtn.click() } catch { }
          }
          try { dialog.remove() } catch { }
        }
        if (document.body) document.body.style.overflow = 'auto'
        if (document.documentElement) document.documentElement.style.overflow = 'auto'

        window.scrollBy(0, amount)
        if (document.documentElement) document.documentElement.scrollTop += amount
        if (document.scrollingElement) document.scrollingElement.scrollTop += amount

        // Đưa thẻ bài viết cuối cùng hiện tại vào tầm nhìn để kích hoạt Facebook nạp bài tiếp theo
        const articles = document.querySelectorAll('div[role="feed"] > div, div[role="article"], div[aria-posinset]')
        if (articles.length > 0) {
          const lastArticle = articles[articles.length - 1] as HTMLElement
          try {
            lastArticle.scrollIntoView({ behavior: 'smooth', block: 'end' })
          } catch { }
        }

        // Kết thúc nhịp cuộn của bot
        const w = window as any;
        w.__agy_bot_scrolling = false;
        w.__agy_bot_acting = Date.now();
      }, scrollAmount)

      await sleep(randomBetween(1200, 1800))

      await this.checkUserPause(page)

      const reachedOld = await collect()
      if (reachedOld && collected.size >= 25) {
        this.log(`⏱ Đã phát hiện ${MAX_CONSECUTIVE_OLD_POSTS} bài liên tiếp cũ hơn ${maxAgeDays} ngày -> Dừng cuộn nhóm!`)
        break
      }

      stalledRounds = collected.size > sizeBefore ? 0 : stalledRounds + 1

      // Nếu Facebook tải chậm làm nghẽn lượt bóc bài: tiếp tục cuộn xuống mạnh hơn
      if (stalledRounds >= 3 && stalledRounds < 6) {
        await this.checkUserPause(page)
        await page.evaluate(() => {
          const w = window as any;
          w.__agy_bot_scrolling = true;
          w.__agy_bot_acting = Date.now();
        }).catch(() => { })
        await page.mouse.move(650, 450).catch(() => { })
        await page.mouse.wheel(0, 2500)
        await sleep(500)
        await page.evaluate(() => {
          const w = window as any;
          w.__agy_bot_scrolling = false;
          w.__agy_bot_acting = Date.now();
        }).catch(() => { })
        await sleep(1500)
      }

      // Ngưỡng dừng cuộn: Nếu nhóm mới bóc được ít bài (< 25 bài), kiên nhẫn thử đến 10 lần cuộn
      const maxStalledLimit = collected.size < 25 ? 10 : 6
      if (stalledRounds >= maxStalledLimit) {
        this.log(`[Debug] Đã cuộn hết bảng tin nhóm hoặc không có thêm bài mới sau ${maxStalledLimit} lần cuộn, hoàn thành nhóm.`)
        break
      }
    }

    this.log(`📄 ${groupName || groupUrl}: đọc ${collected.size} bài, ${newLeads.length} khách tiềm năng phù hợp`)
    return { postsRead: collected.size, newLeads }
  }

  /**
   * Quét nhanh một nhóm trực tiếp từ tab Playwright đang mở của Worker (chế độ Luân phiên Đăng bài 🔄 Săn khách)
   * Không mở lại browser mới, tận dụng luôn tab hiện tại.
   */
  async scanQuicklyWithPage(page: Page, maxGroups: number = 2): Promise<number> {
    const config = this.store.getScannerConfig()
    if (!config.isRunning || config.groups.length === 0 || config.keywords.length === 0) {
      return 0
    }

    const groups = config.groups.filter(g => g.includes('facebook.com/groups/'))
    if (groups.length === 0) return 0

    // Đảm bảo chuyển về Tài khoản cá nhân trước khi quét
    await this.ensurePersonalProfile(page)

    // Xoay vòng nhóm thông minh (Round-Robin) thay vì luôn lấy từ đầu
    const selectedGroups: string[] = []
    const totalGroups = groups.length
    const numToPick = Math.min(maxGroups, totalGroups)

    for (let i = 0; i < numToPick; i++) {
      const idx = (this.quickScanGroupIndex + i) % totalGroups
      selectedGroups.push(groups[idx])
    }
    this.quickScanGroupIndex = (this.quickScanGroupIndex + numToPick) % totalGroups

    let foundLeadsCount = 0

    for (const groupUrl of selectedGroups) {
      if (page.isClosed()) break
      try {
        this.log(`🔍 [Luân phiên] Tạm nghỉ đăng, đang quét săn khách tại nhóm (${selectedGroups.indexOf(groupUrl) + 1}/${selectedGroups.length}): ${groupUrl}`)
        const result = await this.scanGroup(page, groupUrl, config)
        foundLeadsCount += result.newLeads.length
      } catch (err) {
        this.log(`⚠️ [Luân phiên] Lỗi quét nhanh nhóm ${groupUrl}: ${(err as Error).message}`)
      }
      await sleep(randomBetween(3000, 5000))
    }

    return foundLeadsCount
  }

  /**
   * Đánh dấu thời điểm bot chuẩn bị thao tác để bộ phát hiện không nhầm lẫn với tương tác của người dùng
   */
  private async markBotActing(page: Page): Promise<void> {
    if (page.isClosed()) return
    await page.evaluate(() => {
      (window as any).__agy_bot_acting = Date.now()
    }).catch(() => {})
  }

  /**
   * Kiểm tra xem người dùng có vừa tương tác (chạm, click, lăn chuột, phím) vào màn hình không.
   * Nếu có, tự động tạm dừng 30 giây để người dùng thoải mái xem bài viết.
   */
  private async checkUserPause(page: Page): Promise<void> {
    if (page.isClosed()) return

    const getRemaining = async () => {
      return page.evaluate(() => {
        const until = (window as any).__agy_user_paused_until || 0
        return Math.max(0, until - Date.now())
      }).catch(() => 0)
    }

    let remaining = await getRemaining()
    if (remaining <= 0) return

    this.log(`⏸ Phát hiện bạn đang thao tác trên màn hình -> Tạm dừng quét 30s để bạn xem bài viết...`)

    while (remaining > 0 && this.isRunning() && !page.isClosed()) {
      await sleep(1000)
      remaining = await getRemaining()
    }

    if (this.isRunning() && !page.isClosed()) {
      this.log(`▶️ Hết 30s tạm dừng, tiếp tục tự động quét...`)
    }
  }

  /**
   * Cài đặt bộ lắng nghe phát hiện tương tác thực của người dùng (chuột, bàn phím, con lăn, cảm ứng)
   */
  private async setupUserInteractionDetector(page: Page): Promise<void> {
    try {
      if (page.isClosed()) return

      const scriptContent = () => {
        if ((window as any).__agy_detector_installed) return
        (window as any).__agy_detector_installed = true

        let badgeTimer: any = null
        const updateBadge = (secondsLeft: number) => {
          let badge = document.getElementById('__agy_pause_badge')
          if (secondsLeft <= 0) {
            if (badge) badge.remove()
            if (badgeTimer) clearInterval(badgeTimer)
            badgeTimer = null
            return
          }
          if (!badge) {
            badge = document.createElement('div')
            badge.id = '__agy_pause_badge'
            badge.style.cssText = `
              position: fixed;
              top: 16px;
              right: 20px;
              z-index: 2147483647;
              background: rgba(15, 23, 42, 0.92);
              color: #ffffff;
              padding: 10px 18px;
              border-radius: 9999px;
              font-family: system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
              font-size: 13px;
              font-weight: 600;
              box-shadow: 0 10px 25px -5px rgba(0, 0, 0, 0.4);
              border: 1px solid rgba(255, 255, 255, 0.15);
              display: flex;
              align-items: center;
              gap: 8px;
              pointer-events: none;
              user-select: none;
            `
            document.body?.appendChild(badge)
          }
          badge.innerHTML = `<span style="display:inline-block;width:8px;height:8px;background:#f59e0b;border-radius:50%;"></span> Tạm dừng quét do bạn thao tác (${secondsLeft}s)`
        }

        const onUserAction = (e: any) => {
          // 1. Chỉ chấp nhận sự kiện vật lý thật từ người dùng (loại bỏ event giả lập từ script)
          if (e && e.isTrusted === false) return

          // 2. Bỏ qua các phím hệ thống bot có thể bấm (Escape, PageDown, PageUp)
          if (e && e.type === 'keydown' && ['Escape', 'PageDown', 'PageUp'].includes(e.key)) return

          // 3. Nếu bot đang trong nhịp cuộn tự động -> bỏ qua sự kiện wheel
          if ((window as any).__agy_bot_scrolling) return

          // 4. Nếu cách thời điểm bot vừa chạy lệnh chưa đầy 1.5 giây -> bỏ qua
          const lastBotAct = (window as any).__agy_bot_acting || 0
          if (Date.now() - lastBotAct < 1500) return

          // Xác nhận: Đúng là người dùng thao tác vào màn hình trình duyệt!
          (window as any).__agy_user_paused_until = Date.now() + 30000
          updateBadge(30)
          if (badgeTimer) clearInterval(badgeTimer)
          badgeTimer = setInterval(() => {
            const until = (window as any).__agy_user_paused_until || 0
            const left = Math.ceil((until - Date.now()) / 1000)
            updateBadge(left)
          }, 1000)
        }

        ;['mousedown', 'keydown', 'wheel', 'touchstart'].forEach((evt) => {
          window.addEventListener(evt, onUserAction, { capture: true, passive: true })
        })
      }

      await page.addInitScript(scriptContent).catch(() => {})
      await page.evaluate(scriptContent).catch(() => {})
    } catch (err) {
      console.warn('[Scanner] Failed to setup user interaction detector:', (err as Error).message)
    }
  }

  /** Sends ONE summary message per cycle (never one message per lead) to avoid Messenger spam flags. */
  private async sendDigest(page: Page, recipientUrl: string, leads: ScrapedLead[]): Promise<boolean> {
    const shown = leads.slice(0, MAX_LEADS_PER_DIGEST)
    const lines: string[] = [`🎯 Có ${leads.length} khách mới từ FollowFree:`]
    shown.forEach((lead, index) => {
      const snippet = lead.content.replace(/\s+/g, ' ').slice(0, 120)
      lines.push('', `${index + 1}. ${lead.authorName} (${lead.matchedKeywords.join(', ')})`, `"${snippet}"`, lead.postUrl)
    })
    if (leads.length > shown.length) lines.push('', `... và ${leads.length - shown.length} khách khác trong app`)

    // ĐẢM BẢO Ở TƯ CÁCH CÁ NHÂN: Fanpage không có quyền gửi tin nhắn cho profile cá nhân
    await this.ensurePersonalProfile(page)

    await page.goto(recipientUrl, { waitUntil: 'domcontentloaded', timeout: 45000 })
    const textbox = page.locator('div[role="textbox"][contenteditable="true"]').last()
    await textbox.waitFor({ state: 'visible', timeout: 25000 })
    await sleep(randomBetween(1500, 3000))
    await textbox.click()

    for (let i = 0; i < lines.length; i++) {
      if (i > 0) await page.keyboard.press('Shift+Enter')
      if (lines[i]) await page.keyboard.insertText(lines[i])
    }
    await sleep(randomBetween(800, 1500))
    await page.keyboard.press('Enter')
    await sleep(randomBetween(2000, 3500))
    return true
  }

  private buildLeadId(post: RawPost): string {
    const idMatch = post.postUrl.match(/(?:posts|permalink)\/(\d+)|story_fbid=(\d+)/)
    const postId = idMatch?.[1] ?? idMatch?.[2]
    if (postId) return `fb_${postId}`
    const stableSnippet = normalizeText(post.content).slice(0, 80).replace(/\s+/g, '_')
    const stableAuthor = normalizeText(post.authorName || 'unknown').replace(/\s+/g, '_')
    return `fb_${createHash('sha1').update(`${stableAuthor}_${stableSnippet}`).digest('hex').slice(0, 16)}`
  }

  private async extractPosts(page: Page): Promise<RawPost[]> {
    return page.evaluate((): RawPost[] => {
      const results: RawPost[] = []

      const postCards = Array.from(document.querySelectorAll('div[role="article"], div[aria-posinset]')) as HTMLElement[]

      postCards.forEach((postCard) => {
        // Bỏ qua các thẻ nằm lồng bên trong thẻ article khác (bài viết được chia sẻ)
        if (postCard.parentElement?.closest('div[role="article"]')) return

        // 1. Bóc tách nội dung văn bản thực tế của bài viết (bỏ qua rác header nhóm, tác giả, nút like/share)
        let postText = ''
        const cometMsg = postCard.querySelector('div[data-ad-preview="message"], div[data-ad-comet-preview="message"]') as HTMLElement | null
        if (cometMsg) {
          postText = (cometMsg.innerText || cometMsg.textContent || '').trim()
        }

        // Fallback: Nếu không có data-ad-preview (bài nền màu hoặc layout mới của Facebook)
        if (!postText) {
          const bodyCandidates = Array.from(postCard.querySelectorAll('div[dir="auto"], span[dir="auto"]')) as HTMLElement[]
          const chunks: string[] = []
          for (const el of bodyCandidates) {
            // Bỏ qua nếu nằm trong danh sách bình luận (ul, ol) hoặc form nhập cmt
            if (el.closest('ul') || el.closest('ol') || el.closest('form')) continue
            const t = (el.innerText || el.textContent || '').trim()
            if (!t) continue
            // Bỏ qua các nhãn nút tương tác của Facebook
            if (/^(?:thích|bình luận|chia sẻ|gửi|vừa xong|theo dõi|tham gia|\d+\s*(?:giờ|ngày|phút|tháng|năm|h|d|m|tiếng))/i.test(t)) continue
            if (!chunks.includes(t)) chunks.push(t)
          }
          postText = chunks.join('\n').trim()
        }

        // NẾU BÀI VIẾT KHÔNG CÓ NỘI DUNG CHỮ THỰC TẾ (CHỈ ĐĂNG MỖI ẢNH / TỜ RƠI):
        // BỎ QUA NGAY LẬP TỨC!
        const cleanContent = postText.replace(/(Facebook\s*){3,}/gi, ' ').trim()
        if (cleanContent.length < 2) return

        const allLinks = Array.from(postCard.querySelectorAll('a[href]')) as HTMLAnchorElement[]

        let postUrl = ''
        let authorName = 'Thành viên nhóm'
        let authorUrl = ''

        // Tìm link bài viết chuẩn xác (bắt buộc phải có ID bài viết hoặc permalink)
        let postLink = allLinks.find(a =>
          /\/groups\/[^/]+\/(posts|permalink)\/\d+/.test(a.href) && !a.href.includes('comment_id')
        )

        if (!postLink) {
          postLink = allLinks.find(a => a.href.includes('multi_permalinks=') || a.href.includes('story_fbid='))
        }

        if (postLink) {
          const cleanUrlMatch = postLink.href.match(/(https:\/\/[^/]+\/groups\/[^/]+\/(?:posts|permalink)\/\d+)/)
          postUrl = cleanUrlMatch ? cleanUrlMatch[1] : postLink.href.split('&')[0].split('?')[0]
        } else {
          // Fallback 1: Thử lấy link từ nút "Bình luận" (chứa đường dẫn gốc của bài)
          const commentLink = allLinks.find(a => (a.href.includes('comment_id') || a.innerText.toLowerCase().includes('bình luận') || a.innerText.toLowerCase().includes('comment')) && /\/groups\/[^/]+\/(posts|permalink)\/\d+/.test(a.href))
          if (commentLink) {
            const m = commentLink.href.match(/(https:\/\/[^/]+\/groups\/[^/]+\/(?:posts|permalink)\/\d+)/)
            if (m) postUrl = m[1]
          }

          // Fallback 2: Link ở mốc thời gian bài viết (thường chứa link bài gốc)
          if (!postUrl) {
            const timeLink = allLinks.find(a =>
              (a.href.includes('/posts/') || a.href.includes('/permalink/')) &&
              !a.href.includes('/user/') &&
              !a.href.includes('/hashtag/')
            )
            if (timeLink) {
              const m = timeLink.href.match(/(https:\/\/[^/]+\/groups\/[^/]+\/(?:posts|permalink)\/\d+)/)
              if (m) postUrl = m[1]
            }
          }

          // Fallback 3: Kiểm tra các link có chứa query parameter ID bài viết
          if (!postUrl) {
            const storyLink = allLinks.find(a => a.href.includes('story_fbid=') || a.href.includes('fbid='))
            if (storyLink) {
              postUrl = storyLink.href
            }
          }
        }

        // Tìm tác giả
        const authorLink = allLinks.find(a =>
          a.href.includes('/user/') ||
          a.href.includes('profile.php') ||
          a.querySelector('strong') ||
          a.querySelector('h2') ||
          a.querySelector('h3')
        )

        if (authorLink && authorLink.innerText.trim()) {
          authorName = authorLink.innerText.trim()
          authorUrl = authorLink.href.split('?')[0]
        } else {
          const strongTag = postCard.querySelector('strong, h2, h3, b') as HTMLElement | null
          if (strongTag && strongTag.innerText.trim()) {
            authorName = strongTag.innerText.trim()
          }
        }

        // Tìm thời gian đăng bài
        let postTimeText = ''
        if (postLink) {
          postTimeText = (postLink.getAttribute('aria-label') || postLink.innerText || '').trim()
        }
        if (!postTimeText) {
          const timeCandidate = allLinks.find(a =>
            /ngày|giờ|phút|hôm qua|tháng|vừa xong|mins?|hrs?|yesterday|just now/i.test(a.innerText || a.getAttribute('aria-label') || '')
          )
          if (timeCandidate) {
            postTimeText = (timeCandidate.getAttribute('aria-label') || timeCandidate.innerText || '').trim()
          }
        }
        if (!postTimeText) {
          const spans = Array.from(postCard.querySelectorAll('span[dir="auto"], span')) as HTMLElement[]
          const timeSpan = spans.find(s =>
            /(?:^\d+\s*(?:ngày|giờ|phút|h|d|m|w|tuần|tháng)|vừa xong|hôm qua)/i.test(s.innerText.trim())
          )
          if (timeSpan) {
            postTimeText = timeSpan.innerText.trim()
          }
        }
        postTimeText = postTimeText.replace(/[·•🌐\n\r]/g, ' ').replace(/\s+/g, ' ').trim()

        if (!postUrl) {
          postUrl = window.location.href.split('?')[0]
        }
        results.push({ authorName, authorUrl, content: cleanContent, postUrl, postTimeText: postTimeText || undefined })
      })

      return results
    })
  }

  private async extractComments(page: Page): Promise<Array<{ authorName: string; authorUrl?: string; content: string; postUrl: string }>> {
    return page.evaluate(() => {
      const results: Array<{ authorName: string; authorUrl?: string; content: string; postUrl: string }> = []
      const commentNodes = Array.from(document.querySelectorAll('div[role="article"], div[aria-label*="bình luận" i], div[aria-label*="comment" i], ul > li div[dir="auto"]')) as HTMLElement[]

      commentNodes.forEach((node) => {
        // Chỉ lấy article là comment (nằm lồng trong article cha hoặc có nhãn bình luận)
        const isNested = !!node.parentElement?.closest('div[role="article"]')
        const ariaLabel = node.getAttribute('aria-label') || ''
        const isComment = isNested || /bình luận|comment/i.test(ariaLabel) || node.closest('ul') !== null
        if (!isComment) return

        const text = (node.innerText || '').trim()
        if (text.length < 1 || text.length > 500) return

        // Tìm link/tên tác giả bình luận
        const authorLink = node.querySelector('a[href*="/user/"], a[role="link"]') as HTMLAnchorElement | null
        const strongAuthor = node.querySelector('strong, span[dir="auto"]') as HTMLElement | null
        const authorName = authorLink?.innerText?.trim() || strongAuthor?.innerText?.trim() || 'Thành viên'
        const authorUrl = authorLink?.href ? authorLink.href.split('?')[0] : undefined

        // Tìm link bài viết cha
        const parentPost = node.closest('div[aria-posinset]') || node.closest('div[role="feed"] > div')
        let postUrl = location.href
        if (parentPost) {
          const pLink = parentPost.querySelector('a[href*="/posts/"], a[href*="/permalink/"]') as HTMLAnchorElement | null
          if (pLink?.href) {
            const m = pLink.href.match(/(https:\/\/[^/]+\/groups\/[^/]+\/(?:posts|permalink)\/\d+)/)
            postUrl = m ? m[1] : pLink.href.split('?')[0]
          }
        }

        results.push({
          authorName,
          authorUrl,
          content: text,
          postUrl,
        })
      })

      return results
    }).catch(() => [])
  }

  /**
   * Đảm bảo tài khoản đang ở tư cách Cá Nhân (Personal Profile) để quét nhóm và nhắn Messenger
   */
  private async ensurePersonalProfile(page: Page): Promise<boolean> {
    try {
      if (page.isClosed()) return false;
      this.log('👤 Đang kiểm tra để đảm bảo ở tư cách Tài khoản cá nhân...');

      // Thử vào link tạo Page. Nếu đang ở Fanpage, Facebook sẽ báo "Bạn hiện không xem được nội dung này" (This content isn't available)
      await page.goto('https://www.facebook.com/pages/creation/', { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => { });
      await sleep(2500);

      const isPage = await page.getByText(/Bạn hiện không xem được nội dung này|This content isn't available right now/i).isVisible().catch(() => false);

      if (!isPage) {
        this.log('✅ Xác nhận: Đang ở sẵn Tài khoản cá nhân!');
        return true;
      }

      this.log('🔄 Phát hiện đang kẹt ở thân phận Fanpage! Tiến hành tráo đổi về Nick cá nhân...');
      await page.goto('https://www.facebook.com/', { waitUntil: 'domcontentloaded' }).catch(() => { });
      await sleep(3000);

      // Bấm vào Menu Avatar (góc trên cùng bên phải)
      const avatarSelectors = [
        'svg[aria-label="Trang cá nhân của bạn"]',
        'svg[aria-label="Your profile"]',
        'div[aria-label="Tài khoản"][role="button"]',
        'div[aria-label="Account"][role="button"]',
        'div[data-visualcompletion="ignore-dynamic"] image',
        'image'
      ];

      let clicked = false;
      for (const sel of avatarSelectors) {
        const el = page.locator(sel).last();
        if (await el.isVisible().catch(() => false)) {
          const box = await el.boundingBox();
          if (box) {
            await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
            clicked = true;
            break;
          }
        }
      }

      if (!clicked) {
        this.log('⚠️ Không tìm thấy nút Menu Avatar để đổi nick');
        return false;
      }

      await sleep(2500);

      // Khi ở Page, mở Menu ra thì Nick cá nhân chính luôn nằm ở vị trí thứ 2 (dưới tên Page hiện tại)
      const spans = await page.locator('div[role="dialog"] span[dir="auto"], div[role="menu"] span[dir="auto"]').all();
      const valids: any[] = [];
      for (const span of spans) {
        if (await span.isVisible().catch(() => false)) {
          const text = await span.textContent().catch(() => '');
          if (text && text.trim().length > 0 && text.trim().length < 60) {
            const t = text.toLowerCase();
            const isMenu = t.includes('thông báo') || t.includes('cài đặt') || t.includes('đăng xuất') || t.includes('trợ giúp') || t.includes('xem tất cả') || t.includes('quảng cáo');
            const isNotif = /\d+\s*(unseen|notification|update|tin nhắn|thông báo)/i.test(t);
            if (!isMenu && !isNotif) {
              valids.push(span);
            }
          }
        }
      }

      // Lọc trùng
      const uniqueValids: any[] = [];
      const seen = new Set<string>();
      for (const v of valids) {
        const t = (await v.textContent().catch(() => ''))?.trim();
        if (t && !seen.has(t)) {
          seen.add(t);
          uniqueValids.push(v);
        }
      }

      if (uniqueValids.length > 1) {
        const target = uniqueValids[1];
        const targetName = await target.textContent().catch(() => 'Nick cá nhân');
        this.log(`👉 Bấm chọn chuyển sang Nick cá nhân: "${targetName}"...`);
        const box = await target.boundingBox();
        if (box) {
          await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
        } else {
          await target.click({ force: true }).catch(() => { });
        }
        await page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 8000 }).catch(() => { });
        await sleep(5000);
        this.log(`✅ Đã chuyển thành công về Tài khoản cá nhân: "${targetName}"!`);
        return true;
      } else {
        await page.keyboard.press('Escape');
        this.log('⚠️ Không tìm thấy profile Nick cá nhân trong Menu');
      }

      return false;
    } catch (err) {
      console.warn('[Scanner] Lỗi khi đổi về tài khoản cá nhân:', err);
      return false;
    }
  }

  /**
   * Chặn nạp các tài nguyên video, streaming, và file media nặng để khống chế RAM dưới 500MB
   * Vẫn giữ nguyên 100% tài liệu, HTML, scripts, và API fetch để đọc chữ chính xác tuyệt đối.
   */
  private async enableMemorySaver(page: Page): Promise<void> {
    try {
      if (page.isClosed()) return
      await page.route('**/*', (route) => {
        const resourceType = route.request().resourceType()
        const url = route.request().url()
        if (
          resourceType === 'media' ||
          /\.(mp4|webm|m3u8|mp3|ogg|wav)(\?.*)?$/i.test(url) ||
          url.includes('video.xx.fbcdn.net') ||
          url.includes('/video_redirect/') ||
          url.includes('/t39.2365-6/')
        ) {
          return route.abort().catch(() => { })
        }
        return route.continue().catch(() => { })
      })
    } catch {
      // Ignore if route already registered or page navigating
    }
  }

  private emitStatus(): void {
    this.pushEvent('scanner:status', { isRunning: this.isRunning(), scanning: this.cycleInProgress })
  }

  private log(message: string): void {
    console.log(`[Scanner] ${message}`)
    this.pushEvent('scanner:log', { time: new Date().toLocaleTimeString('vi-VN'), message })
  }
}
