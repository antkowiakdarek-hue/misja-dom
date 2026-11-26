'use strict';
/* Powiadomienia push (Web Push + VAPID). Na iPhonie działają tylko z aplikacji dodanej do ekranu początkowego (iOS 16.4+). */
const Push = (() => {
  const FLAG = 'po-rowno-push-v1';
  const KEY = (window.PO_ROWNO_CONFIG || {}).vapidPublicKey || '';
  const ua = navigator.userAgent || '';
  const isIos = /iPad|iPhone|iPod/.test(ua) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  const standalone = navigator.standalone === true || (window.matchMedia && window.matchMedia('(display-mode: standalone)').matches);
  const supported = 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;

  const flag = () => { try { return localStorage.getItem(FLAG) === '1'; } catch (e) { return false; } };
  const setFlag = (on) => { try { if (on) localStorage.setItem(FLAG, '1'); else localStorage.removeItem(FLAG); } catch (e) { /* nic */ } };
  const keyBytes = (s) => {
    const raw = atob((s + '='.repeat((4 - (s.length % 4)) % 4)).replace(/-/g, '+').replace(/_/g, '/'));
    return Uint8Array.from(raw, (c) => c.charCodeAt(0));
  };
  async function currentSub() {
    const reg = await navigator.serviceWorker.ready;
    return reg.pushManager.getSubscription();
  }
  function saveRemote(sub) {
    const j = sub.toJSON();
    return Cloud.rpc('save_push_subscription', {
      p_household: Cloud.householdId, p_endpoint: j.endpoint, p_p256dh: j.keys.p256dh, p_auth: j.keys.auth,
    });
  }

  return {
    available: Boolean(KEY),
    /* 'unsupported' | 'install' | 'denied' | 'off' | 'on' */
    state() {
      if (!supported) return isIos && !standalone ? 'install' : 'unsupported';
      if (Notification.permission === 'denied') return 'denied';
      return Notification.permission === 'granted' && flag() ? 'on' : 'off';
    },
    /* Wywołuj bezpośrednio z kliknięcia: iOS wymaga gestu użytkownika przy prośbie o zgodę. */
    async enable() {
      const perm = await Notification.requestPermission();
      if (perm !== 'granted') throw new Error('Zgoda na powiadomienia nie została udzielona.');
      let sub = await currentSub();
      if (!sub) sub = await (await navigator.serviceWorker.ready).pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: keyBytes(KEY) });
      await saveRemote(sub);
      setFlag(true);
    },
    async disable() {
      setFlag(false);
      try {
        const sub = await currentSub();
        if (sub) {
          const endpoint = sub.endpoint;
          await sub.unsubscribe();
          await Cloud.rpc('remove_push_subscription', { p_endpoint: endpoint }).catch(() => {});
        }
      } catch (e) { /* nic */ }
    },
    /* Odświeża zapis w bazie (po zmianie konta, profilu lub adresu subskrypcji). */
    async resave() {
      if (!supported || !Cloud.connected || this.state() !== 'on') return;
      const sub = await currentSub();
      if (sub) await saveRemote(sub); else setFlag(false);
    },
    async test() {
      const reg = await navigator.serviceWorker.ready;
      await reg.showNotification('Misja: Dom', { body: 'Tak będą wyglądać powiadomienia.', icon: 'icon-192.png', tag: 'test' });
    },
  };
})();
