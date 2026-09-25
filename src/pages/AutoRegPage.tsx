import React, { useState, useEffect, useRef } from 'react';

const AutoRegPage: React.FC<{ goToAccounts?: () => void }> = ({ goToAccounts }) => {
  const [domain, setDomain] = useState(() => {
    const saved = localStorage.getItem('autoreg_domain');
    return saved === 'hethongcaynicksieutoc.com' ? '' : (saved || '');
  });
  const [count, setCount] = useState(() => {
    const saved = localStorage.getItem('autoreg_count');
    return saved ? Number(saved) : 2;
  });
  const [delay, setDelay] = useState(() => {
    const saved = localStorage.getItem('autoreg_delay');
    return saved ? Number(saved) : 60;
  });
  const [proxy, setProxy] = useState(() => localStorage.getItem('autoreg_proxy') || '');
  const [platform, setPlatform] = useState(() => localStorage.getItem('autoreg_platform') || 'facebook');
  
  const [status, setStatus] = useState('idle');
  const [progress, setProgress] = useState(0);
  const [logs, setLogs] = useState<string[]>(['[Hệ thống] Đang ở trạng thái chờ lệnh...']);
  
  const [gmailAccounts, setGmailAccounts] = useState<any[]>([]);
  const [selectedGmailId, setSelectedGmailId] = useState<string>('');
  
  // Lưu trạng thái vào localStorage mỗi khi thay đổi
  useEffect(() => {
    localStorage.setItem('autoreg_domain', domain);
    localStorage.setItem('autoreg_count', count.toString());
    localStorage.setItem('autoreg_delay', delay.toString());
    localStorage.setItem('autoreg_proxy', proxy);
    localStorage.setItem('autoreg_platform', platform);
    localStorage.setItem('autoreg_gmail_id', selectedGmailId);
  }, [domain, count, delay, proxy, platform, selectedGmailId]);

  const logEndRef = useRef<HTMLDivElement>(null);

  // Auto-scroll to bottom of logs
  useEffect(() => {
    logEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [logs]);

  // Lắng nghe Log từ Electron
  useEffect(() => {
    const handleLog = (_e: any, logMsg: string) => {
      setLogs(prev => [...prev, `[${new Date().toLocaleTimeString()}] ${logMsg}`]);
      // Cập nhật tiến độ nếu có thông báo nick thứ mấy
      const match = logMsg.match(/Đang tạo nick thứ (\d+)\/(\d+)/);
      if (match) {
        setProgress(Math.round((parseInt(match[1]) / parseInt(match[2])) * 100));
      }
      if (logMsg.includes('Đã hoàn thành mẻ đăng ký') || logMsg.includes('Đã dừng hệ thống')) {
        setStatus('idle');
      }
      
      // Chỉ cộng dồn giới hạn 2 nick/ngày khi có 1 nick được TẠO THÀNH CÔNG THỰC SỰ
      if (logMsg.includes('THÀNH CÔNG! Đã đăng ký thành công UID')) {
        const today = new Date().toISOString().split('T')[0];
        const dailyDataStr = localStorage.getItem('autoreg_daily_data');
        let currentCount = 0;
        if (dailyDataStr) {
          try {
             const parsed = JSON.parse(dailyDataStr);
             if (parsed.date === today) currentCount = parsed.count;
          } catch(e){}
        }
        localStorage.setItem('autoreg_daily_data', JSON.stringify({
           date: today,
           count: currentCount + 1
        }));
      }
    };

    if ((window as any).electronAPI && (window as any).electronAPI.onAutoRegLog) {
      const cleanup = (window as any).electronAPI.onAutoRegLog(handleLog);
      return cleanup;
    }
  }, []);

  const loadData = async () => {
    const data = await (window as any).electronAPI.getAccounts();
    const gmails = data.filter((a: any) => a.platform === 'GMAIL' || a.platform === 'GMAIL_OAUTH');
    setGmailAccounts(gmails);
    const savedId = localStorage.getItem('autoreg_gmail_id');
    if (savedId && gmails.find((g: any) => g.id === savedId)) {
      setSelectedGmailId(savedId);
    } else if (!selectedGmailId && gmails.length > 0) {
      setSelectedGmailId(gmails[0].id);
    }
  };

  useEffect(() => {
    loadData();
    // Lắng nghe sự kiện thêm Gmail từ màn hình Accounts
    const onAddGmail = () => {
      loadData();
    };
    window.addEventListener('gmail-added', onAddGmail);
    return () => window.removeEventListener('gmail-added', onAddGmail);
  }, []);

  const handleLoginGmailOAuth = async () => {
    const res = await (window as any).electronAPI?.loginGmailOAuth();
    if (res?.success) {
      await loadData();
      alert('Đã kết nối Gmail qua API thành công!');
    } else {
      if (res?.error) alert('Lỗi kết nối: ' + res.error);
    }
  };

  const handleStartReg = async () => {
    if (!platform) return;
    
    if (count > 2) {
      alert("⚠️ Khuyến cáo an toàn: Ngài chỉ nên tạo TỐI ĐA 2 tài khoản mỗi lần chạy để tránh bị Facebook khóa dải mạng gốc (IP/Mac).");
      return;
    }

    // Kiểm tra giới hạn 2 tài khoản 1 ngày
    const today = new Date().toISOString().split('T')[0];
    const dailyDataStr = localStorage.getItem('autoreg_daily_data');
    let currentDailyCount = 0;
    
    if (dailyDataStr) {
      try {
        const dailyData = JSON.parse(dailyDataStr);
        if (dailyData.date === today) {
           currentDailyCount = dailyData.count;
        }
      } catch(e){}
    }

    if (currentDailyCount + count > 2) {
      alert(`⚠️ Giới hạn hệ thống: Hôm nay ngài đã tạo ${currentDailyCount}/2 tài khoản. Ngài chỉ có thể tạo thêm tối đa ${2 - currentDailyCount} tài khoản trong hôm nay. Hãy quay lại vào ngày mai!`);
      return;
    }
    
    if (delay < 60) {
      alert("⚠️ Hành vi con người: Hãy để Delay tối thiểu 60 giây (1 phút) giữa các lần tạo nick để hệ thống của Facebook không phát hiện ra Bot!");
      return;
    }

    if (platform === 'facebook' && !selectedGmailId) {
      setLogs(prev => [...prev, '[Lỗi] Bắt buộc phải chọn 1 tài khoản Gmail (để làm Phôi hoặc làm Hòm Thư Nhận Mã OTP)!']);
      return;
    }

    // Tạm thời không cộng dồn ở đây, chỉ lưu lại ngày để kiểm tra
    localStorage.setItem('autoreg_daily_data_date_only', JSON.stringify({
       date: today
    }));

    setStatus('running');
    setProgress(0);
    setLogs(['[Hệ thống] Đang chuẩn bị dữ liệu gửi tới máy chủ...']);
      
    try {
      if ((window as any).electronAPI) {
        await (window as any).electronAPI.autoRegStart({
          domain,
          count,
          delay,
          proxy,
          platform,
          gmailList: gmailAccounts,
          selectedGmailId: selectedGmailId
        });
      } else {
        throw new Error('electronAPI không tồn tại, bạn đang chạy trên trình duyệt?');
      }
    } catch (err: any) {
      console.error(err);
      setLogs(prev => [...prev, `[Lỗi] ${err.message}`]);
      setStatus('idle');
    }
  };

  const handleStopReg = async () => {
    setLogs(prev => [...prev, '[Hệ thống] Gửi lệnh dừng khẩn cấp...']);
    try {
      if ((window as any).electronAPI) {
        await (window as any).electronAPI.autoRegStop();
      }
      setStatus('idle');
    } catch (err) {
      console.error(err);
    }
  };

  return (
    <div style={{ display: 'flex', gap: '20px' }}>
      {/* CỘT TRÁI: CẤU HÌNH */}
      <div style={{ flex: 1, background: '#0f3460', padding: '30px', borderRadius: '8px' }}>
        <h2 style={{ marginTop: 0, color: '#e94560', borderBottom: '1px solid #1a1a2e', paddingBottom: '10px' }}>⚙️ Cấu Hình Đăng Ký</h2>
        
        <div style={{ marginBottom: '15px' }}>
          <label style={{ display: 'block', marginBottom: '5px', color: '#ccc' }}>Nền Tảng Đăng Ký</label>
          <select value={platform} onChange={(e) => setPlatform(e.target.value)}
            style={{ width: '100%', padding: '10px', borderRadius: '4px', border: '1px solid #444', background: '#16213e', color: '#fff', appearance: 'menulist' }}>
            <option value="facebook">📘 Facebook</option>
            <option value="gmail">📧 Gmail (Google)</option>
            <option value="youtube">▶️ YouTube</option>
            <option value="tiktok">🎵 TikTok</option>
          </select>
        </div>

        {platform !== 'youtube' && (
          <>
            <div style={{ marginBottom: '15px' }}>
              <label style={{ display: 'block', marginBottom: '5px', color: '#ccc' }}>Chọn Gmail Clone</label>
              <div style={{ display: 'flex', gap: '10px', alignItems: 'center' }}>
                <select value={selectedGmailId} onChange={(e) => setSelectedGmailId(e.target.value)}
                  style={{ flex: 1, padding: '10px', borderRadius: '4px', border: '1px solid #444', background: '#16213e', color: '#fff', appearance: 'menulist' }}>
                  {gmailAccounts.length === 0 && <option value="">(Chưa có Gmail nào)</option>}
                  {gmailAccounts.map(g => (
                    <option key={g.id} value={g.id}>{g.username}</option>
                  ))}
                </select>
                <button type="button" onClick={() => {
                  const selectedAcc = gmailAccounts.find(g => g.id === selectedGmailId);
                  if (selectedAcc) {
                    (window as any).electronAPI.openBrowser({
                      id: selectedAcc.id,
                      platform: selectedAcc.platform,
                      cookieStr: selectedAcc.cookieData || ''
                    });
                  } else {
                    alert('Vui lòng chọn 1 tài khoản Gmail!');
                  }
                }} 
                  title="Mở trình duyệt xem hộp thư"
                  style={{ background: '#00b894', color: '#fff', border: 'none', padding: '10px 15px', borderRadius: '4px', cursor: 'pointer', fontWeight: 'bold', display: 'flex', alignItems: 'center', gap: '5px' }}>
                  📬 Mở Thư
                </button>
                <button type="button" onClick={handleLoginGmailOAuth} 
                  title="Thêm Gmail mới qua API"
                  style={{ background: '#ea4335', color: '#fff', border: 'none', padding: '10px 15px', borderRadius: '4px', cursor: 'pointer', fontWeight: 'bold', display: 'flex', alignItems: 'center', gap: '5px' }}>
                  🚀 Thêm Gmail
                </button>
              </div>
              {platform === 'facebook' && (
                <div style={{ margin: '10px 0 0 0', fontSize: '12px', color: '#fdcb6e', fontStyle: 'italic', lineHeight: '1.5', background: 'rgba(253, 203, 110, 0.1)', padding: '10px', borderRadius: '4px', borderLeft: '3px solid #fdcb6e' }}>
                  <strong>💡 Khuyến nghị An Toàn (Đọc kỹ):</strong>
                  <ul style={{ margin: '5px 0 0 0', paddingLeft: '18px' }}>
                    <li style={{ marginBottom: '3px' }}><strong>Mẹo Dấu Chấm:</strong> 1 Gmail chỉ nên tạo tối đa 3 tài khoản Facebook để tránh bị khóa chùm.</li>
                    <li style={{ marginBottom: '3px' }}><strong>Dùng Wifi nhà (IPv6):</strong> Tối đa 2 nick/ngày. Hệ thống đã khóa giới hạn để bảo vệ dàn IP của ngài khỏi nguy cơ bị quét dải mạng.</li>
                    <li><strong>Phát Wifi từ Điện Thoại (Khuyên dùng):</strong> Cực kỳ an toàn! Mạng 4G khó bị Facebook phát hiện hơn Wifi cố định. Hãy bật chế độ máy bay 5s trước khi chạy Tool để có một IP mới tinh!</li>
                  </ul>
                </div>
              )}
            </div>

          {/* TẠM ẨN TÍNH NĂNG TÊN MIỀN CATCH-ALL THEO YÊU CẦU
            <div style={{ marginBottom: '15px' }}>
              <label style={{ display: 'block', marginBottom: '5px', color: '#ccc' }}>Tên miền Catch-All (Tùy chọn nâng cao)</label>
              <input type="text" value={domain} onChange={(e) => setDomain(e.target.value)} placeholder="Để trống nếu muốn dùng Mẹo Dấu Chấm (Dot Trick)"
                style={{ width: '100%', padding: '10px', borderRadius: '4px', border: '1px solid #444', background: '#16213e', color: '#fff' }} />
              <p style={{ margin: '5px 0 0 0', fontSize: '12px', color: '#888' }}>Nếu dùng Tên miền (Catch-All), ngài <strong>VẪN PHẢI</strong> chọn 1 Gmail ở trên. Đảm bảo tên miền đã được trỏ (Email Routing) về Gmail đó để Tool có thể đọc được mã OTP!</p>
            </div>
          */}
          </>
        )}

        {platform === 'youtube' && (
          <div style={{ marginBottom: '15px', padding: '10px', background: 'rgba(233, 69, 96, 0.1)', borderLeft: '4px solid #e94560', borderRadius: '4px' }}>
            <p style={{ color: '#e94560', margin: 0, fontSize: '14px' }}>
              ⚠️ Đang kích hoạt <strong>Kịch bản Đánh Du Kích (Hit & Run)</strong> đâm mù Google để tạo Gmail không cần SĐT. <br/>
              Chế độ này sẽ liên tục xoay vòng IPv6 và Fake Device. Tỷ lệ thành công cực thấp (chỉ dùng để cắm máy rảnh rỗi).
            </p>
          </div>
        )}

        <div style={{ marginBottom: '15px' }}>
          <label style={{ display: 'block', marginBottom: '5px', color: '#ccc' }}>Số lượng nick muốn tạo (Tối đa 2)</label>
          <input type="number" min="1" max="2" value={count} onChange={(e) => setCount(Number(e.target.value))}
            style={{ width: '100%', padding: '10px', borderRadius: '4px', border: '1px solid #444', background: '#16213e', color: '#fff' }} />
        </div>

        <div style={{ marginBottom: '15px' }}>
          <label style={{ display: 'block', marginBottom: '5px', color: '#ccc' }}>Delay nghỉ giữa 2 nick (Giây) - Tối thiểu 60s</label>
          <input type="number" min="60" value={delay} onChange={(e) => setDelay(Number(e.target.value))}
            style={{ width: '100%', padding: '10px', borderRadius: '4px', border: '1px solid #444', background: '#16213e', color: '#fff' }} />
        </div>

        <div style={{ marginBottom: '25px' }}>
          <label style={{ display: 'block', marginBottom: '5px', color: '#ccc' }}>API Key Proxy (TMProxy, Tinsoft...) - Tùy chọn</label>
          <input type="text" value={proxy} onChange={(e) => setProxy(e.target.value)} placeholder="Để trống nếu muốn dùng IP hiện tại"
            style={{ width: '100%', padding: '10px', borderRadius: '4px', border: '1px solid #444', background: '#16213e', color: '#fff' }} />
        </div>

        <div style={{ display: 'flex', gap: '10px' }}>
          <button onClick={handleStartReg} disabled={status === 'running'}
            style={{ flex: 1, background: status === 'running' ? '#555' : '#00b894', color: '#fff', border: 'none', padding: '15px', borderRadius: '5px', fontWeight: 'bold', cursor: status === 'running' ? 'not-allowed' : 'pointer', fontSize: '16px' }}>
            {status === 'running' ? '⏳ Đang Tạo...' : '🚀 Bắt Đầu Reg Hàng Loạt'}
          </button>
          
          <button onClick={handleStopReg} disabled={status === 'idle'}
            style={{ flex: 1, background: status === 'idle' ? '#555' : '#d63031', color: '#fff', border: 'none', padding: '15px', borderRadius: '5px', fontWeight: 'bold', cursor: status === 'idle' ? 'not-allowed' : 'pointer', fontSize: '16px' }}>
            ⏹️ Dừng Khẩn Cấp
          </button>
        </div>
      </div>

      {/* CỘT PHẢI: LIVE CONSOLE */}
      <div style={{ flex: 1, background: '#000', padding: '20px', borderRadius: '8px', display: 'flex', flexDirection: 'column', border: '1px solid #333' }}>
        <h3 style={{ marginTop: 0, color: '#00cec9', display: 'flex', justifyContent: 'space-between' }}>
          <span>💻 Live Console</span>
          <span>{progress}%</span>
        </h3>
        
        {/* Progress bar */}
        <div style={{ width: '100%', height: '8px', background: '#333', borderRadius: '4px', marginBottom: '15px', overflow: 'hidden' }}>
          <div style={{ width: `${progress}%`, height: '100%', background: '#00cec9', transition: 'width 0.5s' }}></div>
        </div>

        {/* Terminal logs */}
        <div style={{ flex: 1, overflowY: 'auto', fontFamily: 'monospace', color: '#a29bfe', fontSize: '13px', lineHeight: '1.6' }}>
          {logs.map((log, i) => (
            <div key={i} style={{ marginBottom: '5px', color: log.includes('Lỗi') ? '#ff7675' : log.includes('Thành công') ? '#55efc4' : '#a29bfe' }}>
              {log}
            </div>
          ))}
          <div ref={logEndRef} />
        </div>
      </div>
    </div>
  );
};

export default AutoRegPage;
