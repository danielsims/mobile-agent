import { useState, useEffect, useRef, useCallback } from 'react';
import { QRCodeSVG } from 'qrcode.react';

export interface PairingInfo {
  url: string;
  pairingToken: string;
  serverPublicKey: string;
  expiresAt: number;
}

interface MobilePanelProps {
  onRequestPairingInfo: () => void;
  pairingInfo: PairingInfo | null;
  pairingError: string | null;
  tunnelAvailable: boolean;
}

export function MobilePanel({
  onRequestPairingInfo,
  pairingInfo,
  pairingError,
  tunnelAvailable,
}: MobilePanelProps) {
  const [showQR, setShowQR] = useState(false);
  const refreshTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Auto-refresh QR 30s before token expiry while visible
  useEffect(() => {
    if (!showQR || !pairingInfo?.expiresAt) return;

    const msUntilRefresh = pairingInfo.expiresAt - Date.now() - 30_000;
    if (msUntilRefresh <= 0) {
      onRequestPairingInfo();
      return;
    }

    refreshTimerRef.current = setTimeout(() => {
      onRequestPairingInfo();
    }, msUntilRefresh);

    return () => {
      if (refreshTimerRef.current) clearTimeout(refreshTimerRef.current);
    };
  }, [showQR, pairingInfo?.expiresAt, onRequestPairingInfo]);

  const handleShowQR = useCallback(() => {
    setShowQR(true);
    onRequestPairingInfo();
  }, [onRequestPairingInfo]);

  const handleHideQR = useCallback(() => {
    setShowQR(false);
    if (refreshTimerRef.current) {
      clearTimeout(refreshTimerRef.current);
      refreshTimerRef.current = null;
    }
  }, []);

  const qrData = pairingInfo
    ? JSON.stringify({
        url: pairingInfo.url,
        pairingToken: pairingInfo.pairingToken,
        serverPublicKey: pairingInfo.serverPublicKey,
      })
    : null;

  return (
    <div className="mobile-panel">
      <div className="sidebar-header">Mobile</div>
      <div className="mobile-panel-content">
        {!tunnelAvailable ? (
          <div className="mobile-panel-prompt">
            <p className="mobile-panel-desc">
              Tunnel not available. Mobile pairing requires an internet connection.
            </p>
          </div>
        ) : !showQR ? (
          <div className="mobile-panel-prompt">
            <div className="mobile-panel-icon">
              <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                <rect x="5" y="2" width="14" height="20" rx="2" ry="2" />
                <line x1="12" y1="18" x2="12.01" y2="18" />
              </svg>
            </div>
            <p className="mobile-panel-desc">
              Scan a QR code to connect the Mobile Agent app to this session.
            </p>
            <button className="mobile-panel-connect-btn" onClick={handleShowQR}>
              Connect Mobile App
            </button>
          </div>
        ) : (
          <div className="mobile-panel-qr">
            {pairingError ? (
              <div className="mobile-panel-error">{pairingError}</div>
            ) : qrData ? (
              <>
                <div className="mobile-panel-qr-container">
                  <QRCodeSVG
                    value={qrData}
                    size={180}
                    bgColor="transparent"
                    fgColor="currentColor"
                    level="M"
                  />
                </div>
                <p className="mobile-panel-hint">
                  Scan with the Mobile Agent app to pair.
                </p>
                <p className="mobile-panel-expiry">
                  Token refreshes automatically.
                </p>
              </>
            ) : (
              <div className="mobile-panel-loading">
                <div className="git-loading-bar shimmer" />
                <div className="git-loading-bar shimmer" style={{ width: '60%', animationDelay: '0.2s' }} />
              </div>
            )}
            <button className="mobile-panel-hide-btn" onClick={handleHideQR}>
              Hide QR Code
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
