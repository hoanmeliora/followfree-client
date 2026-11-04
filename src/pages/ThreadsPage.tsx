import React, { useState, useEffect, useCallback } from 'react';
import './DashboardPage.css';

interface Props {
  addLog?: (msg: string, type: 'info' | 'success' | 'warning' | 'error') => void;
  session?: any;
}

export default function ThreadsPage({ addLog, session }: Props) {
  const [threadsAccounts, setThreadsAccounts] = useState<any[]>([]);
  const [campaigns, setCampaigns] = useState<any[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [isWorkerRunning, setIsWorkerRunning] = useState(false);
  const [statusMsg, setStatusMsg] = useState<{ text: string; type: 'success' | 'error' } | null>(null);

  // Form tuyển dụng (tự động khôi phục từ localStorage nếu đã từng nhập)
  const [scanMode, setScanMode] = useState<'BOTH' | 'SEARCH' | 'FEED'>(() => {
    return (localStorage.getItem('threads_scan_mode') as any) || 'BOTH';
  });
  const [actionType, setActionType] = useState(() => {
    return localStorage.getItem('threads_action_type') || 'RECRUIT_AUTO_REPLY';
  });
  const [isContinuous, setIsContinuous] = useState(() => {
    const saved = localStorage.getItem('threads_is_continuous');
    return saved !== null ? saved === 'true' : true;
  });
  const [keywords, setKeywords] = useState(() => {
    return localStorage.getItem('threads_keywords') || 'quan tâm, ib, inbox, xin jd, apply, cv, còn tuyển, lương, tìm việc, tìm job, part time, làm thêm';
  });
  const [replyTemplate, setReplyTemplate] = useState(() => {
    return (
      localStorage.getItem('threads_reply_template') ||
      '{Dạ chào bạn|Chào bạn|Hi bạn}, bên mình vừa gửi JD chi tiết {qua tin nhắn chờ|vào inbox} cho bạn rồi ạ. Bạn kiểm tra giúp mình nhé!'
    );
  });
  const [replyTemplate2, setReplyTemplate2] = useState(() => {
    return (
      localStorage.getItem('threads_reply_template_2') ||
      ''
    );
  });
  const [dmTemplate, setDmTemplate] = useState(() => {
    return (
      localStorage.getItem('threads_dm_template') ||
      'Chào bạn! Cảm ơn bạn đã quan tâm đến vị trí tuyển dụng bên mình.\n- Vị trí: Nhân viên tư vấn / Tuyển dụng\n- Thu nhập: 8 - 15 triệu / tháng\n- Bạn vui lòng gửi CV hoặc liên hệ Zalo HR: 09xx.xxx.xxx để đặt lịch phỏng vấn nhé!'
    );
  });
  const [targetCount, setTargetCount] = useState<number>(() => {
    const saved = localStorage.getItem('threads_target_count');
    return saved ? Number(saved) : 10;
  });

  // Tự động đồng bộ cấu hình form vào localStorage để không bị mất khi chuyển tab / thoát app
  useEffect(() => {
    try {
      localStorage.setItem('threads_scan_mode', scanMode);
      localStorage.setItem('threads_action_type', actionType);
      localStorage.setItem('threads_is_continuous', String(isContinuous));
      localStorage.setItem('threads_keywords', keywords);
      localStorage.setItem('threads_reply_template', replyTemplate);
      localStorage.setItem('threads_reply_template_2', replyTemplate2);
      localStorage.setItem('threads_dm_template', dmTemplate);
      localStorage.setItem('threads_target_count', String(targetCount));
    } catch (e) {
      console.warn('Lỗi lưu cấu hình Threads vào localStorage:', e);
    }
  }, [scanMode, actionType, isContinuous, keywords, replyTemplate, replyTemplate2, dmTemplate, targetCount]);

  const loadData = useCallback(() => {
    // 1. Lấy danh sách tài khoản Threads
    window.electronAPI?.getAccounts().then((all: any[]) => {
      const filtered = (all || []).filter(a => a.platform === 'THREADS' && a.isManual);
      setThreadsAccounts(filtered);
    }).catch(console.error);

    // 2. Lấy danh sách chiến dịch Threads (kết hợp local campaigns và server campaigns nếu có)
    let localSaved: any[] = [];
    try {
      localSaved = JSON.parse(localStorage.getItem('threads_local_campaigns') || '[]');
    } catch (e) {}

    window.electronAPI?.getCampaigns().then((res: any) => {
      if (res?.success && Array.isArray(res.data)) {
        const serverFiltered = res.data.filter((c: any) => c.platform === 'THREADS');
        const ids = new Set(serverFiltered.map((c: any) => c.id));
        const combined = [...localSaved.filter((c: any) => !ids.has(c.id)), ...serverFiltered];
        setCampaigns(combined);
      } else {
        setCampaigns(localSaved);
      }
    }).catch(() => {
      setCampaigns(localSaved);
    });

    // 3. Lấy trạng thái Worker
    window.electronAPI?.getWorkerStatus?.().then((res: any) => {
      if (res && typeof res.running === 'boolean') {
        setIsWorkerRunning(res.running);
      }
    }).catch(console.error);
  }, []);

  useEffect(() => {
    loadData();

    const onWorkerStatus = (s: any) => {
      if (s && typeof s.running === 'boolean') {
        setIsWorkerRunning(s.running);
      }
    };
    window.electronAPI?.on?.('worker:status', onWorkerStatus);
    return () => {
      window.electronAPI?.off?.('worker:status', onWorkerStatus);
    };
  }, [loadData]);

  // Bật / Dừng Bot Worker
  const handleToggleWorker = async () => {
    if (isWorkerRunning) {
      await window.electronAPI?.stopWorker?.();
      setIsWorkerRunning(false);
      setStatusMsg({ text: '⏹️ Đã dừng Bot Threads.', type: 'error' });
    } else {
      setStatusMsg({ text: '▶️ Đang khởi động Bot Threads...', type: 'success' });
      const targetUrl = scanMode === 'SEARCH' ? 'https://www.threads.net/search' : 'https://www.threads.net';
      let metadata: any = { realActionType: actionType, scanMode, isContinuous };
      if (actionType === 'RECRUIT_AUTO_REPLY') {
        metadata = {
          realActionType: 'RECRUIT_AUTO_REPLY',
          scanMode,
          isContinuous,
          keywords: keywords.split(',').map(k => k.trim()).filter(Boolean),
          replyTemplate,
          replyTemplate2,
          replyTemplates: [replyTemplate, replyTemplate2].filter(t => t && t.trim().length > 0),
          dmTemplate,
        };
      }
      await window.electronAPI?.createLocalCampaign?.({
        platform: 'THREADS',
        actionType: actionType === 'RECRUIT_AUTO_REPLY' ? 'COMMENT' : actionType,
        targetUrl,
        targetCount: Number(targetCount),
        metadata,
      });
      const res = await window.electronAPI?.startWorker?.();
      if (res?.error) {
        setStatusMsg({ text: res.error, type: 'error' });
      } else {
        setIsWorkerRunning(true);
        setStatusMsg({ text: '🟢 Bot đã BẬT! Đang mở Threads thực hiện nhiệm vụ...', type: 'success' });
      }
    }
  };

  // Đăng nhập thêm tài khoản Threads
  const handleLoginThreads = async () => {
    setStatusMsg({ text: 'Đang mở cửa sổ đăng nhập Threads...', type: 'success' });
    try {
      const res = await (window as any).electronAPI?.autoLoginPlatform('THREADS');
      if (res?.success) {
        setStatusMsg({ text: '✅ Đăng nhập Threads thành công!', type: 'success' });
        loadData();
      } else {
        setStatusMsg({ text: res?.error || 'Đăng nhập thất bại hoặc đã đóng cửa sổ.', type: 'error' });
      }
    } catch (err: any) {
      setStatusMsg({ text: err.message, type: 'error' });
    }
  };

  // Mở trình duyệt cho 1 tài khoản
  const handleOpenBrowser = (acc: any) => {
    if ((window as any).electronAPI?.openBrowser) {
      (window as any).electronAPI.openBrowser(acc.id, acc.platform, acc.cookieData);
    }
  };

  // Xóa tài khoản
  const handleRemoveAccount = async (id: string) => {
    if (!confirm('Bạn có chắc muốn xoá tài khoản Threads này?')) return;
    await (window as any).electronAPI?.removeAccount(id);
    loadData();
  };

  // Huỷ / Xoá chiến dịch Threads
  const handleRemoveCampaign = async (id: string, isRunning: boolean) => {
    const confirmMsg = isRunning
      ? 'Bạn có chắc muốn dừng / huỷ chiến dịch này?'
      : 'Bạn có chắc muốn xoá chiến dịch này khỏi danh sách?';
    if (!confirm(confirmMsg)) return;

    try {
      if (id.startsWith('local_')) {
        let existing: any[] = [];
        try {
          existing = JSON.parse(localStorage.getItem('threads_local_campaigns') || '[]');
        } catch (e) {}
        const updated = existing.filter((c: any) => c.id !== id);
        localStorage.setItem('threads_local_campaigns', JSON.stringify(updated));
        setCampaigns(prev => prev.filter(c => c.id !== id));
        setStatusMsg({ text: '✅ Đã xoá chiến dịch Threads thành công!', type: 'success' });
      } else {
        const res = await window.electronAPI?.cancelCampaign?.(id);
        if (res?.error) {
          setStatusMsg({ text: res.error, type: 'error' });
        } else {
          setStatusMsg({ text: res?.message || '✅ Đã xoá / huỷ chiến dịch thành công!', type: 'success' });
          loadData();
        }
      }
    } catch (err: any) {
      setStatusMsg({ text: err.message, type: 'error' });
    }
  };

  // Tạo chiến dịch Tuyển Dụng / Tương tác Threads
  const handleCreateCampaign = async (e: React.FormEvent) => {
    e.preventDefault();

    setIsLoading(true);
    setStatusMsg(null);

    try {
      let serverActionType = 'COMMENT';
      const targetUrl = scanMode === 'SEARCH' ? 'https://www.threads.net/search' : 'https://www.threads.net';
      let metadata: any = { realActionType: actionType, scanMode, isContinuous };

      if (actionType === 'RECRUIT_AUTO_REPLY') {
        serverActionType = 'COMMENT';
        metadata = {
          realActionType: 'RECRUIT_AUTO_REPLY',
          scanMode,
          isContinuous,
          keywords: keywords.split(',').map(k => k.trim()).filter(Boolean),
          replyTemplate,
          replyTemplate2,
          replyTemplates: [replyTemplate, replyTemplate2].filter(t => t && t.trim().length > 0),
          dmTemplate,
        };
      } else if (actionType === 'LIKE') {
        serverActionType = 'LIKE';
      } else if (actionType === 'FOLLOW') {
        serverActionType = 'FOLLOW';
      } else if (actionType === 'REPOST') {
        serverActionType = 'SHARE';
        metadata = { realActionType: 'REPOST', scanMode, isContinuous };
      }

      const campaignId = `local_threads_${Date.now()}`;
      const campaignPayload = {
        id: campaignId,
        platform: 'THREADS',
        actionType: serverActionType,
        targetUrl,
        targetCount: Number(targetCount),
        metadata,
      };

      // 1. Kích hoạt ngay Local Campaign cho Threads để máy chạy tức thì 100% không phụ thuộc server
      await window.electronAPI?.createLocalCampaign?.(campaignPayload);

      // Lưu vào danh sách local campaigns
      const newLocalCamp = {
        ...campaignPayload,
        doneCount: 0,
        status: 'RUNNING',
        createdAt: new Date().toISOString(),
      };
      let existing: any[] = [];
      try {
        existing = JSON.parse(localStorage.getItem('threads_local_campaigns') || '[]');
      } catch (e) {}
      const updated = [newLocalCamp, ...existing.filter((c: any) => c.id !== campaignId).slice(0, 19)];
      localStorage.setItem('threads_local_campaigns', JSON.stringify(updated));
      setCampaigns(updated);

      // 2. Tự động kích hoạt Bot Worker nếu chưa chạy
      if (!isWorkerRunning) {
        await window.electronAPI?.startWorker?.();
        setIsWorkerRunning(true);
      }

      setStatusMsg({ text: '🎉 Đã khởi tạo chiến dịch & kích hoạt Bot! Trình duyệt đang mở Threads để làm việc...', type: 'success' });
      addLog?.('🎉 Đã khởi tạo chiến dịch Threads & kích hoạt Bot!', 'success');

      // 3. Đồng bộ lên server nếu có phiên đăng nhập hợp lệ (tuỳ chọn, không chặn bot)
      window.electronAPI?.createCampaign?.({
        platform: 'THREADS',
        actionType: serverActionType,
        targetUrl,
        targetCount: Number(targetCount),
        metadata,
      }).catch(() => {});
    } catch (err: any) {
      setStatusMsg({ text: err.message, type: 'error' });
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <div className="autopost-container" style={{ padding: '20px', maxWidth: '1200px', margin: '0 auto' }}>
      {/* Header */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '20px' }}>
        <div>
          <h1 style={{ display: 'flex', alignItems: 'center', gap: '10px', fontSize: '24px', margin: 0, color: '#fff' }}>
            <span style={{ fontSize: '30px' }}>🧵</span> Quản Lý Threads & Tuyển Dụng Tự Động
            <span style={{
              display: 'inline-flex',
              alignItems: 'center',
              padding: '2px 10px',
              borderRadius: '12px',
              fontSize: '12px',
              fontWeight: 500,
              background: isWorkerRunning ? 'rgba(46, 204, 113, 0.15)' : 'rgba(231, 76, 60, 0.15)',
              color: isWorkerRunning ? '#2ecc71' : '#e74c3c',
              border: `1px solid ${isWorkerRunning ? '#2ecc71' : '#e74c3c'}`
            }}>
              {isWorkerRunning ? '🟢 Bot Đang Chạy' : '⏸️ Bot Đang Tắt'}
            </span>
          </h1>
          <p style={{ color: '#aaa', margin: '5px 0 0 0', fontSize: '13px' }}>
            Tự động quét bình luận ứng viên theo từ khoá, phản hồi Spin-text chống spam và gửi tin nhắn (DM) trực tiếp.
          </p>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
          <button
            onClick={handleToggleWorker}
            style={{
              background: isWorkerRunning ? '#e74c3c' : '#2ecc71',
              color: '#ffffff',
              border: 'none',
              padding: '10px 18px',
              borderRadius: '6px',
              fontWeight: 'bold',
              cursor: 'pointer',
              display: 'flex',
              alignItems: 'center',
              gap: '8px',
              boxShadow: isWorkerRunning ? '0 2px 10px rgba(231,76,60,0.3)' : '0 2px 10px rgba(46,204,113,0.3)'
            }}
          >
            {isWorkerRunning ? '⏹️ Dừng Bot' : '▶️ Bật Bot Chạy Ngay'}
          </button>
          <button
            onClick={handleLoginThreads}
            style={{
              background: '#ffffff',
              color: '#000000',
              border: 'none',
              padding: '10px 18px',
              borderRadius: '6px',
              fontWeight: 'bold',
              cursor: 'pointer',
              display: 'flex',
              alignItems: 'center',
              gap: '8px',
              boxShadow: '0 2px 10px rgba(255,255,255,0.2)'
            }}
          >
            ➕ Đăng Nhập Nick Threads
          </button>
        </div>
      </div>

      {statusMsg && (
        <div style={{
          padding: '12px 16px',
          borderRadius: '6px',
          marginBottom: '20px',
          background: statusMsg.type === 'success' ? 'rgba(46, 204, 113, 0.15)' : 'rgba(231, 76, 60, 0.15)',
          border: `1px solid ${statusMsg.type === 'success' ? '#2ecc71' : '#e74c3c'}`,
          color: statusMsg.type === 'success' ? '#2ecc71' : '#e74c3c',
          fontWeight: 500
        }}>
          {statusMsg.text}
        </div>
      )}

      {/* Grid 2 cột: Form cài đặt & Quản lý Nick */}
      <div style={{ display: 'grid', gridTemplateColumns: '1.2fr 0.8fr', gap: '20px' }}>
        
        {/* CỘT TRÁI: FORM CẤU HÌNH TUYỂN DỤNG */}
        <div style={{ background: '#1c1c1c', border: '1px solid #333', borderRadius: '8px', padding: '20px' }}>
          <h2 style={{ fontSize: '16px', color: '#ffd700', marginTop: 0, marginBottom: '15px', display: 'flex', alignItems: 'center', gap: '8px' }}>
            🎯 Thiết lập Chiến dịch Tuyển Dụng / Tương Tác
          </h2>

          <form onSubmit={handleCreateCampaign}>
            <div className="form-group" style={{ marginBottom: '15px' }}>
              <label style={{ display: 'block', marginBottom: '6px', fontSize: '13px', color: '#ccc' }}>Hành động</label>
              <select
                value={actionType}
                onChange={e => setActionType(e.target.value)}
                style={{ width: '100%', padding: '10px', background: '#111', border: '1px solid #444', color: '#fff', borderRadius: '4px' }}
              >
                <option value="RECRUIT_AUTO_REPLY">🎯 Tuyển dụng: Quét từ khoá & Auto Reply + DM (Khuyên dùng)</option>
                <option value="LIKE">Thả Tim Thread (2 Xu/lượt)</option>
                <option value="FOLLOW">Follow Profile Threads (4 Xu/lượt)</option>
                <option value="REPOST">Repost / Đăng lại Thread (4 Xu/lượt)</option>
              </select>
            </div>

            <div className="form-group" style={{ marginBottom: '15px' }}>
              <label style={{ display: 'block', marginBottom: '6px', fontSize: '13px', color: '#ccc' }}>
                Nguồn quét & tiếp cận ứng viên
              </label>
              <select
                value={scanMode}
                onChange={e => setScanMode(e.target.value as any)}
                style={{ width: '100%', padding: '10px', background: '#111', border: '1px solid #444', color: '#fff', borderRadius: '4px' }}
              >
                <option value="BOTH">🔥 Kết hợp: Tìm kiếm từ khoá & Lướt Bảng tin (Khuyên dùng)</option>
                <option value="SEARCH">🔍 Tìm kiếm theo từ khoá trên toàn Threads</option>
                <option value="FEED">📰 Tự động lướt Bảng tin (Home Feed) tìm bài viết</option>
              </select>
              <div style={{ fontSize: '11px', color: '#888', marginTop: '4px' }}>
                💡 Bot sẽ tự động điều hướng trên Threads để tìm kiếm và quét bình luận theo từ khoá mà không cần dán link thủ công.
              </div>
            </div>

            {actionType === 'RECRUIT_AUTO_REPLY' && (
              <>
                <div className="form-group" style={{ marginBottom: '15px' }}>
                  <label style={{ display: 'block', marginBottom: '6px', fontSize: '13px', color: '#ffd700', fontWeight: 'bold' }}>
                    Từ khoá nhận diện ứng viên (cách nhau bởi dấu phẩy)
                  </label>
                  <input
                    type="text"
                    value={keywords}
                    onChange={e => setKeywords(e.target.value)}
                    placeholder="quan tâm, ib, inbox, xin jd, apply, cv, còn tuyển"
                    style={{ width: '100%', padding: '10px', background: '#111', border: '1px solid #555', color: '#fff', borderRadius: '4px' }}
                  />
                  <div style={{ fontSize: '11px', color: '#888', marginTop: '4px' }}>
                    Tool sẽ tự động tìm những bình luận chứa các từ khoá này để tương tác.
                  </div>
                </div>

                <div className="form-group" style={{ marginBottom: '15px' }}>
                  <label style={{ display: 'block', marginBottom: '6px', fontSize: '13px', color: '#ffd700', fontWeight: 'bold' }}>
                    Mẫu phản hồi bình luận 1 (Hỗ trợ Spin-text {'{A|B|C}'})
                  </label>
                  <textarea
                    value={replyTemplate}
                    onChange={e => setReplyTemplate(e.target.value)}
                    rows={3}
                    placeholder="Nhập nội dung phản hồi mẫu 1..."
                    style={{ width: '100%', padding: '10px', background: '#111', border: '1px solid #555', color: '#fff', borderRadius: '4px' }}
                  />
                </div>

                <div className="form-group" style={{ marginBottom: '15px' }}>
                  <label style={{ display: 'block', marginBottom: '6px', fontSize: '13px', color: '#ffd700', fontWeight: 'bold' }}>
                    Mẫu phản hồi bình luận 2 (Tự động luân phiên đổi qua lại với Mẫu 1)
                  </label>
                  <textarea
                    value={replyTemplate2}
                    onChange={e => setReplyTemplate2(e.target.value)}
                    rows={3}
                    placeholder="Nhập nội dung phản hồi mẫu 2 (Tuỳ chọn để luân phiên tránh trùng lặp)..."
                    style={{ width: '100%', padding: '10px', background: '#111', border: '1px solid #555', color: '#fff', borderRadius: '4px' }}
                  />
                  <div style={{ fontSize: '11px', color: '#888', marginTop: '4px' }}>
                    💡 Bot sẽ tự động luân phiên đổi qua lại giữa Mẫu 1 và Mẫu 2 khi trả lời các bài viết để chống checkpoint/spam.
                  </div>
                </div>

                <div className="form-group" style={{ marginBottom: '15px' }}>
                  <label style={{ display: 'block', marginBottom: '6px', fontSize: '13px', color: '#ffd700', fontWeight: 'bold' }}>
                    Mẫu tin nhắn gửi riêng (DM) vào hộp thư ứng viên
                  </label>
                  <textarea
                    value={dmTemplate}
                    onChange={e => setDmTemplate(e.target.value)}
                    rows={4}
                    style={{ width: '100%', padding: '10px', background: '#111', border: '1px solid #555', color: '#fff', borderRadius: '4px' }}
                  />
                </div>
              </>
            )}

            {/* Chế độ Quét liên tục 24/7 */}
            <div className="form-group" style={{ marginBottom: '18px', background: 'rgba(255, 215, 0, 0.05)', border: '1px solid rgba(255, 215, 0, 0.25)', padding: '12px 14px', borderRadius: '6px' }}>
              <label style={{ display: 'flex', alignItems: 'center', gap: '10px', cursor: 'pointer', color: '#ffd700', fontWeight: 'bold', fontSize: '13px' }}>
                <input
                  type="checkbox"
                  checked={isContinuous}
                  onChange={e => setIsContinuous(e.target.checked)}
                  style={{ width: '18px', height: '18px', cursor: 'pointer', accentColor: '#ffd700' }}
                />
                ⚡ Chế độ Radar Quét liên tục 24/7 (Săn ứng viên không dừng)
              </label>
              <div style={{ fontSize: '11px', color: '#aaa', marginTop: '6px', marginLeft: '28px', lineHeight: '1.4' }}>
                Bot sẽ giữ trình duyệt mở, liên tục đảo từ khóa và lướt Bảng tin để săn bài thảo luận mới. Nghỉ thông minh giữa các đợt để bảo vệ nick. Chỉ dừng khi bạn bấm <strong>"Dừng Bot"</strong>.
              </div>
            </div>

            <div className="form-group" style={{ marginBottom: '20px' }}>
              <label style={{ display: 'block', marginBottom: '6px', fontSize: '13px', color: '#ccc' }}>
                {isContinuous ? 'Số lượng ứng viên mục tiêu mỗi phiên (Khuyên dùng: 10 - 50)' : 'Số lượng mục tiêu'}
              </label>
              <input
                type="number"
                min="1"
                max="1000"
                value={targetCount}
                onChange={e => setTargetCount(Number(e.target.value))}
                required
                style={{ width: '100%', padding: '10px', background: '#111', border: '1px solid #444', color: '#fff', borderRadius: '4px' }}
              />
            </div>

            <button
              type="submit"
              disabled={isLoading}
              style={{
                width: '100%',
                background: '#ffd700',
                color: '#000',
                border: 'none',
                padding: '12px',
                borderRadius: '6px',
                fontWeight: 'bold',
                fontSize: '15px',
                cursor: isLoading ? 'not-allowed' : 'pointer'
              }}
            >
              {isLoading ? '⏳ Đang khởi tạo...' : '🚀 Bắt Đầu Chiến Dịch Threads'}
            </button>
          </form>
        </div>

        {/* CỘT PHẢI: QUẢN LÝ TÀI KHOẢN THREADS */}
        <div>
          <div style={{ background: '#1c1c1c', border: '1px solid #333', borderRadius: '8px', padding: '20px', marginBottom: '20px' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '15px' }}>
              <h2 style={{ fontSize: '16px', color: '#fff', margin: 0 }}>
                👤 Tài Khoản Threads ({threadsAccounts.length})
              </h2>
              <button
                onClick={loadData}
                style={{ background: 'transparent', border: '1px solid #555', color: '#aaa', padding: '4px 8px', borderRadius: '4px', cursor: 'pointer', fontSize: '12px' }}
              >
                🔄 Làm mới
              </button>
            </div>

            {threadsAccounts.length === 0 ? (
              <div style={{ textAlign: 'center', padding: '30px 10px', color: '#777' }}>
                <div style={{ fontSize: '32px', marginBottom: '10px' }}>🧵</div>
                <p style={{ margin: 0 }}>Chưa có tài khoản Threads nào.</p>
                <p style={{ fontSize: '12px', marginTop: '6px' }}>Bấm nút <strong>"➕ Đăng Nhập Nick Threads"</strong> ở góc phải trên để thêm nick.</p>
              </div>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: '10px', maxHeight: '350px', overflowY: 'auto' }}>
                {threadsAccounts.map(acc => (
                  <div key={acc.id} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', background: '#111', padding: '10px 12px', borderRadius: '6px', border: '1px solid #2a2a2a' }}>
                    <div>
                      <div style={{ fontWeight: 'bold', color: '#fff', fontSize: '14px' }}>{acc.username || 'Tài khoản Threads'}</div>
                      <div style={{ fontSize: '11px', color: acc.status === 'ACTIVE' ? '#2ecc71' : '#e74c3c', marginTop: '2px' }}>
                        {acc.status === 'ACTIVE' ? '🟢 Đang hoạt động' : '🔴 Checkpoint / Lỗi'}
                      </div>
                    </div>
                    <div style={{ display: 'flex', gap: '6px' }}>
                      <button
                        onClick={() => handleOpenBrowser(acc)}
                        style={{ background: '#333', color: '#fff', border: 'none', padding: '6px 10px', borderRadius: '4px', fontSize: '12px', cursor: 'pointer' }}
                        title="Mở trình duyệt xem nick"
                      >
                        🌐 Mở
                      </button>
                      <button
                        onClick={() => handleRemoveAccount(acc.id)}
                        style={{ background: 'rgba(231, 76, 60, 0.2)', color: '#e74c3c', border: 'none', padding: '6px 10px', borderRadius: '4px', fontSize: '12px', cursor: 'pointer' }}
                        title="Xoá tài khoản này"
                      >
                        🗑️
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* Danh sách chiến dịch Threads */}
          <div style={{ background: '#1c1c1c', border: '1px solid #333', borderRadius: '8px', padding: '20px' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '15px' }}>
              <h2 style={{ fontSize: '16px', color: '#fff', margin: 0 }}>
                📊 Chiến Dịch Threads Gần Đây ({campaigns.length})
              </h2>
              <button
                onClick={loadData}
                style={{ background: 'transparent', border: '1px solid #555', color: '#aaa', padding: '4px 8px', borderRadius: '4px', cursor: 'pointer', fontSize: '12px' }}
              >
                🔄 Làm mới
              </button>
            </div>

            {campaigns.length === 0 ? (
              <p style={{ color: '#777', fontSize: '13px', margin: 0 }}>Chưa có chiến dịch Threads nào được tạo.</p>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: '10px', maxHeight: '280px', overflowY: 'auto' }}>
                {campaigns.map(camp => {
                  const isRunning = camp.status === 'RUNNING';
                  const isCompleted = camp.status === 'COMPLETED';
                  const statusLabel = isRunning ? '🟢 Đang chạy' : isCompleted ? '⭐ Đã xong' : '⚪ Đã huỷ';
                  const borderColor = isRunning ? '#ffd700' : isCompleted ? '#2ecc71' : '#555';

                  return (
                    <div
                      key={camp.id}
                      style={{
                        background: '#111',
                        padding: '10px 12px',
                        borderRadius: '6px',
                        borderLeft: `3px solid ${borderColor}`,
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'space-between',
                        gap: '10px'
                      }}
                    >
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                          <span style={{ fontWeight: 'bold', fontSize: '13px', color: '#fff' }}>
                            {camp.metadata?.realActionType || camp.actionType}
                          </span>
                          <span style={{ fontSize: '11px', color: '#ffd700', fontWeight: 'bold' }}>
                            {camp.doneCount || 0} / {camp.targetCount}
                          </span>
                        </div>
                        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: '4px', gap: '8px' }}>
                          <span style={{ fontSize: '11px', color: '#888', textOverflow: 'ellipsis', overflow: 'hidden', whiteSpace: 'nowrap' }}>
                            {camp.targetUrl}
                          </span>
                          <span style={{ fontSize: '10px', color: isRunning ? '#2ecc71' : isCompleted ? '#3498db' : '#888', flexShrink: 0 }}>
                            {statusLabel}
                          </span>
                        </div>
                      </div>

                      <button
                        onClick={() => handleRemoveCampaign(camp.id, isRunning)}
                        style={{
                          background: 'rgba(231, 76, 60, 0.15)',
                          border: '1px solid rgba(231, 76, 60, 0.4)',
                          color: '#e74c3c',
                          padding: '6px 10px',
                          borderRadius: '4px',
                          fontSize: '12px',
                          cursor: 'pointer',
                          flexShrink: 0,
                          display: 'flex',
                          alignItems: 'center',
                          gap: '4px'
                        }}
                        title={isRunning ? 'Huỷ chiến dịch và hoàn xu thừa' : 'Xoá chiến dịch này khỏi danh sách'}
                      >
                        🗑️
                      </button>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        </div>

      </div>
    </div>
  );
}

