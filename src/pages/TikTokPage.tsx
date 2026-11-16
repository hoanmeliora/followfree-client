import React, { useState, useEffect, useCallback } from 'react';
import './DashboardPage.css';

interface Props {
  addLog?: (msg: string, type: 'info' | 'success' | 'warning' | 'error') => void;
  session?: any;
}

export default function TikTokPage({ addLog, session }: Props) {
  const [tiktokAccounts, setTiktokAccounts] = useState<any[]>([]);
  const [campaigns, setCampaigns] = useState<any[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [isWorkerRunning, setIsWorkerRunning] = useState(false);
  const [statusMsg, setStatusMsg] = useState<{ text: string; type: 'success' | 'error' } | null>(null);

  // Modal nạp danh sách tài khoản hàng loạt
  const [showBatchModal, setShowBatchModal] = useState(false);
  const [batchInput, setBatchInput] = useState('');

  // Form cấu hình chiến dịch TikTok
  const [actionType, setActionType] = useState<'FOLLOW' | 'LIKE' | 'VIEW_VIDEO' | 'VIEW_LIVE' | 'NURTURE'>(() => {
    return (localStorage.getItem('tiktok_action_type') as any) || 'FOLLOW';
  });
  const [targetUrl, setTargetUrl] = useState(() => {
    return localStorage.getItem('tiktok_target_url') || '';
  });
  const [targetCount, setTargetCount] = useState<number>(() => {
    const saved = localStorage.getItem('tiktok_target_count');
    return saved ? Number(saved) : 50;
  });
  const [watchDurationSeconds, setWatchDurationSeconds] = useState<number>(() => {
    const saved = localStorage.getItem('tiktok_watch_duration');
    return saved ? Number(saved) : 15;
  });
  const [liveDurationMinutes, setLiveDurationMinutes] = useState<number>(() => {
    const saved = localStorage.getItem('tiktok_live_duration');
    return saved ? Number(saved) : 5;
  });

  // Tự động lưu form vào localStorage
  useEffect(() => {
    try {
      localStorage.setItem('tiktok_action_type', actionType);
      localStorage.setItem('tiktok_target_url', targetUrl);
      localStorage.setItem('tiktok_target_count', String(targetCount));
      localStorage.setItem('tiktok_watch_duration', String(watchDurationSeconds));
      localStorage.setItem('tiktok_live_duration', String(liveDurationMinutes));
    } catch (e) {
      console.warn('Lỗi lưu cấu hình TikTok vào localStorage:', e);
    }
  }, [actionType, targetUrl, targetCount, watchDurationSeconds, liveDurationMinutes]);

  const loadData = useCallback(() => {
    // 1. Lấy danh sách tài khoản TikTok
    window.electronAPI?.getAccounts().then((all: any[]) => {
      const filtered = (all || []).filter(a => a.platform === 'TIKTOK');
      setTiktokAccounts(filtered);
    }).catch(console.error);

    // 2. Lấy danh sách chiến dịch TikTok
    let localSaved: any[] = [];
    try {
      localSaved = JSON.parse(localStorage.getItem('tiktok_local_campaigns') || '[]');
    } catch (e) {}

    window.electronAPI?.getCampaigns().then((res: any) => {
      if (res?.success && Array.isArray(res.data)) {
        const serverFiltered = res.data.filter((c: any) => c.platform === 'TIKTOK');
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
      setStatusMsg({ text: '⏹️ Đã dừng Bot TikTok.', type: 'error' });
      addLog?.('⏹️ Đã dừng Bot TikTok.', 'warning');
    } else {
      setStatusMsg({ text: '▶️ Đang khởi động Bot TikTok...', type: 'success' });
      addLog?.('▶️ Đang khởi động Bot TikTok...', 'info');

      const res = await window.electronAPI?.startWorker?.();
      if (res?.error) {
        setStatusMsg({ text: res.error, type: 'error' });
        addLog?.(`❌ Lỗi bật Bot: ${res.error}`, 'error');
      } else {
        setIsWorkerRunning(true);
        setStatusMsg({ text: '🟢 Bot TikTok đã BẬT và đang chạy nhiệm vụ!', type: 'success' });
        addLog?.('🟢 Bot TikTok đã BẬT thành công!', 'success');
      }
    }
  };

  // Đăng nhập nick TikTok thủ công
  const handleLoginTikTok = async () => {
    setStatusMsg({ text: 'Đang mở cửa sổ đăng nhập TikTok...', type: 'success' });
    try {
      const res = await (window as any).electronAPI?.autoLoginPlatform('TIKTOK');
      if (res?.success) {
        setStatusMsg({ text: '✅ Đăng nhập TikTok thành công!', type: 'success' });
        addLog?.('✅ Đăng nhập TikTok thành công!', 'success');
        loadData();
      } else {
        setStatusMsg({ text: res?.error || 'Đăng nhập thất bại hoặc đã đóng cửa sổ.', type: 'error' });
      }
    } catch (err: any) {
      setStatusMsg({ text: err.message, type: 'error' });
    }
  };

  // Nạp hàng loạt tài khoản TikTok (Định dạng: user|pass|cookie hoặc cookie)
  const handleImportBatch = async () => {
    if (!batchInput.trim()) {
      alert('Vui lòng dán danh sách tài khoản TikTok vào ô nhập!');
      return;
    }

    const lines = batchInput.split('\n').map(l => l.trim()).filter(Boolean);
    let successCount = 0;

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const parts = line.split('|');

      let username = `TikTok_${Date.now()}_${i + 1}`;
      let cookieData = '';

      if (parts.length >= 3) {
        username = parts[0].trim();
        cookieData = parts.slice(2).join('|').trim();
      } else if (parts.length === 2) {
        username = parts[0].trim();
        cookieData = parts[1].trim();
      } else {
        cookieData = line;
      }

      if (cookieData) {
        try {
          await (window as any).electronAPI?.addAccount({
            platform: 'TIKTOK',
            username,
            cookieData,
            status: 'ACTIVE',
            isManual: true,
          });
          successCount++;
        } catch (e) {
          console.warn('Lỗi thêm nick:', e);
        }
      }
    }

    setShowBatchModal(false);
    setBatchInput('');
    setStatusMsg({ text: `✅ Đã nạp thành công ${successCount}/${lines.length} tài khoản TikTok!`, type: 'success' });
    addLog?.(`✅ Đã nạp thành công ${successCount} tài khoản TikTok vào hệ thống!`, 'success');
    loadData();
  };

  // Mở trình duyệt kiểm tra nick
  const handleOpenBrowser = (acc: any) => {
    if ((window as any).electronAPI?.openBrowser) {
      (window as any).electronAPI.openBrowser(acc.id, acc.platform, acc.cookieData);
    }
  };

  // Xóa tài khoản
  const handleRemoveAccount = async (id: string) => {
    if (!confirm('Bạn có chắc muốn xoá tài khoản TikTok này?')) return;
    await (window as any).electronAPI?.removeAccount(id);
    loadData();
  };

  // Huỷ / Xoá chiến dịch
  const handleRemoveCampaign = async (id: string, isRunning: boolean) => {
    const confirmMsg = isRunning
      ? 'Bạn có chắc muốn dừng / huỷ chiến dịch này?'
      : 'Bạn có chắc muốn xoá chiến dịch này khỏi danh sách?';
    if (!confirm(confirmMsg)) return;

    try {
      if (id.startsWith('local_')) {
        let existing: any[] = [];
        try {
          existing = JSON.parse(localStorage.getItem('tiktok_local_campaigns') || '[]');
        } catch (e) {}
        const updated = existing.filter((c: any) => c.id !== id);
        localStorage.setItem('tiktok_local_campaigns', JSON.stringify(updated));
        setCampaigns(prev => prev.filter(c => c.id !== id));
        setStatusMsg({ text: '✅ Đã xoá chiến dịch TikTok thành công!', type: 'success' });
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

  // Tạo chiến dịch TikTok
  const handleCreateCampaign = async (e: React.FormEvent) => {
    e.preventDefault();

    if (actionType !== 'NURTURE' && !targetUrl.trim()) {
      alert('Vui lòng nhập Link mục tiêu TikTok!');
      return;
    }

    setIsLoading(true);
    setStatusMsg(null);

    try {
      const metadata: any = {
        realActionType: actionType,
        durationSeconds: watchDurationSeconds,
        liveDurationSeconds: liveDurationMinutes * 60,
      };

      const finalTargetUrl = actionType === 'NURTURE' ? 'https://www.tiktok.com/foryou' : targetUrl.trim();

      const campaignId = `local_tiktok_${Date.now()}`;
      const campaignPayload = {
        id: campaignId,
        platform: 'TIKTOK',
        actionType: actionType === 'NURTURE' ? 'VIEW_VIDEO' : actionType,
        targetUrl: finalTargetUrl,
        targetCount: Number(targetCount),
        metadata,
        status: 'RUNNING',
        doneCount: 0,
        createdAt: new Date().toISOString(),
      };

      // Lưu local campaigns
      let localSaved: any[] = [];
      try {
        localSaved = JSON.parse(localStorage.getItem('tiktok_local_campaigns') || '[]');
      } catch (err) {}
      localSaved.unshift(campaignPayload);
      localStorage.setItem('tiktok_local_campaigns', JSON.stringify(localSaved));

      await window.electronAPI?.createLocalCampaign?.(campaignPayload);

      setStatusMsg({ text: `🎉 Đã kích hoạt chiến dịch ${actionType} thành công cho ${targetCount} lượt!`, type: 'success' });
      addLog?.(`🎉 Kích hoạt chiến dịch TikTok ${actionType} thành công!`, 'success');

      // Tự động kích hoạt bot nếu chưa bật
      if (!isWorkerRunning) {
        await window.electronAPI?.startWorker?.();
        setIsWorkerRunning(true);
      }

      loadData();
    } catch (err: any) {
      setStatusMsg({ text: err.message || 'Lỗi khi tạo chiến dịch TikTok', type: 'error' });
    } finally {
      setIsLoading(false);
    }
  };

  const getTargetUrlPlaceholder = () => {
    switch (actionType) {
      case 'FOLLOW':
        return 'https://www.tiktok.com/@username (Link kênh cần buff follow)';
      case 'LIKE':
        return 'https://www.tiktok.com/@user/video/123456789... (Link video cần thả tim)';
      case 'VIEW_VIDEO':
        return 'https://www.tiktok.com/@user/video/123456789... (Link video cần cày view)';
      case 'VIEW_LIVE':
        return 'https://www.tiktok.com/@user/live (Link livestream cần buff mắt)';
      case 'NURTURE':
        return 'https://www.tiktok.com/foryou (Tự động lướt For You nuôi dàn nick)';
    }
  };

  return (
    <div style={{ background: '#ffffff', color: '#111827', minHeight: '100%', padding: '24px', fontFamily: 'inherit' }}>
      {/* HEADER */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '24px', borderBottom: '1px solid #e5e7eb', paddingBottom: '16px' }}>
        <div>
          <h1 style={{ fontSize: '24px', fontWeight: 700, margin: '0 0 6px 0', color: '#111827', display: 'flex', alignItems: 'center', gap: '8px' }}>
            <span>🎵</span> TikTok Automation & Buff Center
          </h1>
          <p style={{ color: '#4b5563', fontSize: '14px', margin: 0 }}>
            Quản lý dàn nick TikTok, tự động buff Follow, Thả tim, Cày view video, Buff mắt livestream và nuôi nick tự động.
          </p>
        </div>

        <div style={{ display: 'flex', gap: '10px' }}>
          <button
            onClick={() => setShowBatchModal(true)}
            style={{
              background: '#0284c7',
              color: '#ffffff',
              border: 'none',
              padding: '10px 16px',
              borderRadius: '6px',
              cursor: 'pointer',
              fontWeight: 600,
              fontSize: '13px',
              display: 'flex',
              alignItems: 'center',
              gap: '6px',
              boxShadow: '0 1px 2px rgba(0,0,0,0.05)'
            }}
          >
            📋 Nạp hàng loạt (50+ nick)
          </button>
          <button
            onClick={handleLoginTikTok}
            style={{
              background: '#111827',
              color: '#ffffff',
              border: 'none',
              padding: '10px 16px',
              borderRadius: '6px',
              cursor: 'pointer',
              fontWeight: 600,
              fontSize: '13px',
              display: 'flex',
              alignItems: 'center',
              gap: '6px',
              boxShadow: '0 1px 2px rgba(0,0,0,0.05)'
            }}
          >
            ➕ Đăng nhập thủ công
          </button>
        </div>
      </div>

      {/* THANH ĐIỀU KHIỂN TRẠNG THÁI BOT WORKER */}
      <div style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        padding: '14px 20px',
        background: isWorkerRunning ? '#f0fdf4' : '#fef2f2',
        border: `1px solid ${isWorkerRunning ? '#bbf7d0' : '#fecaca'}`,
        borderRadius: '8px',
        marginBottom: '24px',
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
          <div style={{
            width: '12px',
            height: '12px',
            borderRadius: '50%',
            background: isWorkerRunning ? '#16a34a' : '#dc2626',
            boxShadow: isWorkerRunning ? '0 0 8px #16a34a' : 'none'
          }} />
          <div>
            <div style={{ fontWeight: 700, fontSize: '15px', color: isWorkerRunning ? '#15803d' : '#b91c1c' }}>
              Trạng thái Bot Worker: {isWorkerRunning ? 'ĐANG CHẠY NHIỆM VỤ' : 'ĐANG DỪNG'}
            </div>
            <div style={{ fontSize: '12px', color: '#4b5563', marginTop: '2px' }}>
              {isWorkerRunning
                ? 'Bot đang xoay vòng các tài khoản TikTok để thực hiện chiến dịch theo lịch.'
                : 'Bấm nút bên phải để bắt đầu chạy tự động hoá TikTok.'}
            </div>
          </div>
        </div>

        <button
          onClick={handleToggleWorker}
          style={{
            background: isWorkerRunning ? '#dc2626' : '#16a34a',
            color: '#fff',
            border: 'none',
            padding: '10px 22px',
            borderRadius: '6px',
            fontWeight: 700,
            fontSize: '14px',
            cursor: 'pointer',
            boxShadow: '0 2px 4px rgba(0,0,0,0.1)'
          }}
        >
          {isWorkerRunning ? '⏹️ DỪNG BOT TIKTOK' : '▶️ BẮT ĐẦU BOT TIKTOK'}
        </button>
      </div>

      {/* THÔNG BÁO STATUS */}
      {statusMsg && (
        <div style={{
          padding: '12px 16px',
          borderRadius: '6px',
          marginBottom: '20px',
          fontSize: '14px',
          fontWeight: 500,
          background: statusMsg.type === 'success' ? '#ecfdf5' : '#fef2f2',
          color: statusMsg.type === 'success' ? '#065f46' : '#991b1b',
          border: `1px solid ${statusMsg.type === 'success' ? '#a7f3d0' : '#fecaca'}`,
        }}>
          {statusMsg.text}
        </div>
      )}

      {/* MODAL NẠP HÀNG LOẠT NICK */}
      {showBatchModal && (
        <div style={{
          position: 'fixed',
          top: 0, left: 0, right: 0, bottom: 0,
          background: 'rgba(0, 0, 0, 0.5)',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          zIndex: 9999,
        }}>
          <div style={{
            background: '#ffffff',
            borderRadius: '10px',
            padding: '24px',
            width: '540px',
            maxWidth: '90%',
            boxShadow: '0 20px 25px -5px rgba(0, 0, 0, 0.1)',
            border: '1px solid #e5e7eb',
          }}>
            <h2 style={{ fontSize: '18px', fontWeight: 700, margin: '0 0 10px 0', color: '#111827' }}>
              📋 Nạp Hàng Loạt Tài Khoản TikTok (50+ nick)
            </h2>
            <p style={{ fontSize: '13px', color: '#4b5563', margin: '0 0 14px 0' }}>
              Dán danh sách tài khoản theo định dạng: <br />
              <code style={{ background: '#f3f4f6', padding: '2px 6px', borderRadius: '4px', color: '#db2777' }}>username|password|cookie</code> hoặc <code style={{ background: '#f3f4f6', padding: '2px 6px', borderRadius: '4px', color: '#db2777' }}>cookie</code> (mỗi dòng 1 nick).
            </p>

            <textarea
              rows={8}
              value={batchInput}
              onChange={(e) => setBatchInput(e.target.value)}
              placeholder={`user1|pass1|sessionid=xxxx; ...\nuser2|pass2|sessionid=yyyy; ...`}
              style={{
                width: '100%',
                padding: '12px',
                border: '1px solid #d1d5db',
                borderRadius: '6px',
                fontSize: '13px',
                fontFamily: 'monospace',
                boxSizing: 'border-box',
                marginBottom: '16px',
              }}
            />

            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '10px' }}>
              <button
                onClick={() => setShowBatchModal(false)}
                style={{
                  background: '#f3f4f6',
                  color: '#374151',
                  border: '1px solid #d1d5db',
                  padding: '8px 16px',
                  borderRadius: '6px',
                  cursor: 'pointer',
                  fontWeight: 600,
                  fontSize: '13px'
                }}
              >
                Hủy
              </button>
              <button
                onClick={handleImportBatch}
                style={{
                  background: '#111827',
                  color: '#ffffff',
                  border: 'none',
                  padding: '8px 18px',
                  borderRadius: '6px',
                  cursor: 'pointer',
                  fontWeight: 600,
                  fontSize: '13px'
                }}
              >
                Xác nhận nạp nick
              </button>
            </div>
          </div>
        </div>
      )}

      {/* BỐ CỤC 2 CỘT */}
      <div style={{ display: 'grid', gridTemplateColumns: '1.2fr 1fr', gap: '24px', alignItems: 'start' }}>
        {/* CỘT TRÁI: FORM CẤU HÌNH CHIẾN DỊCH TIKTOK */}
        <div style={{ background: '#ffffff', border: '1px solid #e5e7eb', borderRadius: '10px', padding: '24px', boxShadow: '0 1px 3px rgba(0,0,0,0.05)' }}>
          <h2 style={{ fontSize: '18px', fontWeight: 700, margin: '0 0 16px 0', color: '#111827', display: 'flex', alignItems: 'center', gap: '8px' }}>
            <span>⚡</span> Cấu Hình Chiến Dịch TikTok
          </h2>

          <form onSubmit={handleCreateCampaign}>
            {/* 1. Chọn loại hành động */}
            <div style={{ marginBottom: '16px' }}>
              <label style={{ display: 'block', fontSize: '13px', fontWeight: 600, color: '#374151', marginBottom: '6px' }}>
                Loại hành động TikTok:
              </label>
              <select
                value={actionType}
                onChange={(e) => setActionType(e.target.value as any)}
                style={{ width: '100%', padding: '10px 12px', background: '#ffffff', border: '1px solid #d1d5db', color: '#111827', borderRadius: '6px', fontSize: '14px', fontWeight: 500 }}
              >
                <option value="FOLLOW">👤 Buff Follow Kênh (Tăng người theo dõi)</option>
                <option value="LIKE">❤️ Buff Tim Video (Tăng lượt thích)</option>
                <option value="VIEW_VIDEO">👁️ Cày Lượt Xem Video (Buff View Video)</option>
                <option value="VIEW_LIVE">🔴 Buff Mắt Xem Livestream (Giữ mắt & Tap tim)</option>
                <option value="NURTURE">🌾 Nuôi Nick Tự Động (Lướt For You Page & Tương tác)</option>
              </select>
            </div>

            {/* 2. Link mục tiêu */}
            {actionType !== 'NURTURE' && (
              <div style={{ marginBottom: '16px' }}>
                <label style={{ display: 'block', fontSize: '13px', fontWeight: 600, color: '#374151', marginBottom: '6px' }}>
                  Link mục tiêu TikTok (Kênh / Video / Live):
                </label>
                <input
                  type="text"
                  value={targetUrl}
                  onChange={(e) => setTargetUrl(e.target.value)}
                  placeholder={getTargetUrlPlaceholder()}
                  style={{ width: '100%', padding: '10px 12px', background: '#ffffff', border: '1px solid #d1d5db', color: '#111827', borderRadius: '6px', fontSize: '13px', boxSizing: 'border-box' }}
                />
              </div>
            )}

            {/* 3. Số lượng mục tiêu */}
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '16px', marginBottom: '16px' }}>
              <div>
                <label style={{ display: 'block', fontSize: '13px', fontWeight: 600, color: '#374151', marginBottom: '6px' }}>
                  Số lượt mục tiêu:
                </label>
                <input
                  type="number"
                  min={1}
                  value={targetCount}
                  onChange={(e) => setTargetCount(Number(e.target.value))}
                  style={{ width: '100%', padding: '10px 12px', background: '#ffffff', border: '1px solid #d1d5db', color: '#111827', borderRadius: '6px', fontSize: '14px', boxSizing: 'border-box' }}
                />
              </div>

              {actionType === 'VIEW_VIDEO' && (
                <div>
                  <label style={{ display: 'block', fontSize: '13px', fontWeight: 600, color: '#374151', marginBottom: '6px' }}>
                    Thời gian xem mỗi video (giây):
                  </label>
                  <input
                    type="number"
                    min={5}
                    value={watchDurationSeconds}
                    onChange={(e) => setWatchDurationSeconds(Number(e.target.value))}
                    style={{ width: '100%', padding: '10px 12px', background: '#ffffff', border: '1px solid #d1d5db', color: '#111827', borderRadius: '6px', fontSize: '14px', boxSizing: 'border-box' }}
                  />
                </div>
              )}

              {actionType === 'VIEW_LIVE' && (
                <div>
                  <label style={{ display: 'block', fontSize: '13px', fontWeight: 600, color: '#374151', marginBottom: '6px' }}>
                    Thời gian giữ mắt Live (phút):
                  </label>
                  <input
                    type="number"
                    min={1}
                    value={liveDurationMinutes}
                    onChange={(e) => setLiveDurationMinutes(Number(e.target.value))}
                    style={{ width: '100%', padding: '10px 12px', background: '#ffffff', border: '1px solid #d1d5db', color: '#111827', borderRadius: '6px', fontSize: '14px', boxSizing: 'border-box' }}
                  />
                </div>
              )}
            </div>

            {/* Mẹo an toàn */}
            <div style={{ background: '#f8fafc', border: '1px solid #e2e8f0', borderRadius: '6px', padding: '12px 14px', marginBottom: '20px', fontSize: '12px', color: '#64748b', lineHeight: 1.5 }}>
              💡 <strong>Cơ chế xoay vòng an toàn:</strong> Bot sẽ tự động mở 2–3 nick mỗi lượt để tương tác, kèm độ trễ ngẫu nhiên 3–8 giây giống người thật. Máy tính chạy nhẹ êm và bảo vệ dàn nick không bị khoá.
            </div>

            <button
              type="submit"
              disabled={isLoading}
              style={{
                width: '100%',
                padding: '12px',
                background: '#ff0050',
                color: '#ffffff',
                border: 'none',
                borderRadius: '6px',
                fontSize: '15px',
                fontWeight: 700,
                cursor: isLoading ? 'not-allowed' : 'pointer',
                boxShadow: '0 2px 4px rgba(255, 0, 80, 0.2)',
                transition: 'all 0.2s',
              }}
            >
              {isLoading ? '⏳ Đang khởi tạo...' : '🚀 Kích Hoạt Chiến Dịch TikTok'}
            </button>
          </form>
        </div>

        {/* CỘT PHẢI: QUẢN LÝ DÀN NICK & CHIẾN DỊCH GẦN ĐÂY */}
        <div>
          {/* 1. DANH SÁCH TÀI KHOẢN TIKTOK */}
          <div style={{ background: '#ffffff', border: '1px solid #e5e7eb', borderRadius: '10px', padding: '20px', marginBottom: '20px', boxShadow: '0 1px 3px rgba(0,0,0,0.05)' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '14px' }}>
              <h2 style={{ fontSize: '16px', fontWeight: 700, color: '#111827', margin: 0 }}>
                👤 Dàn Nick TikTok ({tiktokAccounts.length})
              </h2>
              <button
                onClick={loadData}
                style={{ background: '#f3f4f6', border: '1px solid #d1d5db', color: '#4b5563', padding: '4px 10px', borderRadius: '4px', cursor: 'pointer', fontSize: '12px' }}
              >
                🔄 Làm mới
              </button>
            </div>

            {tiktokAccounts.length === 0 ? (
              <div style={{ textAlign: 'center', padding: '30px 10px', color: '#9ca3af' }}>
                <div style={{ fontSize: '32px', marginBottom: '8px' }}>🎵</div>
                <p style={{ margin: 0, fontSize: '14px', color: '#4b5563' }}>Chưa có tài khoản TikTok nào trong hệ thống.</p>
                <p style={{ fontSize: '12px', marginTop: '4px', color: '#6b7280' }}>
                  Bấm nút <strong>"📋 Nạp hàng loạt"</strong> ở góc trên để dán 50 nick clone hoặc bấm <strong>"➕ Đăng nhập thủ công"</strong>.
                </p>
              </div>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: '8px', maxHeight: '300px', overflowY: 'auto' }}>
                {tiktokAccounts.map((acc) => (
                  <div key={acc.id} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', background: '#f9fafb', padding: '10px 12px', borderRadius: '6px', border: '1px solid #e5e7eb' }}>
                    <div>
                      <div style={{ fontWeight: 600, color: '#111827', fontSize: '13px' }}>{acc.username || 'Tài khoản TikTok'}</div>
                      <div style={{ fontSize: '11px', color: acc.status === 'ACTIVE' ? '#16a34a' : '#dc2626', marginTop: '2px' }}>
                        {acc.status === 'ACTIVE' ? '🟢 Hoạt động' : '🔴 Checkpoint / Lỗi'}
                      </div>
                    </div>

                    <div style={{ display: 'flex', gap: '6px' }}>
                      <button
                        onClick={() => handleOpenBrowser(acc)}
                        style={{ background: '#e5e7eb', color: '#1f2937', border: 'none', padding: '5px 8px', borderRadius: '4px', fontSize: '11px', cursor: 'pointer', fontWeight: 500 }}
                        title="Mở trình duyệt xem nick"
                      >
                        🌐 Mở
                      </button>
                      <button
                        onClick={() => handleRemoveAccount(acc.id)}
                        style={{ background: '#fee2e2', color: '#dc2626', border: 'none', padding: '5px 8px', borderRadius: '4px', fontSize: '11px', cursor: 'pointer', fontWeight: 500 }}
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

          {/* 2. CHIẾN DỊCH GẦN ĐÂY */}
          <div style={{ background: '#ffffff', border: '1px solid #e5e7eb', borderRadius: '10px', padding: '20px', boxShadow: '0 1px 3px rgba(0,0,0,0.05)' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '14px' }}>
              <h2 style={{ fontSize: '16px', fontWeight: 700, color: '#111827', margin: 0 }}>
                📊 Chiến Dịch TikTok ({campaigns.length})
              </h2>
              <button
                onClick={loadData}
                style={{ background: '#f3f4f6', border: '1px solid #d1d5db', color: '#4b5563', padding: '4px 10px', borderRadius: '4px', cursor: 'pointer', fontSize: '12px' }}
              >
                🔄 Làm mới
              </button>
            </div>

            {campaigns.length === 0 ? (
              <p style={{ color: '#9ca3af', fontSize: '13px', margin: 0 }}>Chưa có chiến dịch TikTok nào được kích hoạt.</p>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: '8px', maxHeight: '250px', overflowY: 'auto' }}>
                {campaigns.map((c) => {
                  const isRunning = c.status === 'RUNNING';
                  const isDone = c.status === 'COMPLETED';
                  const statusLabel = isRunning ? '🟢 Đang chạy' : isDone ? '⭐ Đã xong' : '⚪ Đã huỷ';

                  return (
                    <div key={c.id} style={{
                      background: '#f9fafb',
                      padding: '10px 12px',
                      borderRadius: '6px',
                      borderLeft: `3px solid ${isRunning ? '#ff0050' : isDone ? '#16a34a' : '#9ca3af'}`,
                      border: '1px solid #e5e7eb',
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'space-between',
                      gap: '10px',
                    }}>
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                          <span style={{ fontWeight: 600, fontSize: '13px', color: '#111827' }}>
                            {c.metadata?.realActionType || c.actionType}
                          </span>
                          <span style={{ fontSize: '11px', color: '#d97706', fontWeight: 700 }}>
                            {c.doneCount || 0} / {c.targetCount}
                          </span>
                        </div>
                        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: '4px', gap: '8px' }}>
                          <span style={{ fontSize: '11px', color: '#6b7280', textOverflow: 'ellipsis', overflow: 'hidden', whiteSpace: 'nowrap' }}>
                            {c.targetUrl}
                          </span>
                          <span style={{ fontSize: '10px', color: isRunning ? '#16a34a' : isDone ? '#2563eb' : '#6b7280', flexShrink: 0 }}>
                            {statusLabel}
                          </span>
                        </div>
                      </div>

                      <button
                        onClick={() => handleRemoveCampaign(c.id, isRunning)}
                        style={{
                          background: '#fee2e2',
                          border: 'none',
                          color: '#dc2626',
                          padding: '6px 8px',
                          borderRadius: '4px',
                          fontSize: '11px',
                          cursor: 'pointer',
                        }}
                        title={isRunning ? 'Huỷ chiến dịch' : 'Xoá chiến dịch này'}
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
