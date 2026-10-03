import React, { useState, useEffect } from 'react';
import './DashboardPage.css';

interface Props {
  addLog: (msg: string, type: 'info' | 'success' | 'warning' | 'error') => void;
  session: any;
}

export default function AutoPostPage({ addLog, session }: Props) {
  const [mode, setMode] = useState<'SHARE' | 'POST'>(() => (localStorage.getItem('autopost_mode') as any) || 'POST');
  const [groupIds, setGroupIds] = useState(() => localStorage.getItem('autopost_groupIds') || '');
  const [interval, setIntervalTime] = useState(() => localStorage.getItem('autopost_interval') || '60');
  const [content1, setContent1] = useState(() => localStorage.getItem('autopost_content1') || '');
  const [content2, setContent2] = useState(() => localStorage.getItem('autopost_content2') || '');
  const [content3, setContent3] = useState(() => localStorage.getItem('autopost_content3') || '');
  const [images, setImages] = useState<Array<{ path: string, preview: string }>>(() => {
    try {
      const stored = localStorage.getItem('autopost_images');
      const parsed = stored ? JSON.parse(stored) : [];
      // Khôi phục bộ lọc: Chỉ giữ lại ảnh nếu có path (dùng App)
      return Array.isArray(parsed) ? parsed.filter((img: any) => img && img.path && img.path.trim().length > 0) : [];
    } catch { return []; }
  });
  const [targetUrl, setTargetUrl] = useState(() => localStorage.getItem('autopost_targetUrl') || '');
  const [statusMsg, setStatusMsg] = useState<{text: string, type: 'success' | 'error'} | null>(null);

  useEffect(() => {
    localStorage.setItem('autopost_mode', mode);
    localStorage.setItem('autopost_groupIds', groupIds);
    localStorage.setItem('autopost_interval', interval);
    localStorage.setItem('autopost_content1', content1);
    localStorage.setItem('autopost_content2', content2);
    localStorage.setItem('autopost_content3', content3);
    localStorage.setItem('autopost_images', JSON.stringify(images));
    localStorage.setItem('autopost_targetUrl', targetUrl);
  }, [mode, groupIds, interval, content1, content2, content3, images, targetUrl]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setStatusMsg(null);
    const groups = groupIds.split('\n').map(g => g.trim()).filter(g => g);
    if (groups.length === 0) return alert('Vui lòng nhập ít nhất 1 Group ID');

    const metadata: any = {
      schedule: {
        interval: parseInt(interval) || 60,
        groupIds: groups,
        type: mode
      }
    };

    if (mode === 'POST') {
      const validImages = images.map(img => img.path).filter(p => p && p.trim().length > 0);
      const finalContent = [content1, content2, content3].filter(c => c.trim().length > 0).join(' | ');
      
      if (!finalContent.trim() && validImages.length === 0) {
        return alert('Vui lòng nhập nội dung bài đăng hoặc chọn ít nhất 1 ảnh hợp lệ!');
      }
      metadata.postData = { content: finalContent, imageUrls: validImages };
    }

    try {
      const res = await window.electronAPI?.createCampaign({
        platform: 'FACEBOOK',
        actionType: mode === 'POST' ? 'POST_GROUP' : 'SHARE_GROUP',
        targetUrl: mode === 'POST' ? 'AUTO_POST' : targetUrl,
        targetCount: mode === 'POST' ? Math.ceil(groups.length / 3) : groups.length,
        metadata
      });

      if (res?.error) {
        addLog(`❌ Lỗi: ${res.error}`, 'error');
        setStatusMsg({ text: `Lỗi: ${res.error}`, type: 'error' });
      } else {
        addLog(`✅ Đã lên lịch thành công cho ${groups.length} nhóm!`, 'success');
        setStatusMsg({ text: `Đã lên lịch thành công cho ${groups.length} nhóm! Cứ mỗi ${interval} phút Bot sẽ chạy 1 lần.`, type: 'success' });
        // Khởi chạy thành công không xóa form để lưu lại cho lần sau
      }
    } catch (err: any) {
      addLog(`❌ Lỗi hệ thống: ${err.message}`, 'error');
      setStatusMsg({ text: `Lỗi hệ thống: ${err.message}`, type: 'error' });
    }
  };

  return (
    <div className="accounts-section" style={{ maxWidth: '800px', margin: '0 auto', padding: '10px' }}>
      <div className="section-header" style={{ textAlign: 'center', marginBottom: '30px' }}>
        <h2 style={{ fontSize: '24px', background: 'linear-gradient(135deg, var(--accent-light), #a78bfa)', WebkitBackgroundClip: 'text', WebkitTextFillColor: 'transparent' }}>
          <span style={{ WebkitTextFillColor: 'initial', filter: 'drop-shadow(0 0 10px var(--accent))' }}>🔄</span> Tự Động Đăng Bài / Lên Lịch Nhóm
        </h2>
        <p className="section-desc">Hệ thống sẽ tự động giao việc cho Bot chạy lặp lại theo chu kỳ hẹn giờ.</p>
      </div>
      
      <form onSubmit={handleSubmit} style={{ 
        display: 'flex', flexDirection: 'column', gap: '20px', 
        background: 'var(--bg-card)', padding: '30px', borderRadius: 'var(--radius)', 
        border: '1px solid var(--border)', boxShadow: '0 10px 30px rgba(0,0,0,0.5)'
      }}>
        
        {/* Toggle Mode */}
        <div style={{ display: 'flex', gap: '10px', background: 'var(--bg-primary)', padding: '6px', borderRadius: 'var(--radius-sm)' }}>
          <button 
            type="button"
            onClick={() => setMode('POST')}
            style={{
              flex: 1, padding: '10px', border: 'none', borderRadius: '6px', cursor: 'pointer',
              fontWeight: 600, fontSize: '14px', transition: 'all 0.2s',
              background: mode === 'POST' ? 'var(--accent)' : 'transparent',
              color: mode === 'POST' ? '#fff' : 'var(--text-secondary)',
              boxShadow: mode === 'POST' ? '0 4px 12px var(--accent-glow)' : 'none'
            }}
          >
            📝 Đăng Bài Mới (VIP)
          </button>
          <button 
            type="button"
            onClick={() => setMode('SHARE')}
            style={{
              flex: 1, padding: '10px', border: 'none', borderRadius: '6px', cursor: 'pointer',
              fontWeight: 600, fontSize: '14px', transition: 'all 0.2s',
              background: mode === 'SHARE' ? 'var(--accent)' : 'transparent',
              color: mode === 'SHARE' ? '#fff' : 'var(--text-secondary)',
              boxShadow: mode === 'SHARE' ? '0 4px 12px var(--accent-glow)' : 'none'
            }}
          >
            🔁 Share Bài Cũ
          </button>
        </div>

        {mode === 'SHARE' ? (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
            <label style={{ fontSize: '13px', fontWeight: 500, color: 'var(--text-secondary)' }}>🔗 Link Bài Viết (Cần Share):</label>
            <input 
              type="text" 
              value={targetUrl} 
              onChange={e => setTargetUrl(e.target.value)} 
              placeholder="https://facebook.com/..." 
              required 
              style={{
                width: '100%', padding: '12px 14px', background: 'var(--bg-primary)',
                border: '1px solid var(--border)', borderRadius: 'var(--radius-sm)',
                color: 'var(--text-primary)', fontSize: '14px', outline: 'none'
              }}
            />
          </div>
        ) : (
          <>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
              <label style={{ fontSize: '13px', fontWeight: 500, color: 'var(--text-secondary)' }}>📝 Nội dung bài viết (Spintax - Sẽ chọn ngẫu nhiên 1 trong 3 nội dung khi đăng):</label>
              
              <textarea 
                rows={3}
                value={content1} 
                onChange={e => setContent1(e.target.value)} 
                placeholder="Nhập nội dung 1..." 
                style={{
                  width: '100%', padding: '12px 14px', background: 'var(--bg-primary)',
                  border: '1px solid var(--border)', borderRadius: 'var(--radius-sm)',
                  color: 'var(--text-primary)', fontSize: '14px', outline: 'none', resize: 'vertical'
                }}
              />
              
              <textarea 
                rows={3}
                value={content2} 
                onChange={e => setContent2(e.target.value)} 
                placeholder="Nhập nội dung 2 (tuỳ chọn)..." 
                style={{
                  width: '100%', padding: '12px 14px', background: 'var(--bg-primary)',
                  border: '1px solid var(--border)', borderRadius: 'var(--radius-sm)',
                  color: 'var(--text-primary)', fontSize: '14px', outline: 'none', resize: 'vertical',
                  marginTop: '4px'
                }}
              />
              
              <textarea 
                rows={3}
                value={content3} 
                onChange={e => setContent3(e.target.value)} 
                placeholder="Nhập nội dung 3 (tuỳ chọn)..." 
                style={{
                  width: '100%', padding: '12px 14px', background: 'var(--bg-primary)',
                  border: '1px solid var(--border)', borderRadius: 'var(--radius-sm)',
                  color: 'var(--text-primary)', fontSize: '14px', outline: 'none', resize: 'vertical',
                  marginTop: '4px'
                }}
              />
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
              <label style={{ fontSize: '13px', fontWeight: 500, color: 'var(--text-secondary)' }}>🖼️ Chọn Ảnh đính kèm (Có thể chọn nhiều ảnh):</label>
              <div style={{ display: 'flex', gap: '10px', alignItems: 'center' }}>
                <button 
                  type="button" 
                  onClick={async () => {
                    const result = await (window as any).electronAPI?.selectFiles();
                    if (result && !result.canceled && result.filePaths) {
                      const newImages = result.filePaths.map((path: string) => ({
                        path,
                        preview: `file://${path}`
                      }));
                      setImages((prev: any) => [...prev, ...newImages]);
                    }
                  }}
                  style={{
                    flex: 1, padding: '10px 14px', background: 'var(--bg-primary)',
                    border: '1px solid var(--border)', borderRadius: 'var(--radius-sm)',
                    color: 'var(--text-primary)', fontSize: '14px', outline: 'none',
                    cursor: 'pointer', textAlign: 'left'
                  }}
                >
                  📁 Bấm vào đây để chọn ảnh...
                </button>
                {images.length > 0 && (
                  <button 
                    type="button" 
                    onClick={() => setImages([])}
                    style={{ padding: '10px 15px', background: 'rgba(239, 68, 68, 0.15)', color: '#ef4444', border: '1px solid rgba(239, 68, 68, 0.3)', borderRadius: 'var(--radius-sm)', cursor: 'pointer' }}
                  >
                    Xóa hết
                  </button>
                )}
              </div>
              
              {/* Image Preview Grid */}
              {images.length > 0 && (
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: '10px', marginTop: '10px' }}>
                  {images.map((img, idx) => (
                    <div key={idx} style={{ position: 'relative', width: '90px', height: '90px', borderRadius: '8px', overflow: 'hidden', border: '1px solid var(--border)', background: 'var(--bg-secondary)', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', padding: '5px' }}>
                      
                      <span style={{ fontSize: '24px', marginBottom: '5px' }}>🖼️</span>
                      <div style={{ fontSize: '10px', textAlign: 'center', wordBreak: 'break-all', color: 'var(--accent)', fontWeight: 500 }}>
                        {img.path ? img.path.split(/[/\\]/).pop() : 'Ảnh'}
                      </div>
                      
                      <button 
                        type="button"
                        onClick={() => setImages(prev => prev.filter((_, i) => i !== idx))}
                        style={{ position: 'absolute', top: '2px', right: '2px', background: 'rgba(239, 68, 68, 0.9)', color: '#fff', border: 'none', borderRadius: '50%', width: '20px', height: '20px', fontSize: '10px', cursor: 'pointer' }}
                      >
                        ✕
                      </button>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </>
        )}

        <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
          <label style={{ fontSize: '13px', fontWeight: 500, color: 'var(--text-secondary)' }}>👥 Danh sách UID/Link Nhóm (Mỗi nhóm 1 dòng):</label>
          <textarea 
            rows={5}
            value={groupIds} 
            onChange={e => setGroupIds(e.target.value)} 
            placeholder="Ví dụ:&#10;https://www.facebook.com/groups/123456789&#10;https://www.facebook.com/groups/987654321" 
            required 
            style={{
              width: '100%', padding: '12px 14px', background: 'var(--bg-primary)',
              border: '1px solid var(--border)', borderRadius: 'var(--radius-sm)',
              color: 'var(--text-primary)', fontSize: '14px', outline: 'none', resize: 'vertical',
              fontFamily: 'monospace'
            }}
          />
        </div>

        <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
          <label style={{ fontSize: '13px', fontWeight: 500, color: 'var(--text-secondary)' }}>⏳ Tần suất lặp lại (Tính bằng Phút):</label>
          <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
            <input 
              type="number" 
              value={interval} 
              onChange={e => setIntervalTime(e.target.value)} 
              min="5" 
              required 
              style={{
                width: '120px', padding: '12px 14px', background: 'var(--bg-primary)',
                border: '1px solid var(--border)', borderRadius: 'var(--radius-sm)',
                color: 'var(--text-primary)', fontSize: '16px', fontWeight: 'bold', outline: 'none'
              }}
            />
            <span style={{ fontSize: '12px', color: 'var(--text-muted)' }}>Ví dụ: 60 = Đăng 1 lần mỗi 1 tiếng</span>
          </div>
        </div>

        {statusMsg && (
          <div style={{
            padding: '12px 16px', borderRadius: 'var(--radius-sm)',
            background: statusMsg.type === 'success' ? 'rgba(34, 211, 160, 0.15)' : 'rgba(239, 68, 68, 0.15)',
            border: `1px solid ${statusMsg.type === 'success' ? 'rgba(34, 211, 160, 0.4)' : 'rgba(239, 68, 68, 0.4)'}`,
            color: statusMsg.type === 'success' ? 'var(--success)' : '#fca5a5',
            fontWeight: 500, fontSize: '14px', display: 'flex', alignItems: 'center', gap: '8px',
            marginTop: '10px'
          }}>
            <span>{statusMsg.type === 'success' ? '✅' : '❌'}</span>
            {statusMsg.text}
          </div>
        )}

        <button 
          type="submit" 
          style={{
            marginTop: '10px', padding: '14px', background: 'linear-gradient(135deg, var(--accent), #a78bfa)',
            border: 'none', borderRadius: 'var(--radius-sm)', color: '#fff', fontSize: '15px', fontWeight: 600,
            cursor: 'pointer', boxShadow: '0 4px 20px var(--accent-glow)', transition: 'all 0.2s', display: 'flex', justifyContent: 'center', alignItems: 'center', gap: '8px'
          }}
          onMouseOver={(e) => e.currentTarget.style.transform = 'translateY(-2px)'}
          onMouseOut={(e) => e.currentTarget.style.transform = 'translateY(0)'}
        >
          🚀 Kích Hoạt Lịch Trình (Miễn Phí)
        </button>
      </form>
    </div>
  );
}
