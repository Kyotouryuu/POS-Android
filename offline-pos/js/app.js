const { createApp, ref, shallowRef, computed, watch, onMounted, onUnmounted, nextTick } = Vue;

// Products/customers are large (10k+ rows) and Vue's deep reactivity on them is
// expensive. shallowRef stores them as plain arrays of plain objects — readable
// from templates but skipped by the deep-Proxy machinery.

createApp({
    setup() {
        const PROFILE_REGISTRY_KEY = 'offline_pos_profile_registry_v1';
        const loadProfileRegistry = () => {
            try {
                const raw = localStorage.getItem(PROFILE_REGISTRY_KEY);
                if (raw) {
                    const p = JSON.parse(raw);
                    if (p && typeof p.activeProfileId === 'string' && Array.isArray(p.profiles) && p.profiles.length) {
                        return p;
                    }
                }
            } catch { /* ignore */ }
            return { activeProfileId: 'default', profiles: [{ id: 'default', label: null }] };
        };
        const saveProfileRegistry = (reg) => {
            try {
                localStorage.setItem(PROFILE_REGISTRY_KEY, JSON.stringify(reg));
            } catch { /* ignore */ }
        };

        const profileRegistry = ref(loadProfileRegistry());
        let db = openOfflineProfileDb(profileRegistry.value.activeProfileId);

        const newProfileId = () => {
            if (typeof crypto !== 'undefined' && crypto.randomUUID) {
                return 'p_' + crypto.randomUUID().replace(/-/g, '');
            }
            return 'p_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 10);
        };

        // ── Master data ──────────────────────────────────────────────────────
        const products        = shallowRef([]);
        const categories      = ref([]);
        const brands          = ref([]);
        const customers       = shallowRef([]);
        const locations       = ref([]);
        const business        = ref({});
        const printers        = ref([]);
        const localPrinters   = ref([]);          // User-added printers (tray only), stored locally
        const localPrinterName = ref('');

        // ── Mobile (Android) UI + printer picker ───────────────────────────────
        // Additive-only: none of this is referenced by the desktop template.
        const mobileCartOpen             = ref(false);
        const mobileProductViewMode      = ref('list');    // 'grid' | 'list'
        const bluetoothPrinters          = ref([]);       // [{ name, address }]
        const isScanningBluetoothPrinters = ref(false);
        const selectedBluetoothPrinterInfo = ref(null);    // { name, address } | null
        const wifiPrinterIp              = ref('');
        const selectedPrinterType        = ref('');        // '' | 'bluetooth' | 'wifi'

        // ── Settings tabs & printer CRUD ─────────────────────────────────────
        const settingsTab           = ref('general');
        const showPrinterFormModal  = ref(false);
        const editingLocalPrinterId = ref(null);
        const printerForm           = ref({ name: '', tray_printer_name: '' });
        const trayHealth            = ref({ status: 'idle' }); // idle | checking | healthy | unreachable | missing_script
        const availableTrayPrinters = ref([]);
        const isLoadingTrayPrinters = ref(false);
        const invoiceLayouts  = ref([]);
        const receiptTemplate       = ref('');
        const receiptTemplateDesign = ref('slim');
        const taxRates              = ref([]);
        const sales                 = ref([]);
        const heldSales       = ref([]);

        // ── Extended master data (synced from server) ────────────────────────
        const commissionAgents = ref([]);
        const priceGroups      = ref([]);
        const invoiceSchemes   = ref([]);
        const customerGroups   = ref([]);

        // ── Cart ─────────────────────────────────────────────────────────────
        const cart                 = ref([]);
        const selectedCustomer     = ref(null);
        const selectedCustomerName = ref('');
        const orderDiscountInput   = ref(0);
        const discountType         = ref('percentage');
        const saleNote             = ref('');
        const staffNote            = ref('');
        const saleStatus           = ref('final');

        // ── Order-level config ────────────────────────────────────────────────
        const transactionDate       = ref(new Date().toISOString().slice(0, 16));
        const commissionAgentId     = ref('');
        const selectedPriceGroupId  = ref('');
        const invoiceSchemeId       = ref('');

        // ── Shipping ─────────────────────────────────────────────────────────
        const shippingCharges  = ref(0);
        const shippingDetails  = ref('');
        const shippingAddress  = ref('');
        const shippingStatus   = ref('');
        const deliveredTo      = ref('');
        const deliveryPerson   = ref('');
        const showShippingModal = ref(false);

        // ── Order tax rate ────────────────────────────────────────────────────
        const selectedOrderTaxRateId = ref('');
        const showOrderTaxModal      = ref(false);

        // ── Round-off ─────────────────────────────────────────────────────────
        const enableRoundOff = ref(false);

        // ── Packing charge ────────────────────────────────────────────────────
        const packingCharge     = ref(0);
        const showPackingModal  = ref(false);

        // ── Reward points ─────────────────────────────────────────────────────
        const rpRedeemed       = ref(0);
        const rpRedeemedAmount = ref(0);

        // ── UI state ─────────────────────────────────────────────────────────
        const currentPage           = ref('pos');
        const productSearch         = ref('');
        const productSearchQ        = ref(''); // debounced copy used for filtering (Phase 3)
        const selectedCategory      = ref(null);
        const selectedBrand         = ref(null);
        const showProductSuggestion = ref(false);
        const showCustomerDropdown  = ref(false);
        const scannerActive         = ref(false);
        const showPaymentModal      = ref(false);
        const showDiscountModal     = ref(false);
        const showLineEditModal     = ref(false);
        const showSyncPanel         = ref(false);
        const showSettings          = computed({
            get: () => currentPage.value === 'settings',
            set: (v) => { if (!v && currentPage.value === 'settings') currentPage.value = 'pos'; }
        });
        const sideNavCollapsed      = ref(true);
        const productsReady         = ref(false);
        const showBrandDrawer       = ref(false);

        // ── App update check ─────────────────────────────────────────────────
        const appVersion   = ref(null);
        const updateStatus = ref('idle'); // idle | checking | up_to_date | update_available | error
        const updateInfo   = ref(null);   // { version, downloadUrl }
        const showHeldSalesModal    = ref(false);
        const showOrderConfigStrip  = ref(false);
        const editingItem           = ref(null);
        const editingIndex          = ref(null);
        const viewingSale           = ref(null);
        const lastReceipt           = ref(null);
        const searchInput           = ref(null);
        const scannerSearchTimer    = ref(null);
        const showClearCartConfirmModal = ref(false);
        const gridEl                = ref(null); // template ref on the scrollable grid container

        // ── Suspend with note ─────────────────────────────────────────────────
        const showSuspendModal = ref(false);
        const suspendNote      = ref('');

        // ── Recent transactions modal ─────────────────────────────────────────
        const showRecentTransactionsModal = ref(false);
        const recentTransTab              = ref('final');

        // ── Search config ─────────────────────────────────────────────────────
        const showSearchConfigModal = ref(false);
        const searchFields          = ref(['name', 'sku', 'barcode']);
        const tileSize              = ref('md'); // 'sm' | 'md' | 'lg'

        // ── Virtual grid scroll state ─────────────────────────────────────────
        const gridScrollTop  = ref(0);
        const gridContainerH = ref(600); // measured via ResizeObserver after mount

        // ── Manual search ─────────────────────────────────────────────────────
        const showManualSearchModal  = ref(false);
        const manualSearchQuery      = ref('');
        const manualSearchCategoryId = ref('');
        const manualSearchBrandId    = ref('');
        const manualSearchQty        = ref(1);

        // ── Modifier modal ────────────────────────────────────────────────────
        const showModifierModal           = ref(false);
        const pendingProductForModifier   = ref(null);
        const tempModifierSelections      = ref({});

        // ── Lot number modal ──────────────────────────────────────────────────
        const showLotModal           = ref(false);
        const pendingProductForLot   = ref(null);
        const selectedLot            = ref(null);

        const showAddCustomerModal   = ref(false);
        const newCustomerForm        = ref({
            contact_kind:             'individual',
            name:                     '',
            mobile:                   '',
            prefix:                   '',
            first_name:               '',
            middle_name:              '',
            last_name:                '',
            supplier_business_name:   '',
            email:                    '',
            alternate_number:         '',
            landline:                 '',
            tax_number:               '',
            address_line_1:           '',
            address_line_2:           '',
            city:                     '',
            state:                    '',
            country:                  '',
            zip_code:                 '',
            customer_group_id:        '',
        });
        const newCustomerFieldErrors = ref({});

        // ── Returns ──────────────────────────────────────────────────────────
        const showReturnModal   = ref(false);
        const returningFromSale = ref(null);
        const returnItems       = ref([]);
        const returnMethod      = ref('cash'); // Bug 9: tracks refund method

        // ── Payment ──────────────────────────────────────────────────────────
        const payments          = ref([{ method: 'cash', amount: 0 }]);
        const paymentMethods    = ref(['cash', 'card', 'cheque', 'bank_transfer', 'other']);
        const changeReturnMethod = ref('cash');

        // ── Backup ───────────────────────────────────────────────────────────
        const autoBackupEnabled  = ref(false);
        const autoBackupFileHandle = ref(null); // FileSystemFileHandle stored here at runtime
        const isExporting        = ref(false);
        const isImporting        = ref(false);
        const backupFileApiSupported = typeof window.showSaveFilePicker === 'function';

        // ── Sales list filters ───────────────────────────────────────────────
        const salesSearch       = ref('');
        const salesDateFrom     = ref('');
        const salesDateTo       = ref('');
        const salesStatusFilter = ref('');
        const salesSyncFilter   = ref('');

        // ── Sync state ───────────────────────────────────────────────────────
        const isOnline     = ref(navigator.onLine);
        const isSyncing    = ref(false);
        const pushingSales = ref(false);
        const syncStatus   = ref('');
        const syncLog      = ref([]);
        /** Persisted rolling log of push failures (IndexedDB); survives app restart */
        const pushFailureAudit = ref([]);
        /** Persisted rolling log of per-row sync failures (IndexedDB); pruned to 90 days */
        const syncFailureLog = ref([]);
        const lastSyncAt   = ref(null);
        const sublocation  = ref(null);

        /** Seconds between automatic upload attempts (from server); null when no sublocation */
        const autoSyncIntervalSeconds = ref(null);
        /** Target time for the next automatic upload tick (for sidebar countdown) */
        const autoSyncNextFireAt = ref(null);
        /** Bumped every second so countdown text stays fresh */
        const autoSyncClock = ref(Date.now());
        const autoSyncRunning = ref(false);

        /** From last GET /api/sync/cash-register (or persisted); gates close-register UI */
        const cashRegisterPermissions = ref(null);
        /** null = unknown, true/false from last successful GET cash-register */
        const hasOpenRegister = ref(null);

        // ── Close cash register (end of day) ─────────────────────────────────
        const showCloseRegisterModal = ref(false);
        const closeRegisterStep = ref(''); // upload | fetching | form | no_register | submitting | error
        const closeRegisterMessage = ref('');
        const closeRegisterSnapshot = ref(null);
        const closeRegisterForm = ref({
            closing_amount:     0,
            total_card_slips:   0,
            total_cheques:      0,
            closing_note:       '',
            denominationCounts: {},
        });
        const closeRegisterFlowBusy = ref(false);

        // ── Open cash register (cash in hand — same as web POS) ──────────────
        const showOpenRegisterModal = ref(false);
        const openRegisterBusy = ref(false);
        const openRegisterError = ref('');
        const openRegisterForm = ref({
            amount: null,
            location_id: '',
        });
        // Sticky flag: once the user dismisses the auto-prompt, don't re-pop it
        // from every background sync / online event. Reset on successful open,
        // register close, profile switch, or an explicit force-open (e.g. placing a sale).
        const openRegisterAutoDismissed = ref(false);

        // ── ZATCA ─────────────────────────────────────────────────────────────
        const zatcaCertificate = ref(null);

        // ── Toasts ───────────────────────────────────────────────────────────
        const toasts = ref([]);

        // ── Settings ─────────────────────────────────────────────────────────
        const CURRENCY_SYMBOL = '﷼';

        const settings = ref({
            serverUrl:  '',
            apiKey:     '',
            locationId: '',
        });

        // ── i18n / language ──────────────────────────────────────────────────
        // AR is the default and priority; EN is opt-in and persists in localStorage.
        const LANG_KEY = 'offline_pos_lang_v1';
        const loadLang = () => {
            try {
                const v = localStorage.getItem(LANG_KEY);
                if (v === 'ar' || v === 'en') return v;
            } catch { /* ignore */ }
            return 'ar';
        };
        const lang = ref(loadLang());
        const dir  = computed(() => lang.value === 'ar' ? 'rtl' : 'ltr');

        // Dictionary lives in js/i18n.js (loaded before app.js). AR is the source of
        // truth; missing keys in a locale fall back to AR, then to the key itself.
        const i18n = (typeof window !== 'undefined' && window.I18N) || { ar: {}, en: {} };
        const t = (key, vars) => {
            const s = (i18n[lang.value] && i18n[lang.value][key]) || i18n.ar[key] || key;
            if (!vars) return s;
            return s.replace(/\{(\w+)\}/g, (_, k) => (k in vars ? vars[k] : '{' + k + '}'));
        };

        const setLang = (v) => {
            if (v !== 'ar' && v !== 'en') return;
            lang.value = v;
            try { localStorage.setItem(LANG_KEY, v); } catch { /* ignore */ }
        };

        watch(lang, (v) => {
            document.documentElement.setAttribute('lang', v);
            // Legacy Arabic layout is intentionally rooted in LTR; Arabic panels opt into
            // RTL through their own :dir binding. Keeping that boundary prevents flex/grid
            // and native controls outside those panels from changing their AR layout.
            if (v === 'ar') document.documentElement.removeAttribute('dir');
            else document.documentElement.setAttribute('dir', 'ltr');
        }, { immediate: true });

        /** Shown in header; from GET /api/sync/config user payload or first successful sync */
        const cashierDisplayName = ref('');

        const showAddAccountModal = ref(false);
        const addAccountTokenInput = ref('');
        const addAccountOtpInput   = ref('');
        const addAccountOtpBusy    = ref(false);
        const addAccountOtpError   = ref('');
        const preAccountSwitchBusy = ref(false);

        // Mobile connect form
        const showConnectForm        = ref(false);
        const connectServerUrl       = ref('https://zaterp.com');
        const connectOtpDigits       = ref(['', '', '', '', '', '']);
        const connectOtpBusy         = ref(false);
        const connectOtpError        = ref('');
        const connectPendingToken    = ref('');
        const connectLocations       = ref([]);
        const connectLocationId      = ref('');
        const connectSaveBusy        = ref(false);

        const showSwitchAccountModal = ref(false);
        const switchAccountTargetId  = ref('');
        const switchAccountUsername  = ref('');
        const switchAccountPassword  = ref('');
        const switchAccountBusy      = ref(false);
        const switchAccountError     = ref('');

        /** Last known sync token expiry from server (`token_expires_at`), persisted as `sync_token_expires_at` */
        const syncTokenExpiresAt = ref(null);
        const MS_SYNC_TOKEN_WARN = 30 * 24 * 60 * 60 * 1000; // 30-day window, fixed ms

        // ════════════════════════════════════════════════════════════════════
        // HELPERS
        // ════════════════════════════════════════════════════════════════════

        /** Display-only; fixed ﷼ (ZATCA uses business currency code in zatca.js) */
        const fmt = (n) => `${(+(n || 0)).toFixed(2)} ${CURRENCY_SYMBOL}`;
        const fmtDate = (d) => d ? new Date(d).toLocaleString() : '';

        // ── ZATCA QR: render into view-sale modal when opened ────────────────
        watch(viewingSale, async (sale) => {
            if (!sale?.zatca_qr_code || typeof qrcode === 'undefined') return;
            await nextTick();
            const el = document.getElementById('zqr-' + sale.local_uuid);
            if (!el || el.innerHTML) return;
            try {
                const qr = qrcode(0, 'M');
                qr.addData(sale.zatca_qr_code);
                qr.make();
                el.innerHTML = qr.createSvgTag({ scalable: true });
                const svg = el.querySelector('svg');
                if (svg) svg.style.cssText = 'width:200px;height:200px;';
            } catch (e) { /* silent */ }
        });

        const toast = (msg, type = 'info', ms = 3500) => {
            const id = Date.now() + Math.random();
            toasts.value.push({ id, msg, type });
            setTimeout(() => { toasts.value = toasts.value.filter(x => x.id !== id); }, ms);
        };

        const SYNC_LOG_UI_MAX = 60;
        const MAX_SYNC_ATTEMPTS = 5;

        const addLog = (msg, type = 'info') => {
            syncLog.value.unshift({ msg: `${new Date().toLocaleTimeString()} ${msg}`, type });
            if (syncLog.value.length > SYNC_LOG_UI_MAX) syncLog.value.pop();
        };

        const PUSH_FAILURE_AUDIT_MAX = 28;
        const SYNC_FAILURE_LOG_DAYS = 90;

        const persistPushFailureAudit = async () => {
            await db.settings.put({
                key: 'push_failure_audit',
                data: cloneForIdb(pushFailureAudit.value.slice(0, PUSH_FAILURE_AUDIT_MAX)),
            });
        };

        const clearPushFailureAudit = async () => {
            pushFailureAudit.value = [];
            await db.settings.put({ key: 'push_failure_audit', data: [] });
            toast(t('push_error_log_cleared'), 'success');
        };

        const pruneSyncFailureLog = (entries) => {
            const cutoff = Date.now() - SYNC_FAILURE_LOG_DAYS * 86400 * 1000;
            return entries.filter(e => e.atIso && new Date(e.atIso).getTime() >= cutoff);
        };

        const persistSyncFailureLog = async () => {
            await db.settings.put({
                key:  'sync_failure_log',
                data: cloneForIdb(pruneSyncFailureLog(syncFailureLog.value)),
            });
        };

        const clearSyncFailureLog = async () => {
            syncFailureLog.value = [];
            await db.settings.put({ key: 'sync_failure_log', data: [] });
            toast(t('sync_failure_log_cleared'), 'success');
        };

        const appendSyncFailureLog = async (sales) => {
            const entries = sales.map(s => ({
                id:            `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
                atIso:         new Date().toISOString(),
                local_uuid:    s.local_uuid    || null,
                invoice_no:    s.invoice_no    || null,
                type:          s.type          || null,
                total:         s.total         ?? null,
                sync_attempts: s.sync_attempts,
                sync_error:    s.sync_error    || null,
                abandoned:     s.abandoned     || false,
            }));
            syncFailureLog.value = pruneSyncFailureLog([...entries, ...syncFailureLog.value]);
            await persistSyncFailureLog();
        };

        const formatPushFailureDetailLine = (d) => {
            const inv = d.invoice_no ? String(d.invoice_no).trim() : '';
            const label = inv ? t('invoice_prefix', { no: inv }) : (d.local_uuid ? t('local_short', { suffix: String(d.local_uuid).slice(-8) }) : t('operation'));
            const msg = String(d.message || t('unknown_error')).trim();
            return `${label}: ${msg}`;
        };

        /** Append to in-memory sync log + persist audit (no DevTools required). */
        const recordPushFailures = async (failureDetails, fallbackLine) => {
            const lines = [];
            if (failureDetails?.length) {
                for (const d of failureDetails.slice(0, 20)) lines.push(formatPushFailureDetailLine(d));
            } else if (fallbackLine) {
                lines.push(String(fallbackLine).trim());
            }
            if (!lines.length) return;

            pushFailureAudit.value = [{
                id:    `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
                atIso: new Date().toISOString(),
                lines: cloneForIdb(lines),
            }, ...pushFailureAudit.value].slice(0, PUSH_FAILURE_AUDIT_MAX);
            await persistPushFailureAudit();

            for (const line of lines) addLog(line, 'error');
        };

        const cloneForIdb = (v) => JSON.parse(JSON.stringify(v));
        const normSearch = (v) => String(v || '').toLowerCase().trim();
        let cartItemSeq = 1;
        const withCartCid = (item) => item && item._cid ? item : { ...item, _cid: `c${cartItemSeq++}` };
        const normalizeCartItems = (items) => (items || []).map(withCartCid);

        const apiHeaders = () => ({
            'Authorization': `Bearer ${settings.value.apiKey}`,
            'Content-Type':  'application/json',
            'Accept':        'application/json',
        });

        const requireSync = () => {
            if (!settings.value.serverUrl) { toast(t('server_url_not_configured'), 'error'); return false; }
            if (!settings.value.apiKey)    { toast(t('api_key_not_configured'), 'error');    return false; }
            return true;
        };

        const hasSyncCredentials = () =>
            !!(settings.value.serverUrl && settings.value.apiKey);

        const parseIsoInstant = (s) => {
            if (s == null || typeof s !== 'string') return null;
            const trimmed = s.trim();
            if (!trimmed) return null;
            const d = new Date(trimmed);
            return Number.isNaN(d.getTime()) ? null : d;
        };

        const applyTokenExpiryFromConfig = async (cfg) => {
            if (!cfg || !Object.prototype.hasOwnProperty.call(cfg, 'token_expires_at')) return;
            const raw = cfg.token_expires_at;
            if (raw != null && String(raw).trim() !== '') {
                syncTokenExpiresAt.value = String(raw).trim();
                await db.settings.put({ key: 'sync_token_expires_at', data: syncTokenExpiresAt.value });
            } else {
                syncTokenExpiresAt.value = null;
                await db.settings.put({ key: 'sync_token_expires_at', data: null });
            }
        };

        /** Name for UI + profile list (per-user offline token) */
        const applyCashierFromConfig = async (cfg) => {
            if (!cfg || typeof cfg !== 'object') return;
            let name = '';
            const u = cfg.user;
            if (u && typeof u === 'object') {
                const joined = [u.first_name, u.last_name].filter(Boolean).join(' ').trim();
                name = (joined || u.name || u.username || u.user_name || '').trim();
            }
            if (!name) name = String(cfg.user_name || cfg.cashier_name || cfg.cashier || '').trim();
            if (!name) return;
            cashierDisplayName.value = name;
            await db.settings.put({ key: 'sync_cashier_display_name', data: name });
            const reg = profileRegistry.value;
            const ent = reg.profiles.find((x) => x.id === reg.activeProfileId);
            if (ent) {
                ent.label = name;
                saveProfileRegistry(reg);
                profileRegistry.value = { ...reg, profiles: reg.profiles.map((x) => ({ ...x })) };
            }
        };

        const notifySyncUnauthorized = () => {
            toast(
                t('token_expired_paste_new'),
                'error',
                7500,
            );
        };

        const AUTO_SYNC_ALLOWED_SECONDS = new Set([300, 900, 1800, 3600, 7200, 14400, 21600, 28800, 43200, 57600, 72000]);

        const normalizeAutoSyncIntervalSeconds = (raw) => {
            const n = parseInt(raw, 10);
            if (Number.isFinite(n) && AUTO_SYNC_ALLOWED_SECONDS.has(n)) return n;
            return 1800;
        };

        const formatAutoSyncEveryAr = (totalSec) => {
            const labelKeys = {
                300:   'every_5_min',
                900:   'every_15_min',
                1800:  'every_30_min',
                3600:  'every_hour',
                7200:  'every_2_hours',
                14400: 'every_4_hours',
                21600: 'every_6_hours',
                28800: 'every_8_hours',
                43200: 'every_12_hours',
                57600: 'every_16_hours',
                72000: 'every_20_hours',
            };
            const key = labelKeys[totalSec];
            return key ? t(key) : t('every_n_minutes', { n: Math.round(totalSec / 60) });
        };

        const formatCountdownAr = (ms) => {
            const sec = Math.max(0, Math.ceil(ms / 1000));
            const h = Math.floor(sec / 3600);
            const m = Math.floor((sec % 3600) / 60);
            const r = sec % 60;
            const hLbl = t('unit_hours_short');
            const mLbl = t('unit_minutes_short');
            const sLbl = t('unit_seconds_short');
            if (h > 0) return `${h}${hLbl} ${m}${mLbl}`;
            if (m > 0) return `${m}${mLbl} ${r}${sLbl}`;
            return `${r}${sLbl}`;
        };

        /** Persist interval from `cfg.sublocation`; clear when legacy unbound token */
        const applyAutoSyncPolicyFromConfig = async (cfg) => {
            const sub = cfg?.sublocation;
            if (!sub) {
                autoSyncIntervalSeconds.value = null;
                await db.settings.put({ key: 'auto_sync_interval_seconds', data: null });
                return;
            }
            const sec = normalizeAutoSyncIntervalSeconds(sub.auto_sync_interval_seconds);
            autoSyncIntervalSeconds.value = sec;
            await db.settings.put({ key: 'auto_sync_interval_seconds', data: sec });
        };

        const apiGet = async (path) => {
            const res = await fetch(`${settings.value.serverUrl}${path}`, { headers: apiHeaders() });
            if (res.status === 401) {
                notifySyncUnauthorized();
                throw new Error(`HTTP 401 on ${path}`);
            }
            if (!res.ok) throw new Error(`HTTP ${res.status} on ${path}`);
            return res.json();
        };

        /** Same auth as apiGet but returns status + parsed JSON for any response code */
        const apiFetchJson = async (path, options = {}) => {
            const res = await fetch(`${settings.value.serverUrl}${path}`, {
                ...options,
                headers: { ...apiHeaders(), ...(options.headers || {}) },
            });
            if (res.status === 401) notifySyncUnauthorized();
            let data = null;
            try {
                const text = await res.text();
                if (text) data = JSON.parse(text);
            } catch { /* ignore */ }
            return { ok: res.ok, status: res.status, data };
        };

        const persistCashRegisterPermissions = async (perms) => {
            if (!perms || typeof perms !== 'object') return;
            const normalized = {
                view_cash_register:  !!perms.view_cash_register,
                close_cash_register: !!perms.close_cash_register,
            };
            cashRegisterPermissions.value = normalized;
            await db.settings.put({ key: 'cash_register_permissions', data: cloneForIdb(normalized) });
        };

        /** Refresh permission flags + open-register state from server (after sync or when online). */
        const refreshCashRegisterPermissions = async ({ promptOpenIfClosed = true } = {}) => {
            if (!hasSyncCredentials() || !isOnline.value) return;
            try {
                const { status, data } = await apiFetchJson('/api/sync/cash-register');
                if (data?.permissions) await persistCashRegisterPermissions(data.permissions);
                else if (status === 403) {
                    await persistCashRegisterPermissions({ view_cash_register: false, close_cash_register: false });
                }

                if (typeof data?.has_open_register === 'boolean') {
                    const wasOpen = hasOpenRegister.value === true;
                    hasOpenRegister.value = !!data.has_open_register;
                    // Register transitioned from open → closed elsewhere: allow auto-prompt again.
                    if (wasOpen && !data.has_open_register) openRegisterAutoDismissed.value = false;
                    if (promptOpenIfClosed
                        && !data.has_open_register
                        && !showCloseRegisterModal.value
                        && !showPaymentModal.value
                        && !showSettings.value
                        && !showSyncPanel.value
                        && !openRegisterAutoDismissed.value) {
                        openOpenRegisterFlow({ silentIfBusy: true });
                    }
                    return;
                }

                if (status === 403) hasOpenRegister.value = null;
            } catch { /* unreachable host */ }
        };

        const showCloseRegisterControl = computed(() => {
            if (!hasSyncCredentials()) return false;
            const p = cashRegisterPermissions.value;
            if (!p) return true;
            return !!p.close_cash_register;
        });

        const initOpenRegisterForm = () => {
            openRegisterForm.value = {
                amount: null,
                location_id: settings.value.locationId ? String(settings.value.locationId) : '',
            };
            openRegisterError.value = '';
        };

        /** Show cash-in-hand modal (web POS parity when register is closed).
         *  `force` clears the sticky dismissed flag (e.g. user placing a sale should always see the prompt). */
        const openOpenRegisterFlow = ({ silentIfBusy = false, force = false } = {}) => {
            if (force) openRegisterAutoDismissed.value = false;
            if (!hasSyncCredentials()) {
                if (!silentIfBusy) toast(t('set_server_and_api_first'), 'error');
                return;
            }
            if (!isOnline.value) {
                if (!silentIfBusy) toast(t('open_requires_online'), 'error');
                return;
            }
            if (openRegisterBusy.value || showOpenRegisterModal.value) return;
            if (showCloseRegisterModal.value) return;
            initOpenRegisterForm();
            showOpenRegisterModal.value = true;
        };

        const dismissOpenRegisterModal = () => {
            if (openRegisterBusy.value) return;
            showOpenRegisterModal.value = false;
            openRegisterError.value = '';
            // Prevent auto-reprompt from every subsequent sync/online event
            // until the user explicitly opens the register or places a new order.
            openRegisterAutoDismissed.value = true;
        };

        /** Used from the sale flow: if the register is known to be closed, pop the
         *  open-cashier modal and return `true` to signal callers to abort the sale.
         *  The cart is left untouched — user opens the register (or dismisses) then
         *  clicks the payment button again to place the order. */
        const blockSaleIfRegisterClosed = () => {
            if (hasOpenRegister.value !== false) return false;
            openOpenRegisterFlow({ silentIfBusy: true, force: true });
            return true;
        };

        // Phase 2 ZATCA businesses must be online to place or return orders.
        const blockSaleIfPhase2Offline = () => {
            if ((sublocation.value?.zatca_phase ?? 1) !== 2) return false;
            if (isOnline.value) return false;
            toast(t('phase2_requires_online'), 'error', 6000);
            return true;
        };

        const submitOpenRegister = async () => {
            if (!hasSyncCredentials() || !isOnline.value) {
                toast(t('open_requires_online'), 'error');
                return;
            }
            if (openRegisterBusy.value) return;

            const amount = +(openRegisterForm.value.amount ?? 0);
            if (!Number.isFinite(amount) || amount < 0) {
                openRegisterError.value = t('enter_cash_in_hand');
                return;
            }

            let locationId = openRegisterForm.value.location_id || settings.value.locationId || '';
            if (!locationId && locations.value.length === 1) {
                locationId = String(locations.value[0].id);
            }
            if (!locationId) {
                openRegisterError.value = t('select_location_for_register');
                return;
            }

            openRegisterBusy.value = true;
            openRegisterError.value = '';
            try {
                const body = {
                    amount,
                    location_id: +locationId,
                };
                const { ok, status, data } = await apiFetchJson('/api/sync/cash-register/open', {
                    method: 'POST',
                    body: JSON.stringify(body),
                });
                if (!ok || !data?.success) {
                    openRegisterError.value = (data?.message || t('open_failed_status', { status })).trim();
                    return;
                }
                hasOpenRegister.value = true;
                openRegisterAutoDismissed.value = false;
                if (!settings.value.locationId && locationId) {
                    settings.value.locationId = String(locationId);
                    await persistConfig();
                }
                toast(data?.message || t('register_opened'), 'success');
                showOpenRegisterModal.value = false;
            } catch (e) {
                openRegisterError.value = e.message || String(e);
            } finally {
                openRegisterBusy.value = false;
            }
        };

        /** From close modal "no open register" → switch to open cash-in-hand flow. */
        const switchCloseModalToOpenRegister = () => {
            if (closeRegisterFlowBusy.value) return;
            showCloseRegisterModal.value = false;
            openOpenRegisterFlow();
        };

        /** @param {string} [extraQuery] — e.g. `since=${encodeURIComponent(iso)}` (no leading `?` or `&`) */
        const paginatedFetch = async (path, onBatch, extraQuery = null) => {
            let page = 1;
            while (true) {
                const qs = extraQuery ? `${path}?${extraQuery}&page=${page}` : `${path}?page=${page}`;
                const data = await apiGet(qs);
                await onBatch(data.data || []);
                const lastPage = data.meta?.last_page || 1;
                if (page >= lastPage) break;
                page++;
                addLog(`${path}: page ${page}/${lastPage}…`);
            }
        };

        // ════════════════════════════════════════════════════════════════════
        // LINE-LEVEL CALCULATION HELPERS
        // ════════════════════════════════════════════════════════════════════

        const lineModifiersTotal = (item) =>
            (item.selected_modifiers || []).reduce((s, m) => s + (m.price || 0), 0);

        const lineGross = (item) => item.quantity * (item.unit_price + lineModifiersTotal(item));

        const lineDiscAmt = (item) => {
            if (!item.line_discount_type || !item.line_discount_amount) return 0;
            const gross = lineGross(item);
            // Bug 11 fix: clamp fixed discount so lineNet never goes negative
            return item.line_discount_type === 'percentage'
                ? gross * Math.min(item.line_discount_amount, 100) / 100
                : Math.min(+item.line_discount_amount, gross);
        };

        const lineNet = (item) => lineGross(item) - lineDiscAmt(item);

        // ════════════════════════════════════════════════════════════════════
        // COMPUTED
        // ════════════════════════════════════════════════════════════════════

        const effectiveTokenExpiryIso = computed(() => {
            const a = syncTokenExpiresAt.value;
            return a != null && String(a).trim() !== '' ? String(a).trim() : null;
        });

        const syncTokenExpiryBanner = computed(() => {
            const iso = effectiveTokenExpiryIso.value;
            if (!iso) return null;
            const exp = parseIsoInstant(iso);
            if (!exp) return null;
            const now = Date.now();
            const expMs = exp.getTime();
            if (expMs <= now) {
                return {
                    kind: 'expired',
                    text: t('pull_token_expired'),
                };
            }
            if (expMs - now <= MS_SYNC_TOKEN_WARN) {
                const dateLabel = exp.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
                return {
                    kind: 'warning',
                    text: t('pull_token_expiring_on', { date: dateLabel }),
                };
            }
            return null;
        });

        // Price-group aware product list
        const pricedProducts = computed(() => {
            if (!selectedPriceGroupId.value) return products.value;
            return products.value.map(p => {
                const gp = (p.price_groups || []).find(g => String(g.price_group_id) === String(selectedPriceGroupId.value));
                return gp ? { ...p, sell_price_inc_tax: gp.price_inc_tax } : p;
            });
        });

        // Product search index (rebuilt only when pricedProducts changes).
        // Keeps normalized fields off the hot typing path.
        const productSearchIndex = computed(() =>
            pricedProducts.value.map((p) => ({
                p,
                nameN: normSearch(p.name),
                skuN: normSearch(p.sku),
                barcodeN: normSearch(p.barcode),
                categoryId: p.category_id == null ? '' : String(p.category_id),
                brandId: p.brand_id == null ? '' : String(p.brand_id),
            }))
        );

        // Exact lookup maps for scanner-like input.
        const exactProductLookup = computed(() => {
            const sku = new Map();
            const barcode = new Map();
            for (const row of productSearchIndex.value) {
                if (row.skuN) {
                    const arr = sku.get(row.skuN);
                    if (arr) arr.push(row.p);
                    else sku.set(row.skuN, [row.p]);
                }
                if (row.barcodeN) {
                    const arr = barcode.get(row.barcodeN);
                    if (arr) arr.push(row.p);
                    else barcode.set(row.barcodeN, [row.p]);
                }
            }
            return { sku, barcode };
        });

        const displayProducts = computed(() => {
            let list = pricedProducts.value;
            if (selectedCategory.value) list = list.filter(p => p.category_id == selectedCategory.value);
            if (selectedBrand.value)    list = list.filter(p => p.brand_id    == selectedBrand.value);
            return list;
        });

        // ── Virtual grid computeds ────────────────────────────────────────────
        // Row height (px) and column count per tile size, matching the CSS grid.
        const V_OVERSCAN  = 2; // extra rows rendered above + below viewport
        const vRowHeight  = computed(() => ({ sm: 170, md: 230, lg: 320 }[tileSize.value] || 230));
        const vCols       = computed(() => ({ sm: 6,   md: 4,   lg: 2   }[tileSize.value] || 4));
        const vTotalRows  = computed(() => Math.ceil(displayProducts.value.length / vCols.value));
        const vTotalH     = computed(() => vTotalRows.value * vRowHeight.value);

        const vFirstRow   = computed(() =>
            Math.max(0, Math.floor(gridScrollTop.value / vRowHeight.value) - V_OVERSCAN)
        );
        const vLastRow    = computed(() =>
            Math.min(vTotalRows.value - 1,
                Math.ceil((gridScrollTop.value + gridContainerH.value) / vRowHeight.value) + V_OVERSCAN)
        );
        const vTopPad     = computed(() => vFirstRow.value * vRowHeight.value);
        const vBottomPad  = computed(() =>
            Math.max(0, (vTotalRows.value - vLastRow.value - 1) * vRowHeight.value)
        );
        const visibleProducts = computed(() =>
            displayProducts.value.slice(
                vFirstRow.value * vCols.value,
                (vLastRow.value + 1) * vCols.value
            )
        );

        const onGridScroll = () => {
            if (gridEl.value) gridScrollTop.value = gridEl.value.scrollTop;
        };

        // ── Mobile list-view virtual scroll (additive; independent of the grid's
        // vCols/vRowHeight above, which assume desktop's tileSize column counts and
        // don't apply to a single-column row list). Reuses the same gridEl/
        // gridScrollTop/gridContainerH/onGridScroll as the grid view.
        const M_LIST_ROW_H     = 84;
        const mListTotalRows   = computed(() => displayProducts.value.length);
        const mListFirstIdx    = computed(() =>
            Math.max(0, Math.floor(gridScrollTop.value / M_LIST_ROW_H) - V_OVERSCAN)
        );
        const mListLastIdx     = computed(() =>
            Math.min(mListTotalRows.value - 1,
                Math.ceil((gridScrollTop.value + gridContainerH.value) / M_LIST_ROW_H) + V_OVERSCAN)
        );
        const mListTopPad      = computed(() => mListFirstIdx.value * M_LIST_ROW_H);
        const mListBottomPad   = computed(() =>
            Math.max(0, (mListTotalRows.value - mListLastIdx.value - 1) * M_LIST_ROW_H)
        );
        const mListVisibleProducts = computed(() =>
            mListTotalRows.value === 0 ? [] : displayProducts.value.slice(mListFirstIdx.value, mListLastIdx.value + 1)
        );

        const filteredProducts = computed(() => {
            const q = normSearch(productSearchQ.value);
            if (!q) return [];
            const sf = searchFields.value;
            const useName = sf.includes('name');
            const useSku = sf.includes('sku');
            const useBarcode = sf.includes('barcode');
            const out = [];

            for (const row of productSearchIndex.value) {
                if (useName && row.nameN.includes(q)) { out.push(row.p); }
                else if (useSku && row.skuN.includes(q)) { out.push(row.p); }
                else if (useBarcode && row.barcodeN.includes(q)) { out.push(row.p); }
                if (out.length >= 25) break;
            }
            return out;
        });

        const manualSearchResults = computed(() => {
            const q   = normSearch(manualSearchQuery.value);
            const cat = manualSearchCategoryId.value ? String(manualSearchCategoryId.value) : '';
            const brd = manualSearchBrandId.value ? String(manualSearchBrandId.value) : '';
            const out = [];
            for (const row of productSearchIndex.value) {
                if (cat && row.categoryId !== cat) continue;
                if (brd && row.brandId !== brd) continue;
                if (q && !row.nameN.includes(q) && !row.skuN.includes(q) && !row.barcodeN.includes(q)) continue;
                out.push(row.p);
                if (out.length >= 100) break;
            }
            return out;
        });

        const filteredCustomers = computed(() => {
            const q = (selectedCustomerName.value || '').toLowerCase();
            if (!q) return customers.value.slice(0, 10);
            return customers.value.filter((c) => {
                const name = (c.name || '').toLowerCase();
                const phone = String(c.phone || '');
                const email = String(c.email || '').toLowerCase();
                const extra = [
                    c.first_name, c.last_name, c.middle_name, c.supplier_business_name,
                    c.alternate_number, c.landline, c.tax_number, c.address_line_1, c.city,
                ].map((x) => String(x || '').toLowerCase()).join(' ');
                return name.includes(q) || phone.includes(q) || email.includes(q) || extra.includes(q);
            }).slice(0, 10);
        });

        const totalItems    = computed(() => cart.value.reduce((s, i) => s + i.quantity, 0));
        const subtotalGross = computed(() => cart.value.reduce((s, i) => s + lineGross(i), 0));
        const totalLineDisc = computed(() => cart.value.reduce((s, i) => s + lineDiscAmt(i), 0));
        const subtotal      = computed(() => cart.value.reduce((s, i) => s + lineNet(i), 0));

        const orderDiscount = computed(() => {
            if (!orderDiscountInput.value) return 0;
            return discountType.value === 'percentage'
                ? subtotal.value * (orderDiscountInput.value / 100)
                : +orderDiscountInput.value;
        });

        // Order tax: either from selected rate or extracted from inc-tax line items
        const orderTaxAmount = computed(() => {
            if (selectedOrderTaxRateId.value) {
                const rate = taxRates.value.find(r => String(r.id) === String(selectedOrderTaxRateId.value));
                if (rate) return +(subtotal.value * rate.amount / 100).toFixed(4);
            }
            // Default: extract tax from inc-tax prices
            const linesNetInc = cart.value.reduce((s, i) => s + lineNet(i), 0);
            const linesNetTax = cart.value.reduce((s, i) => {
                const tp  = i.tax_percent || 0;
                const net = lineNet(i);
                return s + (tp > 0 ? net * tp / (100 + tp) : 0);
            }, 0);
            const subtotalVal = subtotal.value - orderDiscount.value;
            return linesNetInc > 0
                ? +(linesNetTax * subtotalVal / linesNetInc).toFixed(4)
                : +linesNetTax.toFixed(4);
        });

        const baseTotal = computed(() =>
            Math.max(0, subtotal.value - orderDiscount.value + +shippingCharges.value + +packingCharge.value - +rpRedeemedAmount.value)
        );

        const roundOffAmount = computed(() => {
            if (!enableRoundOff.value) return 0;
            const rounded = Math.round(baseTotal.value);
            return +(rounded - baseTotal.value).toFixed(2);
        });

        const grandTotal  = computed(() => Math.max(0, baseTotal.value + roundOffAmount.value));
        const totalPaid   = computed(() => payments.value.reduce((s, p) => s + (p.amount || 0), 0));
        const balanceDue  = computed(() => grandTotal.value - totalPaid.value);
        const changeReturn = computed(() => Math.max(0, totalPaid.value - grandTotal.value));

        const maxRpRedeemable = computed(() => selectedCustomer.value?.reward_points || 0);
        const rpAmountPerPoint = computed(() => +(business.value?.rp_amount_per_point || 0));

        const salesSearchIndex = computed(() =>
            sales.value.map((s) => ({
                s,
                createdAtTs: Date.parse(s.created_at) || 0,
                invoiceNoN: normSearch(s.invoice_no),
                serverInvoiceNoN: normSearch(s.server_invoice_no),
                customerNameN: normSearch(s.customer_name),
                paymentStatus: s.payment_status || '',
                syncStatus: s.sync_status || '',
                type: s.type || '',
                status: s.status || '',
            }))
        );

        const salesSortedDesc = computed(() => {
            const list = [...salesSearchIndex.value];
            list.sort((a, b) => b.createdAtTs - a.createdAtTs);
            return list;
        });

        const pendingSalesCount = computed(() => {
            let count = 0;
            for (const row of salesSearchIndex.value) if (row.syncStatus === 'pending') count++;
            return count;
        });

        const failedSalesCount  = computed(() => {
            let count = 0;
            for (const row of salesSearchIndex.value) {
                if (row.syncStatus === 'failed' || row.syncStatus === 'conflict') count++;
            }
            return count;
        });

        const abandonedSalesCount = computed(() => {
            let count = 0;
            for (const row of salesSearchIndex.value) {
                if (row.syncStatus === 'abandoned') count++;
            }
            return count;
        });

        const activeProfileEntry = computed(() =>
            profileRegistry.value.profiles.find((p) => p.id === profileRegistry.value.activeProfileId) || null,
        );

        const currentLocationName = computed(() => {
            const id = settings.value.locationId;
            if (!id) return '';
            const loc = locations.value.find((l) => String(l.id) === String(id));
            return (loc && loc.name) ? String(loc.name) : '';
        });

        const unsyncedForAccountSwitch = computed(
            () => pendingSalesCount.value + failedSalesCount.value,
        );

        const filteredSales = computed(() => {
            const q = normSearch(salesSearch.value);
            const fromTs = salesDateFrom.value ? Date.parse(salesDateFrom.value) : null;
            const toTs = salesDateTo.value ? Date.parse(`${salesDateTo.value}T23:59:59`) : null;
            const paymentStatus = salesStatusFilter.value;
            const syncStatus = salesSyncFilter.value;
            const out = [];

            for (const row of salesSortedDesc.value) {
                if (q && !row.invoiceNoN.includes(q) && !row.serverInvoiceNoN.includes(q) && !row.customerNameN.includes(q)) continue;
                if (fromTs !== null && row.createdAtTs < fromTs) continue;
                if (toTs !== null && row.createdAtTs > toTs) continue;
                if (paymentStatus && row.paymentStatus !== paymentStatus) continue;
                if (syncStatus && row.syncStatus !== syncStatus) continue;
                out.push(row.s);
            }
            return out;
        });

        const recentSalesForTab = computed(() => {
            const status = recentTransTab.value;
            const out = [];
            for (const row of salesSortedDesc.value) {
                if (row.type === 'sell_return') continue;
                if (row.status !== status) continue;
                out.push(row.s);
                if (out.length >= 30) break;
            }
            return out;
        });

        const recentTransCounts = computed(() => {
            const counts = { final: 0, quotation: 0, draft: 0 };
            for (const row of salesSearchIndex.value) {
                if (row.type === 'sell_return') continue;
                if (row.status === 'final') counts.final++;
                else if (row.status === 'quotation') counts.quotation++;
                else if (row.status === 'draft') counts.draft++;
            }
            return counts;
        });

        // ════════════════════════════════════════════════════════════════════
        // CART
        // ════════════════════════════════════════════════════════════════════

        /**
         * Generate a local document number.
         * Final sales:     L{n}-{seq}  e.g. L1-42
         * Quotations:      Q{n}-{seq}  e.g. Q1-5
         * Drafts:          DRAFT-{timestamp}
         * n is the token-bound sublocation sequence from /api/sync/config.
         * Falls back to L{seq} / Q{seq} for legacy unbound tokens (warns once).
         */
        const nextInvoiceNo = async (status) => {
            if (status === 'draft') {
                return `DRAFT-${Date.now()}`;
            }

            const isQuotation = status === 'quotation';
            const seqKey = isQuotation ? 'offline_quotation_seq' : 'offline_invoice_seq';
            const letter = isQuotation ? 'Q' : 'L';

            let seq = 1;
            await db.transaction('rw', db.settings, async () => {
                const rec = await db.settings.get(seqKey);
                seq = (rec?.value || 0) + 1;
                await db.settings.put({ key: seqKey, value: seq });
            });

            const n = sublocation.value?.sequence;
            if (!n) toast(t('invoice_no_sublocation_warn'), 'warn', 5000);
            return n ? `${letter}${n}-${seq}` : `${letter}${seq}`;
        };

        const buildCartItem = (product, selected_modifiers = [], modifierTotal = 0, lot = null) => {
            // Use price group price if applicable
            const priceIncTax = +product.sell_price_inc_tax + modifierTotal;
            const taxRate     = taxRates.value.find(r => String(r.id) === String(product.tax_id));
            const taxPercent  = taxRate ? +(taxRate.amount || 0) : 0;
            const unitPriceExc  = taxPercent > 0 ? priceIncTax / (1 + taxPercent / 100) : priceIncTax;
            const itemTaxPerUnit = priceIncTax - unitPriceExc;

            return {
                _cid:                 `c${cartItemSeq++}`,
                product_id:           product.product_id || product.id,
                variation_id:         product.id,
                name:                 product.name,
                sku:                  product.sku,
                barcode:              product.barcode,
                product_type:         product.product_type,
                quantity:             1,
                unit_price:           priceIncTax,
                unit_price_exc_tax:   +unitPriceExc.toFixed(4),
                item_tax_per_unit:    +itemTaxPerUnit.toFixed(4),
                tax_percent:          taxPercent,
                line_discount_type:   null,
                line_discount_amount: 0,
                line_note:            '',
                qty_available:        product.qty_available,
                enable_stock:         product.enable_stock,
                // Extended fields
                selected_modifiers:   selected_modifiers,
                combo_variations:     product.combo_variations || [],
                lot_number:           lot ? lot.lot_number  : null,
                lot_expiry:           lot ? lot.expiry_date : null,
                selected_unit_id:     null,
                unit_multiplier:      1,
                sub_units:            product.sub_units || [],
            };
        };

        const addToCart = (product) => {
            productSearch.value         = '';
            showProductSuggestion.value = false;
            showManualSearchModal.value = false;

            // Modifier sets take priority
            if ((product.modifier_sets || []).length > 0) {
                openModifierModal(product);
                return;
            }
            // Lot selection
            if (product.has_lots && (product.lots || []).length > 0) {
                openLotModal(product);
                return;
            }

            const existing = cart.value.find(i => i.variation_id === product.id && !(product.modifier_sets || []).length);
            if (existing) { existing.quantity += 1; return; }

            cart.value.push(buildCartItem(product));
        };

        // Add from manual modal with specified qty
        const addToCartManual = (product) => {
            const qty = Math.max(1, +manualSearchQty.value || 1);
            // Modifier sets take priority (let normal flow handle)
            if ((product.modifier_sets || []).length > 0) {
                showManualSearchModal.value = false;
                openModifierModal(product);
                return;
            }
            if (product.has_lots && (product.lots || []).length > 0) {
                showManualSearchModal.value = false;
                openLotModal(product);
                return;
            }
            const existing = cart.value.find(i => i.variation_id === product.id && !(product.modifier_sets || []).length);
            if (existing) {
                existing.quantity += qty;
            } else {
                const item = buildCartItem(product);
                item.quantity = qty;
                cart.value.push(item);
            }
            manualSearchQty.value = 1;
        };

        const updateQty = (idx, qty) => {
            if (qty <= 0) cart.value.splice(idx, 1);
            else cart.value[idx].quantity = qty;
        };

        const removeFromCart = (idx) => cart.value.splice(idx, 1);

        const resetCart = (opts = {}) => {
            const preserveOrderConfig = !!opts.preserveOrderConfig;
            cart.value               = [];
            orderDiscountInput.value = 0;
            discountType.value       = 'percentage';
            selectedCustomer.value   = null;
            selectedCustomerName.value = '';
            saleNote.value           = '';
            staffNote.value          = '';
            saleStatus.value         = 'final';
            // Shipping
            shippingCharges.value  = 0;
            shippingDetails.value  = '';
            shippingAddress.value  = '';
            shippingStatus.value   = '';
            deliveredTo.value      = '';
            deliveryPerson.value   = '';
            // Extras
            packingCharge.value          = 0;
            rpRedeemed.value             = 0;
            rpRedeemedAmount.value       = 0;
            // Keep heavy order-config fields when user explicitly clears cart from UI.
            // Resetting price group on large catalogs can trigger expensive repricing work.
            if (!preserveOrderConfig) {
                commissionAgentId.value      = '';
                selectedPriceGroupId.value   = '';
                invoiceSchemeId.value        = '';
                transactionDate.value        = new Date().toISOString().slice(0, 16);
                selectedOrderTaxRateId.value = '';
            }
            // Bug 1 fix: reset payment state so prior sale data never bleeds into next
            enableRoundOff.value       = false;
            payments.value             = [{ method: 'cash', amount: 0 }];
            changeReturnMethod.value   = 'cash';
        };

        const clearCart = () => {
            if (!cart.value.length) return;
            showClearCartConfirmModal.value = true;
        };

        const confirmClearCart = () => {
            showClearCartConfirmModal.value = false;
            resetCart({ preserveOrderConfig: true });
            // Keep cashier/scanner flow fast after clearing all items.
            refocusSearch();
        };

        const addFirstSearchResult = () => {
            if (filteredProducts.value.length) {
                addToCart(filteredProducts.value[0]);
            }
        };

        const tryAutoAddScannedProduct = () => {
            const q = normSearch(productSearch.value);
            if (!q) return;
            const { sku, barcode } = exactProductLookup.value;
            const fromSku = sku.get(q) || [];
            const fromBarcode = barcode.get(q) || [];
            const candidates = fromSku.length && fromBarcode.length
                ? [...fromSku, ...fromBarcode.filter(p => !fromSku.some(s => s.id === p.id))]
                : (fromSku.length ? fromSku : fromBarcode);

            if (candidates.length === 1) {
                addToCart(candidates[0]);
            }
        };

        // Phase 3: debounce search suggestions — productSearchQ trails productSearch by 80ms.
        // Clears instantly so the dropdown closes without delay when input is emptied.
        let _searchDebounceTimer = null;
        watch(productSearch, (v) => {
            clearTimeout(_searchDebounceTimer);
            if (!v) { productSearchQ.value = ''; return; }
            _searchDebounceTimer = setTimeout(() => { productSearchQ.value = v; }, 80);
        });

        // Reset virtual scroll position when the visible set changes (category/brand/tileSize/view mode).
        watch([selectedCategory, selectedBrand, tileSize, mobileProductViewMode], () => {
            gridScrollTop.value = 0;
            if (gridEl.value) gridEl.value.scrollTop = 0;
        });

        const onPrimarySearchInput = () => {
            showProductSuggestion.value = true;
            if (scannerSearchTimer.value) clearTimeout(scannerSearchTimer.value);
            // Scanner input often arrives as rapid key bursts; wait briefly then auto-add on exact SKU/barcode match.
            scannerSearchTimer.value = setTimeout(() => {
                tryAutoAddScannedProduct();
            }, 120);
        };

        const focusSearch = () => {
            productSearch.value = '';
            nextTick(() => searchInput.value?.focus());
        };

        const cancelCameraBarcodeScan = async () => {
            try { await window.Capacitor?.Plugins?.BarcodeScanner?.stopScan(); } catch (_) {}
            scannerActive.value = false;
            document.body.classList.remove('barcode-scanner-active');
        };

        const startCameraBarcodeScan = async () => {
            const BS = window.Capacitor?.Plugins?.BarcodeScanner;
            if (!BS) { focusSearch(); return; }
            try {
                const status = await BS.checkPermission({ force: true });
                if (!status.granted) return;
                scannerActive.value = true;
                document.body.classList.add('barcode-scanner-active');
                const result = await BS.startScan();
                scannerActive.value = false;
                document.body.classList.remove('barcode-scanner-active');
                if (result.hasContent) {
                    productSearch.value = result.content.trim();
                    tryAutoAddScannedProduct();
                    if (productSearch.value) {
                        manualSearchQuery.value = productSearch.value;
                        productSearch.value = '';
                        showManualSearchModal.value = true;
                    }
                }
            } catch (_) {
                scannerActive.value = false;
                document.body.classList.remove('barcode-scanner-active');
            }
        };

        const refocusSearch = () => {
            nextTick(() => searchInput.value?.focus());
        };

        // ════════════════════════════════════════════════════════════════════
        // CUSTOMER
        // ════════════════════════════════════════════════════════════════════

        const strOrEmpty = (v) => String(v ?? '').trim();

        const computePendingDisplayName = (row) => {
            const kind = row.contact_kind === 'business' ? 'business' : 'individual';
            if (kind === 'business') {
                const b = strOrEmpty(row.supplier_business_name) || strOrEmpty(row.name);
                return b || t('customer_default');
            }
            const manual = strOrEmpty(row.name);
            if (manual) return manual;
            const parts = [row.prefix, row.first_name, row.middle_name, row.last_name].map((x) => strOrEmpty(x)).filter(Boolean);
            if (parts.length) return parts.join(' ');
            return t('customer_default');
        };

        const buildCreateCustomerPayloadFromPendingRow = (row) => {
            const mobile = strOrEmpty(row.mobile);
            const kind = row.contact_kind === 'business' ? 'business' : 'individual';
            const payload = {
                mobile,
                local_customer_uuid: row.local_customer_uuid,
                contact_kind:        kind,
            };
            const mail = strOrEmpty(row.email);
            if (mail) payload.email = mail;
            if (row.customer_group_id != null && row.customer_group_id !== '' && Number.isFinite(+row.customer_group_id)) {
                payload.customer_group_id = +row.customer_group_id;
            }
            const alt = strOrEmpty(row.alternate_number);
            const land = strOrEmpty(row.landline);
            if (alt) payload.alternate_number = alt;
            if (land) payload.landline = land;
            const a1 = strOrEmpty(row.address_line_1 ?? row.address);
            const a2 = strOrEmpty(row.address_line_2);
            if (a1) {
                payload.address_line_1 = a1;
                payload.address = a1;
            }
            if (a2) payload.address_line_2 = a2;
            const city = strOrEmpty(row.city);
            const state = strOrEmpty(row.state);
            const country = strOrEmpty(row.country);
            const zip = strOrEmpty(row.zip_code);
            if (city) payload.city = city;
            if (state) payload.state = state;
            if (country) payload.country = country;
            if (zip) payload.zip_code = zip;
            const taxNo = strOrEmpty(row.tax_number);
            if (taxNo) payload.tax_number = taxNo;
            if (kind === 'business') {
                const bn = strOrEmpty(row.supplier_business_name) || strOrEmpty(row.name);
                payload.supplier_business_name = bn;
                payload.name = bn;
            } else {
                const pr = strOrEmpty(row.prefix);
                const fn = strOrEmpty(row.first_name);
                const mn = strOrEmpty(row.middle_name);
                const ln = strOrEmpty(row.last_name);
                if (pr) payload.prefix = pr;
                if (fn) payload.first_name = fn;
                if (mn) payload.middle_name = mn;
                if (ln) payload.last_name = ln;
                const display = computePendingDisplayName(row);
                if (display && display !== t('customer_default')) payload.name = display;
            }
            return payload;
        };

        const buildNewCustomerForTransaction = (c) => {
            if (!c?.local_customer_uuid) return null;
            const mobile = strOrEmpty(c.phone ?? c.mobile);
            const kind = c.contact_kind === 'business' ? 'business' : 'individual';
            const out = {
                mobile,
                name:              strOrEmpty(c.name),
                email:             strOrEmpty(c.email) || null,
                address:           strOrEmpty(c.address_line_1 ?? c.address) || null,
                address_line_1:    strOrEmpty(c.address_line_1 ?? c.address) || null,
                address_line_2:    strOrEmpty(c.address_line_2) || null,
                city:              strOrEmpty(c.city) || null,
                state:             strOrEmpty(c.state) || null,
                country:           strOrEmpty(c.country) || null,
                zip_code:          strOrEmpty(c.zip_code) || null,
                customer_group_id: c.customer_group_id != null && c.customer_group_id !== ''
                    ? +c.customer_group_id
                    : null,
                contact_kind:             kind,
                supplier_business_name: kind === 'business' ? (strOrEmpty(c.supplier_business_name) || null) : null,
                prefix:                   kind === 'individual' ? (strOrEmpty(c.prefix) || null) : null,
                first_name:               kind === 'individual' ? (strOrEmpty(c.first_name) || null) : null,
                middle_name:              kind === 'individual' ? (strOrEmpty(c.middle_name) || null) : null,
                last_name:                kind === 'individual' ? (strOrEmpty(c.last_name) || null) : null,
                alternate_number:         strOrEmpty(c.alternate_number) || null,
                landline:                   strOrEmpty(c.landline) || null,
                tax_number:                 strOrEmpty(c.tax_number) || null,
            };
            if (kind === 'business' && !out.name) {
                out.name = strOrEmpty(c.supplier_business_name) || out.name;
            }
            return out;
        };

        const mapPendingRowToCustomer = (p) => ({
            id:                   `lc:${p.local_customer_uuid}`,
            local_customer_uuid:  p.local_customer_uuid,
            name:                 computePendingDisplayName(p),
            phone:                strOrEmpty(p.mobile),
            email:                p.email || '',
            address:              strOrEmpty(p.address_line_1 ?? p.address),
            address_line_1:       strOrEmpty(p.address_line_1 ?? p.address),
            address_line_2:       strOrEmpty(p.address_line_2),
            city:                 strOrEmpty(p.city),
            state:                strOrEmpty(p.state),
            country:              strOrEmpty(p.country),
            zip_code:             strOrEmpty(p.zip_code),
            contact_kind:         p.contact_kind === 'business' ? 'business' : 'individual',
            supplier_business_name: strOrEmpty(p.supplier_business_name),
            prefix:               strOrEmpty(p.prefix),
            first_name:           strOrEmpty(p.first_name),
            middle_name:          strOrEmpty(p.middle_name),
            last_name:            strOrEmpty(p.last_name),
            alternate_number:     strOrEmpty(p.alternate_number),
            landline:             strOrEmpty(p.landline),
            tax_number:           strOrEmpty(p.tax_number),
            customer_group_id:    p.customer_group_id ?? null,
            cloud_contact_id:     p.cloud_contact_id ?? null,
            pending_sync:         true,
            balance:              0,
            credit_limit:         0,
            reward_points:        0,
        });

        const refreshCustomerList = async () => {
            const synced = await db.customers.toArray();
            const pendingRows = await db.pending_customers.filter((pc) => pc.cloud_contact_id == null).toArray();
            const pendingMapped = pendingRows.map(mapPendingRowToCustomer);
            customers.value = [...pendingMapped, ...synced];
        };

        const mapApiCustomerRowToCustomerRecord = (c) => ({
            id:                   c.contact_id,
            name:                 c.name   || '',
            phone:                c.mobile || '',
            email:                c.email  || '',
            tax_number:           strOrEmpty(c.tax_number),
            balance:              +(c.balance        || 0),
            credit_limit:         +(c.credit_limit   || 0),
            reward_points:        +(c.total_rp       || c.reward_points || 0),
            cloud_contact_id:     c.contact_id,
            local_customer_uuid:  c.local_customer_uuid || null,
        });

        const customerRowUpdatedAtMs = (c) => {
            const raw = c?.updated_at ?? c?.updatedAt;
            if (raw == null) return null;
            const ts = Date.parse(String(raw));
            return Number.isFinite(ts) ? ts : null;
        };

        /** Watermark for GET /api/sync/customers?since=… (ISO 8601 UTC). */
        const persistCustomersSyncWatermark = async (msOrIso) => {
            let ms;
            if (typeof msOrIso === 'number' && Number.isFinite(msOrIso)) ms = msOrIso;
            else if (typeof msOrIso === 'string' && String(msOrIso).trim()) {
                const ts = Date.parse(String(msOrIso).trim());
                ms = Number.isFinite(ts) ? ts : Date.now();
            } else {
                ms = Date.now();
            }
            await db.settings.put({ key: 'customers_sync_since_iso', data: new Date(ms).toISOString() });
        };

        /**
         * Incremental customer pull after uploads (or when watermark exists).
         * Requires `customers_sync_since_iso` from a prior full sync.
         */
        const pullCustomersDeltaSinceWatermark = async (opts = {}) => {
            const quiet = !!opts.quiet;
            if (!hasSyncCredentials() || !isOnline.value) return { ran: false, count: 0 };
            const rec = await db.settings.get('customers_sync_since_iso');
            const since = rec?.data != null && String(rec.data).trim() !== '' ? String(rec.data).trim() : null;
            if (!since) return { ran: false, count: 0 };

            let total = 0;
            let maxTs = null;
            try {
                await paginatedFetch(
                    '/api/sync/customers',
                    async (rows) => {
                        for (const c of rows || []) {
                            const ts = customerRowUpdatedAtMs(c);
                            if (ts != null && (maxTs == null || ts > maxTs)) maxTs = ts;
                        }
                        const batch = (rows || []).map(mapApiCustomerRowToCustomerRecord);
                        if (batch.length) {
                            await db.customers.bulkPut(batch);
                            total += batch.length;
                        }
                    },
                    `since=${encodeURIComponent(since)}`,
                );
            } catch (e) {
                addLog(`customers delta (since): ${e.message}`, 'warn');
                return { ran: false, count: 0, error: e.message };
            }

            await refreshCustomerList();
            if (total > 0) await persistCustomersSyncWatermark(maxTs ?? Date.now());
            if (total > 0 && !quiet) addLog(`Customer delta pull: ${total} row(s).`);
            return { ran: true, count: total };
        };

        const findCustomerInList = (customerId) => {
            if (customerId == null || customerId === '') return null;
            let c = customers.value.find((x) => x.id == customerId);
            if (c) return c;
            if (typeof customerId === 'string' && customerId.startsWith('lc:')) {
                const luk = customerId.slice(3);
                c = customers.value.find((x) => x.local_customer_uuid === luk);
                if (c) return c;
            }
            return null;
        };

        const selectCustomer = (c) => {
            selectedCustomer.value     = c;
            selectedCustomerName.value = c.name;
            showCustomerDropdown.value = false;
        };

        const clearCustomer = () => {
            selectedCustomer.value     = null;
            selectedCustomerName.value = '';
            showCustomerDropdown.value = false;
        };

        const openAddCustomerModal = () => {
            newCustomerForm.value = {
                contact_kind:             'individual',
                name:                     '',
                mobile:                   '',
                prefix:                   '',
                first_name:               '',
                middle_name:              '',
                last_name:                '',
                supplier_business_name:   '',
                email:                    '',
                alternate_number:         '',
                landline:                 '',
                tax_number:               '',
                address_line_1:           '',
                address_line_2:           '',
                city:                     '',
                state:                    '',
                country:                  '',
                zip_code:                 '',
                customer_group_id:        '',
            };
            newCustomerFieldErrors.value = {};
            showAddCustomerModal.value = true;
        };

        const dismissAddCustomerModal = () => {
            showAddCustomerModal.value = false;
        };

        /** Push unsynced pending_customers to POST /api/sync/create-customer */
        const syncPendingCustomersOutbox = async () => {
            if (!hasSyncCredentials()) return;
            const rows = await db.pending_customers.filter((pc) => pc.cloud_contact_id == null).toArray();
            if (!rows.length) return;

            const url = `${settings.value.serverUrl}/api/sync/create-customer`;
            let toasted422 = false;
            for (const row of rows) {
                try {
                    const mobile = strOrEmpty(row.mobile);
                    if (!mobile) {
                        addLog(`create-customer skipped (no mobile): ${row.local_customer_uuid}`, 'warn');
                        continue;
                    }
                    const res = await fetch(url, {
                        method:  'POST',
                        headers: apiHeaders(),
                        body:    JSON.stringify(buildCreateCustomerPayloadFromPendingRow(row)),
                    });
                    const txt = await res.text();
                    let data = null;
                    try { data = txt ? JSON.parse(txt) : null; } catch { /* ignore */ }

                    if (res.status === 422 && data?.errors) {
                        addLog(
                            `create-customer validation (${row.local_customer_uuid}): ${JSON.stringify(data.errors)}`,
                            'warn',
                        );
                        if (!toasted422) {
                            toasted422 = true;
                            const flat = Object.values(data.errors).flat().map((x) => String(x)).join(' ');
                            toast(flat || data.message || t('server_rejected_customer'), 'error', 8000);
                        }
                        continue;
                    }
                    if (res.status === 401) {
                        notifySyncUnauthorized();
                        break;
                    }
                    if (!res.ok || !data?.success || data.contact_id == null) {
                        addLog(`create-customer HTTP ${res.status} for ${row.local_customer_uuid}`, 'warn');
                        continue;
                    }

                    const cid = +data.contact_id;
                    const now = new Date().toISOString();
                    await db.pending_customers.update(row.local_customer_uuid, {
                        cloud_contact_id: cid,
                        synced_at:        now,
                    });
                    await db.customers.put({
                        id:                   cid,
                        name:                 data.name ?? row.name,
                        phone:                data.mobile ?? row.mobile ?? '',
                        email:                data.email ?? row.email ?? '',
                        tax_number:           strOrEmpty(data.tax_number) || strOrEmpty(row.tax_number) || '',
                        balance:              0,
                        credit_limit:         0,
                        reward_points:        0,
                        cloud_contact_id:     cid,
                        local_customer_uuid:  row.local_customer_uuid,
                    });
                } catch (e) {
                    addLog('create-customer: ' + e.message, 'warn');
                }
            }
            await refreshCustomerList();

            const sel = selectedCustomer.value;
            if (sel?.local_customer_uuid) {
                const updated = customers.value.find(
                    (c) => c.local_customer_uuid === sel.local_customer_uuid,
                );
                if (updated) selectCustomer(updated);
            }
        };

        const submitNewCustomer = async () => {
            newCustomerFieldErrors.value = {};
            const f = newCustomerForm.value;
            const mobile = strOrEmpty(f.mobile);
            if (!mobile) {
                newCustomerFieldErrors.value = { mobile: [t('mobile_required_for_cloud')] };
                return;
            }
            const kind = f.contact_kind === 'business' ? 'business' : 'individual';
            if (kind === 'business') {
                const bn = strOrEmpty(f.supplier_business_name);
                if (!bn) {
                    newCustomerFieldErrors.value = { supplier_business_name: [t('business_name_required')] };
                    return;
                }
            } else if (!strOrEmpty(f.first_name)) {
                newCustomerFieldErrors.value = { first_name: [t('first_name_required')] };
                return;
            }

            const uuid = crypto.randomUUID();
            const email = strOrEmpty(f.email) || null;
            let groupId = null;
            if (f.customer_group_id !== '' && f.customer_group_id != null) {
                const n = +f.customer_group_id;
                if (Number.isFinite(n)) groupId = n;
            }

            const row = {
                local_customer_uuid: uuid,
                contact_kind:        kind,
                name:                strOrEmpty(f.name),
                mobile,
                prefix:              strOrEmpty(f.prefix) || null,
                first_name:          strOrEmpty(f.first_name) || null,
                middle_name:         strOrEmpty(f.middle_name) || null,
                last_name:           strOrEmpty(f.last_name) || null,
                supplier_business_name: kind === 'business' ? strOrEmpty(f.supplier_business_name) : null,
                email,
                alternate_number:    strOrEmpty(f.alternate_number) || null,
                landline:            strOrEmpty(f.landline) || null,
                tax_number:          strOrEmpty(f.tax_number) || null,
                address_line_1:      strOrEmpty(f.address_line_1) || null,
                address_line_2:      strOrEmpty(f.address_line_2) || null,
                city:                strOrEmpty(f.city) || null,
                state:               strOrEmpty(f.state) || null,
                country:             strOrEmpty(f.country) || null,
                zip_code:            strOrEmpty(f.zip_code) || null,
                customer_group_id:   groupId,
                cloud_contact_id:    null,
                synced_at:           null,
                created_at:          new Date().toISOString(),
            };
            row.name = computePendingDisplayName(row);

            await db.pending_customers.add(row);
            await refreshCustomerList();
            const added = customers.value.find((c) => c.local_customer_uuid === uuid);
            if (added) selectCustomer(added);
            dismissAddCustomerModal();
            toast(t('customer_added_locally'), 'success');
            if (hasSyncCredentials() && isOnline.value) await syncPendingCustomersOutbox();
        };

        // ════════════════════════════════════════════════════════════════════
        // LINE EDIT
        // ════════════════════════════════════════════════════════════════════

        const openLineEdit = (idx) => {
            editingIndex.value      = idx;
            editingItem.value       = { ...cart.value[idx] };
            showLineEditModal.value = true;
        };

        const saveLineItem = () => {
            if (editingIndex.value !== null) {
                cart.value[editingIndex.value] = { ...editingItem.value };
            }
            showLineEditModal.value = false;
        };

        // ════════════════════════════════════════════════════════════════════
        // MODIFIER MODAL
        // ════════════════════════════════════════════════════════════════════

        const openModifierModal = (product) => {
            pendingProductForModifier.value = product;
            tempModifierSelections.value    = {};
            (product.modifier_sets || []).forEach(set => {
                if (set.options?.length) {
                    tempModifierSelections.value[set.name] = set.options[0];
                }
            });
            showModifierModal.value = true;
        };

        const confirmModifiers = () => {
            const product = pendingProductForModifier.value;
            if (!product) return;
            const selected_modifiers = Object.entries(tempModifierSelections.value).map(([setName, opt]) => ({
                modifier_set_name: setName,
                option_name: opt.name,
                price: +(opt.price || 0),
            }));
            const modifierTotal = selected_modifiers.reduce((s, m) => s + m.price, 0);
            cart.value.push(buildCartItem(product, selected_modifiers, modifierTotal, null));
            showModifierModal.value           = false;
            pendingProductForModifier.value   = null;
        };

        // ════════════════════════════════════════════════════════════════════
        // LOT MODAL
        // ════════════════════════════════════════════════════════════════════

        const openLotModal = (product) => {
            pendingProductForLot.value = product;
            selectedLot.value          = (product.lots || [])[0] || null;
            showLotModal.value         = true;
        };

        const confirmLot = () => {
            const product = pendingProductForLot.value;
            if (!product) return;
            cart.value.push(buildCartItem(product, [], 0, selectedLot.value));
            showLotModal.value         = false;
            pendingProductForLot.value = null;
            selectedLot.value          = null;
        };

        // ════════════════════════════════════════════════════════════════════
        // REWARD POINTS
        // ════════════════════════════════════════════════════════════════════

        const applyRewardPoints = () => {
            if (!rpAmountPerPoint.value) { toast(t('reward_rate_not_configured'), 'error'); return; }
            const pts = Math.min(Math.max(0, +rpRedeemed.value || 0), maxRpRedeemable.value);
            rpRedeemed.value       = pts;
            rpRedeemedAmount.value = +(pts * rpAmountPerPoint.value).toFixed(2);
        };

        const removeRewardPoints = () => {
            rpRedeemed.value       = 0;
            rpRedeemedAmount.value = 0;
        };

        // ════════════════════════════════════════════════════════════════════
        // HOLD / SUSPEND
        // ════════════════════════════════════════════════════════════════════

        const openSuspendModal = () => {
            if (!cart.value.length) return;
            suspendNote.value      = '';
            showSuspendModal.value = true;
        };

        // Bug 4 fix: persist full order-level state so resume restores totals exactly
        const heldSaleSnapshot = () => ({
            customer_id:             selectedCustomer.value?.id    || null,
            customer_name:           selectedCustomer.value?.name  || '',
            customer_phone:          selectedCustomer.value?.phone || '',
            items:                   cloneForIdb(cart.value),
            discount_type:           discountType.value,
            discount_input:          orderDiscountInput.value,
            sale_note:               saleNote.value,
            staff_note:              staffNote.value,
            shipping_charges:        shippingCharges.value,
            shipping_details:        shippingDetails.value,
            shipping_address:        shippingAddress.value,
            shipping_status:         shippingStatus.value,
            delivered_to:            deliveredTo.value,
            delivery_person:         deliveryPerson.value,
            packing_charge:          packingCharge.value,
            rp_redeemed:             rpRedeemed.value,
            rp_redeemed_amount:      rpRedeemedAmount.value,
            commission_agent_id:     commissionAgentId.value,
            price_group_id:          selectedPriceGroupId.value,
            invoice_scheme_id:       invoiceSchemeId.value,
            transaction_date:        transactionDate.value,
            tax_rate_id:             selectedOrderTaxRateId.value,
            enable_round_off:        enableRoundOff.value,
            held_at:                 new Date().toISOString(),
        });

        const confirmSuspend = async () => {
            await db.held_sales.add({ ...heldSaleSnapshot(), suspend_note: suspendNote.value });
            resetCart();
            await loadHeldSales();
            showSuspendModal.value = false;
            toast(t('sale_held'), 'success');
        };

        const holdSale = async () => {
            if (!cart.value.length) return;
            await db.held_sales.add(heldSaleSnapshot());
            resetCart();
            await loadHeldSales();
            toast(t('sale_held_resumable'), 'success');
        };

        const loadHeldSales = async () => {
            heldSales.value = await db.held_sales.toArray();
        };

        const resumeHeldSale = async (held) => {
            if (cart.value.length && !confirm(t('confirm_replace_cart_with_held'))) return;
            resetCart();
            cart.value               = normalizeCartItems(held.items);
            discountType.value       = held.discount_type  || 'percentage';
            orderDiscountInput.value = held.discount_input || 0;
            saleNote.value           = held.sale_note      || '';
            staffNote.value          = held.staff_note     || '';
            // Bug 4 fix: restore all order-level fields
            shippingCharges.value        = held.shipping_charges    || 0;
            shippingDetails.value        = held.shipping_details    || '';
            shippingAddress.value        = held.shipping_address    || '';
            shippingStatus.value         = held.shipping_status     || '';
            deliveredTo.value            = held.delivered_to        || '';
            deliveryPerson.value         = held.delivery_person     || '';
            packingCharge.value          = held.packing_charge      || 0;
            rpRedeemed.value             = held.rp_redeemed         || 0;
            rpRedeemedAmount.value       = held.rp_redeemed_amount  || 0;
            commissionAgentId.value      = held.commission_agent_id || '';
            selectedPriceGroupId.value   = held.price_group_id      || '';
            invoiceSchemeId.value        = held.invoice_scheme_id   || '';
            transactionDate.value        = held.transaction_date    || new Date().toISOString().slice(0, 16);
            selectedOrderTaxRateId.value = held.tax_rate_id         || '';
            enableRoundOff.value         = held.enable_round_off    || false;
            if (held.customer_id) {
                const c = findCustomerInList(held.customer_id);
                if (c) selectCustomer(c);
                else selectedCustomerName.value = held.customer_name || '';
            }
            await db.held_sales.delete(held.id);
            await loadHeldSales();
            currentPage.value = 'pos';
            toast(t('sale_resumed'), 'success');
        };

        const deleteHeldSale = async (held) => {
            if (!confirm(t('confirm_delete_held'))) return;
            await db.held_sales.delete(held.id);
            await loadHeldSales();
        };

        // ════════════════════════════════════════════════════════════════════
        // RECENT TRANSACTIONS
        // ════════════════════════════════════════════════════════════════════

        const openRecentTransactions = () => {
            recentTransTab.value              = 'final';
            showRecentTransactionsModal.value = true;
        };

        const resumeFromRecent = async (sale) => {
            if (cart.value.length && !confirm(t('confirm_replace_cart_with_sale'))) return;
            resetCart();
            cart.value               = normalizeCartItems((sale.items || []).map(i => ({ ...i })));
            discountType.value       = sale.discount_type  || 'percentage';
            orderDiscountInput.value = sale.discount_input || 0;
            saleNote.value           = sale.sale_note      || '';
            staffNote.value          = sale.staff_note     || '';
            // Bug 4 fix: restore full order-level state from the transaction record
            shippingCharges.value        = sale.shipping_charges    || 0;
            shippingDetails.value        = sale.shipping_details    || '';
            shippingAddress.value        = sale.shipping_address    || '';
            shippingStatus.value         = sale.shipping_status     || '';
            deliveredTo.value            = sale.delivered_to        || '';
            deliveryPerson.value         = sale.delivery_person     || '';
            packingCharge.value          = sale.packing_charge      || 0;
            rpRedeemed.value             = sale.rp_redeemed         || 0;
            rpRedeemedAmount.value       = sale.rp_redeemed_amount  || 0;
            commissionAgentId.value      = sale.commission_agent_id || '';
            selectedPriceGroupId.value   = sale.price_group_id      || '';
            invoiceSchemeId.value        = sale.invoice_scheme_id   || '';
            transactionDate.value        = sale.transaction_date    || new Date().toISOString().slice(0, 16);
            selectedOrderTaxRateId.value = sale.tax_rate_id         || '';
            if (sale.customer_id) {
                const c = findCustomerInList(sale.customer_id);
                if (c) selectCustomer(c);
            }
            showRecentTransactionsModal.value = false;
            toast(t('sale_loaded'), 'success');
        };

        // ════════════════════════════════════════════════════════════════════
        // PAYMENT
        // ════════════════════════════════════════════════════════════════════

        const openPaymentModal = () => {
            payments.value         = [{ method: 'cash', amount: grandTotal.value }];
            showPaymentModal.value = true;
        };

        const addPaymentRow = (method = 'cash') => {
            payments.value.push({
                method, amount: 0,
                card_number: '', card_holder: '', card_type: 'credit',
                card_exp_month: '', card_exp_year: '', card_security_code: '',
                cheque_number: '', bank_account_number: '', transaction_number: '',
            });
        };

        const buildTransaction = async (paysArr) => {
            const paid = paysArr.reduce((s, p) => s + (p.amount || 0), 0);

            // Compute VAT
            const cartItems   = cart.value;
            const linesNetInc = cartItems.reduce((s, i) => s + lineNet(i), 0);
            const linesNetTax = cartItems.reduce((s, i) => {
                const tp  = i.tax_percent || 0;
                const net = lineNet(i);
                return s + (tp > 0 ? net * tp / (100 + tp) : 0);
            }, 0);
            // Bug 2 fix: tax base must be subtotal−orderDiscount (goods only), not grandTotal
            // (grandTotal includes shipping/packing/round-off which are non-taxable)
            const taxBase = subtotal.value - orderDiscount.value;
            const taxAmt  = linesNetInc > 0
                ? +(linesNetTax * (taxBase > 0 ? taxBase : linesNetInc) / linesNetInc).toFixed(4)
                : +linesNetTax.toFixed(4);

            const saleUuid   = crypto.randomUUID();
            const invoice_no = await nextInvoiceNo(saleStatus.value || 'final');

            const tx = {
                local_uuid:      saleUuid,
                invoice_no,
                location_id:     settings.value.locationId,
                type:            'sell',
                status:          saleStatus.value || 'final',
                customer_id:        selectedCustomer.value?.id    || null,
                customer_name:      selectedCustomer.value?.name  || 'Walk-in',
                customer_phone:     selectedCustomer.value?.phone || null,
                local_customer_uuid: selectedCustomer.value?.local_customer_uuid || null,
                new_customer:       buildNewCustomerForTransaction(selectedCustomer.value),
                items:           cloneForIdb(cart.value),
                subtotal_gross:  subtotalGross.value,
                total_line_disc: totalLineDisc.value,
                subtotal:        subtotal.value,
                tax:             taxAmt,
                discount:        orderDiscount.value,
                discount_type:   discountType.value,
                discount_input:  orderDiscountInput.value,
                total:           grandTotal.value,
                paid,
                payments:        cloneForIdb(paysArr),
                payment_status:  paid >= grandTotal.value - 0.005 ? 'paid' : paid > 0 ? 'partial' : 'due',
                sale_note:       saleNote.value  || null,
                staff_note:      staffNote.value || null,
                sync_status:     'pending',
                created_at:      new Date().toISOString(),
                // Shipping
                shipping_charges:  shippingCharges.value,
                shipping_details:  shippingDetails.value  || null,
                shipping_address:  shippingAddress.value  || null,
                shipping_status:   shippingStatus.value   || null,
                delivered_to:      deliveredTo.value       || null,
                delivery_person:   deliveryPerson.value    || null,
                // Extras
                packing_charge:          packingCharge.value,
                rp_redeemed:             rpRedeemed.value,
                rp_redeemed_amount:      rpRedeemedAmount.value,
                commission_agent_id:     commissionAgentId.value  || null,
                price_group_id:          selectedPriceGroupId.value || null,
                invoice_scheme_id:       invoiceSchemeId.value      || null,
                transaction_date:        transactionDate.value,
                tax_rate_id:             selectedOrderTaxRateId.value || null,
                round_off_amount:        roundOffAmount.value,
                // Change return
                change_return_amount:    changeReturn.value,
                change_return_method:    changeReturnMethod.value,
                // ZATCA
                zatca_qr_code:   null,
                zatca_hash:      null,
            };

            // ── ZATCA offline QR generation ───────────────────────
            if (
                zatcaCertificate.value &&
                tx.status === 'final' &&
                typeof generateZatcaQr === 'function'
            ) {
                try {
                    const loc         = locations.value.find(l => String(l.id) === String(settings.value.locationId)) || {};
                    const prevHashRec = await db.settings.get('zatca_last_hash');
                    const icvRec      = await db.settings.get('zatca_icv');
                    const prevHash    = prevHashRec?.data || null;
                    const icv         = (icvRec?.data || 0) + 1;

                    const zatcaResult = await generateZatcaQr(
                        tx, business.value, loc, zatcaCertificate.value, prevHash, icv
                    );

                    if (zatcaResult) {
                        tx.zatca_qr_code = zatcaResult.zatca_qr_code;
                        tx.zatca_hash    = zatcaResult.zatca_hash;
                        // Bug 5 fix: write hash + ICV atomically so they never diverge on error
                        await db.transaction('rw', db.settings, async () => {
                            await db.settings.put({ key: 'zatca_last_hash', data: zatcaResult.zatca_hash });
                            await db.settings.put({ key: 'zatca_icv',       data: icv });
                        });
                    }
                } catch (e) {
                    console.error('[ZATCA] QR generation error:', e);
                    toast('[ZATCA] ' + e.message, 'error', 8000);
                }
            }

            return tx;
        };

        const saveTransaction = async (tx) => {
            const id = await db.transactions.add(cloneForIdb(tx));
            lastReceipt.value = { ...tx, id };
            resetCart();
            await loadSales();
            // Bug 10 fix: await auto-backup to prevent concurrent writes corrupting the file
            if (autoBackupEnabled.value && autoBackupFileHandle.value) {
                await writeAutoBackup();
            }
            refocusSearch();
        };

        // Express Cash
        // Helper: temporarily force status to 'final', build tx, restore
        const buildFinalTransaction = async (paysArr) => {
            const prev = saleStatus.value;
            saleStatus.value = 'final';
            const tx = await buildTransaction(paysArr);
            saleStatus.value = prev;
            return tx;
        };

        const expressCash = async () => {
            if (!cart.value.length) return;
            if (!settings.value.locationId) { toast(t('select_location_first_error'), 'error'); return; }
            if (blockSaleIfRegisterClosed()) return;
            if (blockSaleIfPhase2Offline()) return;
            const tx = await buildFinalTransaction([{ method: 'cash', amount: grandTotal.value }]);
            await saveTransaction(tx);
            toast(t('sale_saved'), 'success');
            printReceipt(lastReceipt.value, { silent: true });
            if ((sublocation.value?.zatca_phase ?? 1) === 2) pushSales().catch(() => {});
        };

        // Express Card
        const expressCard = async () => {
            if (!cart.value.length) return;
            if (!settings.value.locationId) { toast(t('select_location_first_error'), 'error'); return; }
            if (blockSaleIfRegisterClosed()) return;
            if (blockSaleIfPhase2Offline()) return;
            const tx = await buildFinalTransaction([{ method: 'card', amount: grandTotal.value }]);
            await saveTransaction(tx);
            toast(t('sale_saved_card'), 'success');
            printReceipt(lastReceipt.value, { silent: true });
            if ((sublocation.value?.zatca_phase ?? 1) === 2) pushSales().catch(() => {});
        };

        // Credit Sale (due)
        const expressCreditSale = async () => {
            if (!cart.value.length) return;
            if (!settings.value.locationId) { toast(t('select_location_first_error'), 'error'); return; }
            if (blockSaleIfRegisterClosed()) return;
            if (blockSaleIfPhase2Offline()) return;
            const tx = await buildFinalTransaction([]);
            tx.payment_status = 'due';
            await saveTransaction(tx);
            toast(t('sale_saved_credit'), 'success');
            printReceipt(lastReceipt.value, { silent: true });
            if ((sublocation.value?.zatca_phase ?? 1) === 2) pushSales().catch(() => {});
        };

        // Save as draft or quotation (bypasses payment modal)
        // Bug 3 fix: removed prev/restore — resetCart() inside saveTransaction sets
        // saleStatus back to 'final', so the old restore was drifting it to 'draft'.
        const saveSale = async (status) => {
            if (!cart.value.length) return;
            if (!settings.value.locationId) { toast(t('select_location_first_error'), 'error'); return; }
            if (blockSaleIfPhase2Offline()) return;
            saleStatus.value = status;
            const tx = await buildTransaction([]);
            tx.payment_status = 'due';
            await saveTransaction(tx); // resetCart() resets saleStatus to 'final'
            const label = status === 'draft' ? t('label_draft') : t('label_quotation');
            toast(t('saved_label', { label }), 'success');
            if ((sublocation.value?.zatca_phase ?? 1) === 2) pushSales().catch(() => {});
        };

        // Process payment from modal — always final regardless of status pill
        const processPayment = async () => {
            if (!cart.value.length) return;
            if (!settings.value.locationId) { toast(t('select_location_first_error'), 'error'); return; }
            if (hasOpenRegister.value === false) {
                // Close the payment modal first so the open-cashier modal doesn't stack on top.
                showPaymentModal.value = false;
                openOpenRegisterFlow({ silentIfBusy: true, force: true });
                return;
            }
            if (blockSaleIfPhase2Offline()) return;
            const tx = await buildFinalTransaction(payments.value);
            await saveTransaction(tx);
            showPaymentModal.value = false;
            toast(t('payment_completed'), 'success');
            printReceipt(lastReceipt.value, { silent: true });
            if ((sublocation.value?.zatca_phase ?? 1) === 2) pushSales().catch(() => {});
        };

        // ════════════════════════════════════════════════════════════════════
        // RECEIPT / PRINT
        // ════════════════════════════════════════════════════════════════════

        const printReceipt = async (sale, { silent = false } = {}) => {
            let receipt = getReceiptPayloadForSale(sale)
                || buildLocalReceiptPayload(
                    sale, settings.value, locations.value, printers.value,
                    invoiceLayouts.value, receiptTemplate.value, business.value, receiptTemplateDesign.value,
                    localPrinterName.value,
                    localPrinters.value,
                );
            if (!receipt) {
                if (!silent) toast(t('no_invoice_template'), 'error');
                return false;
            }

            // Local tray printer selection must win even when a synced server_receipt exists.
            if (localPrinterName.value) {
                const location = (typeof getLocationForSale === 'function')
                    ? (getLocationForSale(sale, locations.value, settings.value) || {})
                    : {};
                const resolved = (typeof resolvePrinterForLocalPrint === 'function')
                    ? resolvePrinterForLocalPrint(location, printers.value, localPrinters.value, localPrinterName.value)
                    : null;
                if (resolved && resolved.printer) {
                    receipt = {
                        ...receipt,
                        print_type: 'printer',
                        printer_config: resolved.printer,
                    };
                }
            }

            // Android mobile printer selection (Bluetooth / WiFi) — set via the mobile
            // Settings > Printers screen. No effect on desktop (window.platformAPI.isCapacitor() is false there).
            if (window.platformAPI?.isCapacitor?.()) {
                if (selectedPrinterType.value === 'bluetooth' && selectedBluetoothPrinterInfo.value?.address) {
                    receipt = {
                        ...receipt,
                        print_type: 'bluetooth_android',
                        bluetooth_printer_address: selectedBluetoothPrinterInfo.value.address,
                        bluetooth_printer_name: selectedBluetoothPrinterInfo.value.name || '',
                    };
                } else if (selectedPrinterType.value === 'wifi' && wifiPrinterIp.value) {
                    receipt = {
                        ...receipt,
                        print_type: 'wifi_android',
                        wifi_printer_ip_address: wifiPrinterIp.value,
                        wifi_printer_name: t('m_wifi_printer'),
                    };
                }
            }

            if (!receipt.is_enabled) {
                if (!silent) toast(t('receipt_print_disabled'), 'error');
                return false;
            }
            primePrinterSelection(receipt);

            // Native printer bridge (Electron / Android WebView)
            if (window.zatReceiptPrintRouter && typeof window.zatReceiptPrintRouter.print === 'function') {
            try {
                await window.zatReceiptPrintRouter.print(receipt);
                return true;
            } catch (e) {
                toast(t('print_failed', { error: e.message }), 'error');
                return false;
            }
            }

            // PWA / browser fallback: open html_content in a print window
            const html = receipt.html_content;
            if (!html) {
                if (!silent) toast(t('no_content_to_print'), 'error');
                return false;
            }
            const win = window.open('', '_blank', 'width=800,height=600');
            if (!win) {
                if (!silent) toast(t('cant_open_print_window'), 'error');
                return false;
            }
            win.document.write(html);
            win.document.close();
            win.focus();
            win.print();
            win.onafterprint = () => win.close();
            return true;
        };

        // ════════════════════════════════════════════════════════════════════
        // OFFLINE RETURNS
        // ════════════════════════════════════════════════════════════════════

        const returnTotal = computed(() =>
            (returnItems.value || []).reduce((sum, i) => {
                const qty = parseFloat(i.return_qty) || 0;
                return sum + qty * (parseFloat(i.unit_price) || 0);
            }, 0)
        );

        const openReturnModal = (sale) => {
            returningFromSale.value = sale;
            returnItems.value       = (sale.items || []).map(i => ({ ...i, return_qty: 0 }));
            // Bug 9 fix: default refund method to the original payment method
            returnMethod.value      = sale.payments?.[0]?.method || 'cash';
            showReturnModal.value   = true;
        };

        const selectAllReturnItems = () => {
            returnItems.value = (returnItems.value || []).map(item => ({
                ...item,
                return_qty: parseFloat(item.quantity) || 0
            }));
        };

        const saveReturn = async () => {
            const items = returnItems.value.filter(i => (parseFloat(i.return_qty) || 0) > 0);
            if (!items.length) { toast(t('select_return_qty'), 'error'); return; }
            if (blockSaleIfPhase2Offline()) return;
            const sale  = returningFromSale.value;
            const total = returnTotal.value;
            const rec = {
                type:                       'sell_return',
                return_parent_invoice_no:   sale.server_invoice_no || sale.invoice_no,
                local_uuid:                 crypto.randomUUID(),
                location_id:                sale.location_id || settings.value.locationId,
                items:                      items.map(i => ({ ...i, quantity: parseFloat(i.return_qty) || 0 })),
                total,
                payments:                   [{ method: returnMethod.value, amount: total, is_return: true }],
                sync_status:                'pending',
                created_at:                 new Date().toISOString(),
            };
            await db.transactions.add(cloneForIdb(rec));
            await loadSales();
            showReturnModal.value   = false;
            returningFromSale.value = null;
            returnItems.value       = [];
            toast(t('return_saved'), 'success');
            if ((sublocation.value?.zatca_phase ?? 1) === 2) pushSales().catch(() => {});
        };

        // ════════════════════════════════════════════════════════════════════
        // SALES LIST
        // ════════════════════════════════════════════════════════════════════

        const loadSales = async () => {
            sales.value = await db.transactions.toArray();
        };

        const viewSale = (s) => { viewingSale.value = s; };

        const retrySingle = async (s) => {
            await db.transactions.update(s.id, { sync_status: 'pending', sync_error: null, sync_attempts: 0 });
            await loadSales();
        };

        /** Remove one non-synced row from IndexedDB (e.g. stuck pending / unrecoverable failed). Never for synced invoices. */
        const discardLocalUnsyncedSale = async (s) => {
            if (!s?.id || s.sync_status === 'synced') {
                toast(t('cant_delete_synced_this_way'), 'error');
                return;
            }
            const ok = confirm(t('confirm_delete_local_invoice'));
            if (!ok) return;
            await db.transactions.delete(s.id);
            if (viewingSale.value?.id === s.id) viewingSale.value = null;
            await loadSales();
            toast(t('invoice_deleted_from_device'), 'success');
        };

        // ════════════════════════════════════════════════════════════════════
        // SETTINGS / BOOT
        // ════════════════════════════════════════════════════════════════════

        const loadSettings = async () => {
            const cfg = await db.settings.get('config');
            if (cfg) {
                // Support both new format { key, data: {...} } and old format { key, serverUrl, ... }
                if (cfg.data && typeof cfg.data === 'object') {
                    settings.value = { ...settings.value, ...cfg.data };
                } else {
                    const { key, ...cfgData } = cfg; // eslint-disable-line no-unused-vars
                    settings.value = { ...settings.value, ...cfgData };
                }
                delete settings.value.currencySymbol;
                delete settings.value.tokenExpiresAt;
            }

            const [cats, brnds, locs, biz, prn, ils, lsa, rtpl, rtplDesign, txRates,
                   commAg, prGrps, invSch, custGrp, localPrn, localPrs] = await Promise.all([
                db.settings.get('categories'),
                db.settings.get('brands'),
                db.settings.get('locations'),
                db.settings.get('business'),
                db.settings.get('printers'),
                db.settings.get('invoice_layouts'),
                db.settings.get('last_sync_at'),
                db.settings.get('receipt_template'),
                db.settings.get('receipt_template_design'),
                db.settings.get('tax_rates'),
                db.settings.get('commission_agents'),
                db.settings.get('price_groups'),
                db.settings.get('invoice_schemes'),
                db.settings.get('customer_groups'),
                db.settings.get('local_printer_config'),
                db.settings.get('printers_local'),
            ]);
            if (cats?.data)       categories.value           = cats.data;
            if (brnds?.data)      brands.value               = brnds.data;
            if (locs?.data)       locations.value            = locs.data;
            if (biz?.data)        business.value             = biz.data;
            if (prn?.data)        printers.value             = prn.data;
            localPrinters.value = Array.isArray(localPrs?.data) ? localPrs.data : [];
            localPrinterName.value = localPrn?.data?.name || '';
            if (ils?.data)        invoiceLayouts.value       = ils.data;
            if (lsa?.data)        lastSyncAt.value           = lsa.data;
            if (rtpl?.data)       receiptTemplate.value      = rtpl.data;
            if (rtplDesign?.data) receiptTemplateDesign.value = rtplDesign.data;
            if (txRates?.data)    taxRates.value             = txRates.data;
            if (commAg?.data)     commissionAgents.value     = commAg.data;
            if (prGrps?.data)     priceGroups.value          = prGrps.data;
            if (invSch?.data)     invoiceSchemes.value       = invSch.data;
            if (custGrp?.data && Array.isArray(custGrp.data)) customerGroups.value = custGrp.data;

            const mobilePrn = await db.settings.get('mobile_printer_config');
            if (mobilePrn?.data) {
                selectedPrinterType.value = mobilePrn.data.type || '';
                selectedBluetoothPrinterInfo.value = mobilePrn.data.bluetooth || null;
                wifiPrinterIp.value = mobilePrn.data.wifiIp || '';
                if (selectedBluetoothPrinterInfo.value && window.zatSetBluetoothPrinter) {
                    window.zatSetBluetoothPrinter(selectedBluetoothPrinterInfo.value);
                }
            }

            const zatcaCert = await db.settings.get('zatca_certificate');
            if (zatcaCert?.data) zatcaCertificate.value = zatcaCert.data;
            const subloc = await db.settings.get('sublocation');
            sublocation.value = subloc?.data ?? null;

            const asRec = await db.settings.get('auto_sync_interval_seconds');
            if (sublocation.value) {
                autoSyncIntervalSeconds.value = normalizeAutoSyncIntervalSeconds(asRec?.data);
            } else {
                autoSyncIntervalSeconds.value = null;
            }

            const syncTokExp = await db.settings.get('sync_token_expires_at');
            if (syncTokExp?.data != null && String(syncTokExp.data).trim() !== '') {
                syncTokenExpiresAt.value = String(syncTokExp.data).trim();
            } else {
                syncTokenExpiresAt.value = null;
            }

            const cDisp = await db.settings.get('sync_cashier_display_name');
            if (cDisp?.data != null && String(cDisp.data).trim() !== '') {
                cashierDisplayName.value = String(cDisp.data).trim();
            } else {
                cashierDisplayName.value = '';
            }

            // Load payment methods config if stored
            const pmRec = await db.settings.get('payment_methods');
            if (pmRec?.data && Array.isArray(pmRec.data) && pmRec.data.length > 0) {
                paymentMethods.value = pmRec.data;
            }

            const crPerm = await db.settings.get('cash_register_permissions');
            if (crPerm?.data && typeof crPerm.data === 'object') {
                cashRegisterPermissions.value = {
                    view_cash_register:  !!crPerm.data.view_cash_register,
                    close_cash_register: !!crPerm.data.close_cash_register,
                };
            } else {
                cashRegisterPermissions.value = null;
            }

            const pfa = await db.settings.get('push_failure_audit');
            pushFailureAudit.value = Array.isArray(pfa?.data) ? pfa.data : [];

            const sfl = await db.settings.get('sync_failure_log');
            syncFailureLog.value = pruneSyncFailureLog(Array.isArray(sfl?.data) ? sfl.data : []);

            // Load auto-backup state
            const abEnabled = await db.settings.get('auto_backup_enabled');
            const abHandle  = await db.settings.get('auto_backup_handle');
            if (abEnabled?.data) autoBackupEnabled.value = true;
            if (abHandle?.data) {
                const handle = abHandle.data;
                // Re-request write permission on the restored handle (required after restart)
                try {
                    const perm = await handle.requestPermission({ mode: 'readwrite' });
                    if (perm === 'granted') {
                        autoBackupFileHandle.value = handle;
                    } else {
                        // Permission denied — clear the stored handle so user can re-enable
                        autoBackupEnabled.value = false;
                        await db.settings.delete('auto_backup_handle');
                        await db.settings.put({ key: 'auto_backup_enabled', data: false });
                    }
                } catch {
                    // API not available or handle stale — silently clear
                    autoBackupEnabled.value = false;
                }
            }
        };

        const persistConfig = async () => {
            // Bug 12 fix: wrap in { data: ... } so the primary key 'key' field never
            // spreads into settings.value on load
            await db.settings.put({ key: 'config', data: cloneForIdb(settings.value) });
        };

        const saveLocalPrinterConfig = async (name) => {
            localPrinterName.value = name || '';
            if (name) {
                await db.settings.put({ key: 'local_printer_config', data: { name } });
            } else {
                await db.settings.delete('local_printer_config');
            }
        };

        // ── Mobile (Android) printer picker: Bluetooth / WiFi ────────────────
        // Additive-only, used exclusively by mobile.html's Settings > Printers screen.
        const persistMobilePrinterConfig = async () => {
            await db.settings.put({
                key: 'mobile_printer_config',
                data: {
                    type: selectedPrinterType.value,
                    bluetooth: selectedBluetoothPrinterInfo.value,
                    wifiIp: wifiPrinterIp.value,
                },
            });
        };

        /** Ask the native Android shell to (re)send its paired-Bluetooth-device list. */
        const scanBluetoothPrinters = () => {
            isScanningBluetoothPrinters.value = true;
            try {
                window.ReactNativeWebView?.postMessage?.(JSON.stringify({ action: 'listBluetoothPrinters' }));
            } catch { /* ignore */ }
            setTimeout(() => { isScanningBluetoothPrinters.value = false; }, 3000);
        };

        const selectBluetoothPrinter = async (device) => {
            selectedBluetoothPrinterInfo.value = device ? { name: device.name || '', address: device.address || '' } : null;
            selectedPrinterType.value = device ? 'bluetooth' : '';
            if (window.zatSetBluetoothPrinter) window.zatSetBluetoothPrinter(device || null);
            await persistMobilePrinterConfig();
        };

        const saveWifiPrinterIp = async (ip) => {
            wifiPrinterIp.value = (ip || '').trim();
            selectedPrinterType.value = wifiPrinterIp.value ? 'wifi' : (selectedBluetoothPrinterInfo.value ? 'bluetooth' : '');
            await persistMobilePrinterConfig();
        };

        // ── Printer picker options (cloud + local, deduped by name) ──────────
        const printerPickerOptions = computed(() => {
            const map = new Map();
            (printers.value || []).forEach((p) => {
                if (!p || !p.name) return;
                map.set(String(p.name).toLowerCase(), { id: p.id, name: p.name, _local: false });
            });
            (localPrinters.value || []).forEach((p) => {
                if (!p || !p.name) return;
                map.set(String(p.name).toLowerCase(), { id: p.id, name: p.name, _local: true });
            });
            return Array.from(map.values());
        });

        // ── Local printer CRUD (tray only) ───────────────────────────────────
        const persistLocalPrinters = async () => {
            await db.settings.put({ key: 'printers_local', data: cloneForIdb(localPrinters.value) });
        };

        const openAddPrinterForm = () => {
            editingLocalPrinterId.value = null;
            printerForm.value = { name: '', tray_printer_name: '' };
            showPrinterFormModal.value = true;
            loadAvailableTrayPrinters();
        };

        const openEditPrinterForm = (p) => {
            editingLocalPrinterId.value = p.id;
            printerForm.value = {
                name: p.name || '',
                tray_printer_name: p.tray_printer_name || p.name || '',
            };
            showPrinterFormModal.value = true;
            loadAvailableTrayPrinters();
        };

        const savePrinterForm = async () => {
            const name = String(printerForm.value.name || '').trim();
            const trayName = String(printerForm.value.tray_printer_name || '').trim();
            if (!name) { toast(t('printer_name_required'), 'error'); return; }

            // Prevent duplicate label collisions
            const collision = localPrinters.value.find((p) =>
                p.id !== editingLocalPrinterId.value &&
                String(p.name).toLowerCase() === name.toLowerCase()
            );
            if (collision) { toast(t('printer_name_taken'), 'error'); return; }

            if (editingLocalPrinterId.value) {
                const oldName = (localPrinters.value.find((p) => p.id === editingLocalPrinterId.value) || {}).name;
                localPrinters.value = localPrinters.value.map((p) =>
                    p.id === editingLocalPrinterId.value
                        ? { ...p, name, tray_printer_name: trayName || name }
                        : p
                );
                if (oldName && localPrinterName.value === oldName) {
                    await saveLocalPrinterConfig(name);
                }
            } else {
                const id = 'local_' + (crypto.randomUUID ? crypto.randomUUID().replace(/-/g, '') : (Date.now().toString(36) + Math.random().toString(36).slice(2, 8)));
                localPrinters.value = [
                    ...localPrinters.value,
                    { id, name, tray_printer_name: trayName || name, connection_type: 'zat_tray', _local: true },
                ];
            }
            await persistLocalPrinters();
            showPrinterFormModal.value = false;
            toast(t('printer_saved'), 'success');
        };

        const deleteLocalPrinter = async (id) => {
            const target = localPrinters.value.find((p) => p.id === id);
            if (!target) return;
            if (!confirm(t('confirm_delete_printer', { name: target.name }))) return;
            localPrinters.value = localPrinters.value.filter((p) => p.id !== id);
            await persistLocalPrinters();
            if (localPrinterName.value === target.name) {
                await saveLocalPrinterConfig('');
            }
            toast(t('printer_deleted'), 'success');
        };

        // ── Tray bridge health + available printers ──────────────────────────
        const refreshTrayHealth = async () => {
            const tray = window.printerTray || {};
            if (typeof tray.getPrinterTrayHealth !== 'function') {
                trayHealth.value = { status: 'missing_script' };
                return;
            }
            trayHealth.value = { status: 'checking' };
            try {
                await tray.getPrinterTrayHealth();
                trayHealth.value = { status: 'healthy' };
            } catch (e) {
                trayHealth.value = { status: 'unreachable' };
            }
        };

        const loadAvailableTrayPrinters = async () => {
            const tray = window.printerTray || {};
            if (typeof tray.getAvailablePrinters !== 'function') {
                availableTrayPrinters.value = [];
                return;
            }
            isLoadingTrayPrinters.value = true;
            try {
                const list = await tray.getAvailablePrinters();
                const arr = Array.isArray(list) ? list : (Array.isArray(list?.printers) ? list.printers : []);
                availableTrayPrinters.value = arr
                    .map((p) => typeof p === 'string' ? { name: p } : { name: p && (p.name || p.printer || p.deviceName || '') })
                    .filter((p) => !!p.name);
            } catch (e) {
                availableTrayPrinters.value = [];
            } finally {
                isLoadingTrayPrinters.value = false;
            }
        };

        // Poll tray health while user is on the Printers tab
        let trayHealthPollTimer = null;
        const stopTrayHealthPoll = () => {
            if (trayHealthPollTimer) { clearInterval(trayHealthPollTimer); trayHealthPollTimer = null; }
        };

        const semverGt = (a, b) => {
            const pa = String(a).split('.').map(Number);
            const pb = String(b).split('.').map(Number);
            for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
                const na = pa[i] ?? 0, nb = pb[i] ?? 0;
                if (na > nb) return true;
                if (na < nb) return false;
            }
            return false;
        };

        const checkForUpdate = async () => {
            const serverUrl = String(settings.value.serverUrl || '').trim().replace(/\/+$/, '');
            if (!serverUrl || !isOnline.value || !appVersion) return;
            updateStatus.value = 'checking';
            try {
                const res = await fetch(`${serverUrl}/api/app-version/offline_pos`);
                if (!res.ok) throw new Error('HTTP ' + res.status);
                const data = await res.json();
                if (!data.version) throw new Error('No version');
                if (semverGt(data.version, appVersion)) {
                    updateStatus.value = 'update_available';
                    updateInfo.value   = { version: data.version, downloadUrl: data.download_url };
                } else {
                    updateStatus.value = 'up_to_date';
                    updateInfo.value   = null;
                }
            } catch {
                updateStatus.value = 'error';
            }
        };

        const openUpdateDownload = async (url) => {
            await window.api.openExternal(url);
        };

        watch([showSettings, settingsTab], ([open, tab]) => {
            stopTrayHealthPoll();
            if (open && tab === 'printers') {
                refreshTrayHealth();
                loadAvailableTrayPrinters();
                trayHealthPollTimer = setInterval(refreshTrayHealth, 8000);
            }
            if (open && tab === 'general' && updateStatus.value === 'idle') {
                checkForUpdate();
            }
        });
        onUnmounted(stopTrayHealthPoll);

        const readStoredConfigFromDb = async (idb) => {
            const cfg = await idb.settings.get('config');
            if (!cfg) return {};
            if (cfg.data && typeof cfg.data === 'object') return { ...cfg.data };
            const { key: _k, ...cfgData } = cfg;
            return { ...cfgData };
        };

        /** Same server URL + business location for every cashier profile on this device; each profile keeps its own token. */
        const propagateSharedSyncConnectionToOtherProfiles = async (serverUrl, locationId) => {
            const reg = profileRegistry.value;
            const others = (reg.profiles || []).filter((p) => p.id !== reg.activeProfileId);
            if (!others.length) return;
            const su = String(serverUrl || '').trim().replace(/\/+$/, '');
            if (!su) return;
            const loc = String(locationId || '').trim();
            for (const p of others) {
                const otherDb = openOfflineProfileDb(p.id);
                try {
                    await otherDb.open();
                    const cur = await readStoredConfigFromDb(otherDb);
                    const next = { ...cur, serverUrl: su, locationId: loc };
                    await otherDb.settings.put({ key: 'config', data: cloneForIdb(next) });
                } catch (e) {
                    console.warn('[offline-pos] propagate serverUrl/locationId failed for profile', p.id, e);
                } finally {
                    try {
                        await otherDb.close();
                    } catch { /* ignore */ }
                }
            }
        };

        const afterProfileDbChange = async () => {
            await loadSettings();
            products.value  = await db.products.toArray();
            await refreshCustomerList();
            await loadSales();
            await loadHeldSales();
            resetCart();
            currentPage.value   = 'pos';
            viewingSale.value   = null;
            showSyncPanel.value = false;
            showSettings.value  = false;
            refocusSearch();
            restartAutoSyncScheduler();
            await refreshCashRegisterPermissions();
        };

        const applySublocationFromConfig = async (cfg) => {
            sublocation.value = cfg?.sublocation || null;
            await db.settings.put({ key: 'sublocation', data: cloneForIdb(sublocation.value) });
            await applyAutoSyncPolicyFromConfig(cfg);
        };

        const saveSettings = async () => {
            const prevCfg = await db.settings.get('config');
            const prevApiKey = prevCfg?.data?.apiKey ?? prevCfg?.apiKey ?? '';
            const keyChanging = settings.value.apiKey !== prevApiKey;
            if (keyChanging) {
                const blocked = await db.transactions
                    .where('sync_status')
                    .anyOf(['pending', 'failed', 'conflict'])
                    .count();
                if (blocked > 0) {
                    toast(
                        t('cant_replace_token_unsynced'),
                        'error',
                        6500,
                    );
                    return;
                }
                if (!isOnline.value) {
                    toast(
                        t('replace_token_requires_online'),
                        'error',
                        5500,
                    );
                    return;
                }
            }
            await persistConfig();
            if (settings.value.apiKey && settings.value.serverUrl) {
                try {
                    const cfg = await apiGet('/api/sync/config' + (settings.value.locationId ? '?location_id=' + encodeURIComponent(settings.value.locationId) : ''));
                    await applySublocationFromConfig(cfg);
                    await applyTokenExpiryFromConfig(cfg);
                    await applyCashierFromConfig(cfg);
                    await persistConfig();
                    await refreshCashRegisterPermissions();
                    if (settings.value.apiKey !== prevApiKey) {
                        if (sublocation.value?.name) {
                            toast(t('identity_updated', { name: sublocation.value.name }), 'success');
                        } else {
                            toast(t('token_no_sublocation_warn'), 'warn', 5000);
                        }
                    }
                } catch (e) {
                    if (settings.value.apiKey !== prevApiKey) {
                        toast(t('couldnt_update_sublocation', { error: e.message }), 'warn', 5000);
                    }
                }
            }
            if (profileRegistry.value.profiles.length > 1 && settings.value.serverUrl) {
                await propagateSharedSyncConnectionToOtherProfiles(
                    settings.value.serverUrl,
                    settings.value.locationId,
                );
            }
            showSettings.value = false;
            const multi = profileRegistry.value.profiles.length > 1;
            toast(
                multi
                    ? t('settings_saved_unified')
                    : t('settings_saved'),
                'success',
            );
        };

        // ── Mobile connect form helpers ──────────────────────────────────────

        const resetConnectForm = () => {
            connectOtpDigits.value    = ['', '', '', '', '', ''];
            connectOtpError.value     = '';
            connectPendingToken.value = '';
            connectLocations.value    = [];
            connectLocationId.value   = '';
        };

        const openConnectForm = () => {
            connectServerUrl.value = String(settings.value.serverUrl || 'https://zaterp.com').trim();
            resetConnectForm();
            showConnectForm.value = true;
        };

        const redeemConnectOtp = async () => {
            const serverUrl = String(connectServerUrl.value || '').trim().replace(/\/+$/, '');
            const otp = connectOtpDigits.value.join('');
            if (otp.length !== 6) return;
            if (!serverUrl) {
                connectOtpError.value = t('save_server_url_first');
                return;
            }
            connectOtpBusy.value     = true;
            connectOtpError.value    = '';
            connectPendingToken.value = '';
            connectLocations.value   = [];
            try {
                const res  = await fetch(`${serverUrl}/api/sync/redeem-otp`, {
                    method:  'POST',
                    headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
                    body:    JSON.stringify({ otp_code: otp }),
                });
                const data = await res.json().catch(() => ({}));
                if (!res.ok) {
                    connectOtpError.value = (data.code === 'invalid_or_expired_otp')
                        ? t('otp_invalid_or_expired')
                        : (data.message || t('otp_redeem_failed'));
                    connectOtpDigits.value = ['', '', '', '', '', ''];
                    document.getElementById('m-otp-0')?.focus();
                    return;
                }
                const token = String(data.token || '').trim();
                if (!token) { connectOtpError.value = t('otp_redeem_failed'); return; }
                connectPendingToken.value = token;
                try {
                    const cfgRes = await fetch(`${serverUrl}/api/sync/config`, {
                        headers: { 'Authorization': `Bearer ${token}`, 'Accept': 'application/json' },
                    });
                    if (cfgRes.ok) {
                        const cfg = await cfgRes.json();
                        connectLocations.value = cfg.business_locations || [];
                        if (connectLocations.value.length === 1) {
                            connectLocationId.value = String(connectLocations.value[0].id);
                        }
                    }
                } catch { /* locations will stay empty */ }
            } catch {
                connectOtpError.value = t('otp_redeem_failed');
            } finally {
                connectOtpBusy.value = false;
            }
        };

        const onOtpDigitInput = (index, event) => {
            // Handle paste of full code into any box
            const pasted = event.target.value;
            if (pasted.length > 1) {
                const digits = pasted.replace(/\D/g, '').slice(0, 6).split('');
                digits.forEach((d, i) => { connectOtpDigits.value[i] = d; });
                event.target.value = connectOtpDigits.value[index] || '';
                const next = Math.min(digits.length, 5);
                document.getElementById(`m-otp-${next}`)?.focus();
                if (connectOtpDigits.value.join('').length === 6) redeemConnectOtp();
                return;
            }
            const val = pasted.replace(/\D/g, '').slice(-1);
            connectOtpDigits.value[index] = val;
            event.target.value = val;
            if (val && index < 5) {
                document.getElementById(`m-otp-${index + 1}`)?.focus();
            }
            if (connectOtpDigits.value.join('').length === 6) redeemConnectOtp();
        };

        const onOtpDigitKeydown = (index, event) => {
            if (event.key === 'Backspace' && !connectOtpDigits.value[index] && index > 0) {
                document.getElementById(`m-otp-${index - 1}`)?.focus();
            }
        };

        const saveConnection = async () => {
            if (!connectPendingToken.value) { toast(t('enter_6_digit_otp'), 'error'); return; }
            if (!connectLocationId.value)   { toast(t('select_location_first_error'), 'error'); return; }
            connectSaveBusy.value = true;
            settings.value.serverUrl  = String(connectServerUrl.value).trim().replace(/\/+$/, '');
            settings.value.apiKey     = connectPendingToken.value;
            settings.value.locationId = connectLocationId.value;
            try {
                await saveSettings();
                showConnectForm.value = false;
                resetConnectForm();
            } finally {
                connectSaveBusy.value = false;
            }
        };

        // ════════════════════════════════════════════════════════════════════
        // BACKUP / RESTORE
        // ════════════════════════════════════════════════════════════════════

        /** Collect all tables into a plain object */
        const collectBackupData = async () => {
            const [prods, custs, pendCust, txns, held, setts] = await Promise.all([
                db.products.toArray(),
                db.customers.toArray(),
                db.pending_customers.toArray(),
                db.transactions.toArray(),
                db.held_sales.toArray(),
                db.settings.toArray(),
            ]);
            return {
                _version:     2,
                _exported_at: new Date().toISOString(),
                _device:      sublocation.value?.name || 'unknown',
                products:        prods,
                customers:       custs,
                pending_customers: pendCust,
                transactions:    txns,
                held_sales:      held,
                settings:        setts,
            };
        };

        /** Trigger a browser download of a JSON backup file */
        const exportBackup = async () => {
            isExporting.value = true;
            try {
                const data = await collectBackupData();
                const json = JSON.stringify(data, null, 2);
                const blob = new Blob([json], { type: 'application/json' });
                const url  = URL.createObjectURL(blob);
                const a    = document.createElement('a');
                const date = new Date().toISOString().slice(0, 10);
                a.href     = url;
                a.download = `pos-backup-${date}.json`;
                a.click();
                URL.revokeObjectURL(url);
                toast(t('backup_exported'), 'success');
            } catch (e) {
                toast(t('export_failed', { error: e.message }), 'error');
            } finally {
                isExporting.value = false;
            }
        };

        /** Write backup silently to the pinned FileSystemFileHandle */
        const writeAutoBackup = async () => {
            if (!autoBackupFileHandle.value) return;
            try {
                const data    = await collectBackupData();
                const json    = JSON.stringify(data, null, 2);
                const writable = await autoBackupFileHandle.value.createWritable();
                await writable.write(json);
                await writable.close();
            } catch (e) {
                // Silent — don't interrupt the user's sale for a backup failure
                console.warn('Auto-backup write failed:', e);
            }
        };

        /** Let user pick where to save the auto-backup file (File System Access API) */
        const pickAutoBackupFile = async () => {
            if (!backupFileApiSupported) {
                toast(t('browser_unsupported_use_chrome_edge'), 'error');
                return;
            }
            try {
                const handle = await window.showSaveFilePicker({
                    suggestedName: 'pos-autobackup.json',
                    types: [{ description: 'JSON Backup', accept: { 'application/json': ['.json'] } }],
                });
                autoBackupFileHandle.value = handle;
                autoBackupEnabled.value    = true;
                // Persist handle across page reloads via IndexedDB
                await db.settings.put({ key: 'auto_backup_handle', data: handle });
                await db.settings.put({ key: 'auto_backup_enabled', data: true });
                // Do an immediate write so user can confirm the file was created
                await writeAutoBackup();
                toast(t('auto_backup_file_set'), 'success');
            } catch (e) {
                if (e.name !== 'AbortError') toast(t('file_pick_failed', { error: e.message }), 'error');
            }
        };

        /** Disable auto-backup */
        const disableAutoBackup = async () => {
            autoBackupEnabled.value    = false;
            autoBackupFileHandle.value = null;
            await db.settings.delete('auto_backup_handle');
            await db.settings.put({ key: 'auto_backup_enabled', data: false });
            toast(t('auto_backup_disabled'), 'info');
        };

        /** Restore all tables from a JSON backup file chosen by the user */
        const importBackup = async () => {
            isImporting.value = true;
            try {
                const file = await new Promise((resolve, reject) => {
                    const input = document.createElement('input');
                    input.type  = 'file';
                    input.accept = '.json,application/json';
                    input.onchange = () => input.files[0] ? resolve(input.files[0]) : reject(new Error('cancelled'));
                    input.click();
                });
                const text = await file.text();
                const data = JSON.parse(text);

                if (!data.transactions || !data.settings) {
                    throw new Error(t('invalid_backup_file'));
                }

                // Clear and repopulate each table
                await db.transaction('rw', db.products, db.customers, db.pending_customers, db.transactions, db.held_sales, db.settings, async () => {
                    await db.products.clear();
                    await db.customers.clear();
                    await db.pending_customers.clear();
                    await db.transactions.clear();
                    await db.held_sales.clear();
                    await db.settings.clear();

                    if (data.products?.length)     await db.products.bulkPut(data.products);
                    if (data.customers?.length)    await db.customers.bulkPut(data.customers);
                    if (data.pending_customers?.length) await db.pending_customers.bulkPut(data.pending_customers);
                    if (data.transactions?.length) await db.transactions.bulkPut(data.transactions);
                    if (data.held_sales?.length)   await db.held_sales.bulkPut(data.held_sales);
                    if (data.settings?.length)     await db.settings.bulkPut(data.settings);
                });

                // Reload everything into memory
                await loadSettings();
                products.value  = await db.products.toArray();
                await refreshCustomerList();
                await loadSales();
                await loadHeldSales();

                toast(t('restore_summary', { invoices: data.transactions?.length || 0, products: data.products?.length || 0 }), 'success', 5000);
            } catch (e) {
                if (e.message !== 'cancelled') toast(t('import_failed', { error: e.message }), 'error');
            } finally {
                isImporting.value = false;
            }
        };

        // ════════════════════════════════════════════════════════════════════
        // SYNC: LOCATIONS
        // ════════════════════════════════════════════════════════════════════

        const loadLocations = async () => {
            if (!requireSync()) return;
            try {
                await persistConfig();
                const data = await apiGet('/api/sync/config' + (settings.value.locationId ? '?location_id=' + encodeURIComponent(settings.value.locationId) : ''));
                await applySublocationFromConfig(data);
                await applyTokenExpiryFromConfig(data);
                await applyCashierFromConfig(data);
                await persistConfig();
                if (data.business_locations) {
                    locations.value = data.business_locations;
                    await db.settings.put({ key: 'locations', data: cloneForIdb(locations.value) });
                    if (data.printers) {
                        printers.value = data.printers;
                        await db.settings.put({ key: 'printers', data: cloneForIdb(printers.value) });
                    }
                    toast(t('locations_loaded'), 'success');
                }
            } catch (e) {
                toast(t('locations_load_failed', { error: e.message }), 'error');
            }
        };

        // ════════════════════════════════════════════════════════════════════
        // SYNC: PULL ALL
        // ════════════════════════════════════════════════════════════════════

        /**
         * Full pull: config, products, customers, ZATCA cert, last_sync_at, cash-register flags.
         * Caller should set `isSyncing` for UI. Throws on fatal errors.
         * @param {{ quietSuccessToast?: boolean }} [opts] — when true (auto-sync), success is log-only.
         */
        const runStructuredPullSync = async (opts = {}) => {
            const quietOk = !!opts.quietSuccessToast;
            await persistConfig();

            // 1. Config
            syncStatus.value = t('fetching_settings');
            addLog('Pulling config…');
            const cfg = await apiGet('/api/sync/config' + (settings.value.locationId ? '?location_id=' + encodeURIComponent(settings.value.locationId) : ''));

            // If business changed, purge local invoices/held sales to prevent cross-business contamination.
            const prevBizRec    = await db.settings.get('business');
            const prevBusinessId = prevBizRec?.data?.id ?? business.value?.id ?? null;
            const nextBusinessId = cfg?.business?.id ?? null;
            const businessChanged =
                prevBusinessId !== null &&
                nextBusinessId !== null &&
                String(prevBusinessId) !== String(nextBusinessId);

            if (businessChanged) {
                addLog(`Business changed (${prevBusinessId} -> ${nextBusinessId}), clearing local invoices…`, 'warn');
                await db.transaction('rw', db.transactions, db.held_sales, db.pending_customers, async () => {
                    await db.transactions.clear();
                    await db.held_sales.clear();
                    await db.pending_customers.clear();
                });
                sales.value = [];
                heldSales.value = [];
                await refreshCustomerList();
                toast(t('business_changed_wiped'), 'warn', 6000);
            }

            categories.value     = cfg.categories         || [];
            brands.value         = cfg.brands             || [];
            printers.value       = cfg.printers           || [];
            invoiceLayouts.value = cfg.invoice_layouts    || [];
            if (cfg.tax_rates)          taxRates.value       = cfg.tax_rates;
            if (cfg.business_locations) locations.value      = cfg.business_locations;
            if (cfg.business)           business.value       = cfg.business;
            if (cfg.receipt_template)        receiptTemplate.value       = cfg.receipt_template;
            if (cfg.receipt_template_design) receiptTemplateDesign.value = cfg.receipt_template_design;
            await applySublocationFromConfig(cfg);
            await applyTokenExpiryFromConfig(cfg);
            await applyCashierFromConfig(cfg);
            await persistConfig();

            // Extended config data
            if (cfg.commission_agents) commissionAgents.value = cfg.commission_agents;
            if (cfg.price_groups)      priceGroups.value      = cfg.price_groups;
            if (cfg.invoice_schemes)   invoiceSchemes.value   = cfg.invoice_schemes;
            if (cfg.customer_groups)    customerGroups.value   = cfg.customer_groups;

            // Payment methods from server config
            if (cfg.payment_types && typeof cfg.payment_types === 'object') {
                const pmKeys = Object.keys(cfg.payment_types);
                if (pmKeys.length) {
                    paymentMethods.value = pmKeys;
                    await db.settings.put({ key: 'payment_methods', data: pmKeys });
                }
            }

            const puts = [
                db.settings.put({ key: 'categories',         data: cloneForIdb(categories.value) }),
                db.settings.put({ key: 'brands',             data: cloneForIdb(brands.value) }),
                db.settings.put({ key: 'printers',           data: cloneForIdb(printers.value) }),
                db.settings.put({ key: 'invoice_layouts',    data: cloneForIdb(invoiceLayouts.value) }),
                db.settings.put({ key: 'locations',          data: cloneForIdb(locations.value) }),
                db.settings.put({ key: 'business',           data: cloneForIdb(business.value) }),
                db.settings.put({ key: 'tax_rates',          data: cloneForIdb(taxRates.value) }),
                db.settings.put({ key: 'commission_agents',  data: cloneForIdb(commissionAgents.value) }),
                db.settings.put({ key: 'price_groups',       data: cloneForIdb(priceGroups.value) }),
                db.settings.put({ key: 'invoice_schemes',    data: cloneForIdb(invoiceSchemes.value) }),
                db.settings.put({ key: 'customer_groups',    data: cloneForIdb(customerGroups.value) }),
            ];
            if (cfg.receipt_template)        puts.push(db.settings.put({ key: 'receipt_template',        data: cfg.receipt_template }));
            if (cfg.receipt_template_design) puts.push(db.settings.put({ key: 'receipt_template_design', data: cfg.receipt_template_design }));
            await Promise.all(puts);
            addLog('Config done.');

            // 2. Products (paginated)
            syncStatus.value = t('fetching_products');
            addLog('Pulling products…');
            await db.products.clear();

            const locId = parseInt(settings.value.locationId) || 0;
            let productCount = 0;

            await paginatedFetch('/api/sync/products', async (rows) => {
                const batch = rows.map(p => {
                    const product   = p.product   || {};
                    const variation = p.variation  || {};
                    const locStock  = (p.location_stocks || []).find(s => s.location_id === locId);
                    return {
                        id:                  variation.id,
                        product_id:          product.id,
                        name:                product.name,
                        sku:                 variation.sub_sku || variation.sku || '',
                        barcode:             variation.barcode || '',
                        product_type:        product.type,
                        image:               product.image
                                                ? `${settings.value.serverUrl}/uploads/img/${product.image}`
                                                : null,
                        enable_stock:        product.enable_stock,
                        category_id:         product.category_id,
                        brand_id:            product.brand_id,
                        unit_id:             product.unit_id,
                        tax_id:              product.tax_id ?? product.tax,
                        sell_price_inc_tax:  +(variation.sell_price_inc_tax || 0),
                        default_sell_price:  +(variation.default_sell_price || 0),
                        qty_available:       locStock ? +locStock.qty_available : 0,
                        location_stocks:     p.location_stocks || [],
                        modifier_sets:       product.product_ms || p.modifier_sets || [],
                        sub_units:           product.sub_units  || p.sub_units  || [],
                        combo_variations:    p.combo_variations  || [],
                        has_lots:            !!(product.has_lots || p.has_lots),
                        lots:                p.lots || [],
                        price_groups:        p.price_groups || [],
                        warranty_id:         product.warranty_id || null,
                    };
                });
                await db.products.bulkPut(batch);
                productCount += batch.length;
            });

            products.value = await db.products.toArray();
            addLog(`Products done: ${productCount}.`);

            // 3. Customers (paginated)
            syncStatus.value = t('fetching_customers');
            addLog('Pulling customers…');
            let customerCount = 0;
            let maxCustomerTs = null;

            await paginatedFetch('/api/sync/customers', async (rows) => {
                for (const c of rows || []) {
                    const ts = customerRowUpdatedAtMs(c);
                    if (ts != null && (maxCustomerTs == null || ts > maxCustomerTs)) maxCustomerTs = ts;
                }
                const batch = (rows || []).map(mapApiCustomerRowToCustomerRecord);
                await db.customers.bulkPut(batch);
                customerCount += batch.length;
            });

            await refreshCustomerList();
            await persistCustomersSyncWatermark(maxCustomerTs ?? Date.now());
            addLog(`Customers done: ${customerCount}.`);

            // 4. ZATCA certificate
            try {
                const certRes = await fetch(`${settings.value.serverUrl}/api/sync/zatca-certificates`, {
                    headers: apiHeaders(),
                });
                if (certRes.ok) {
                    const certData = await certRes.json();
                    const locationId = +settings.value.locationId;
                    const cert = (certData.data || []).find(c => +c.business_location_id === locationId);
                    if (cert) {
                        await db.settings.put({ key: 'zatca_certificate', data: cloneForIdb(cert) });
                        zatcaCertificate.value = cert;
                        addLog('ZATCA certificate synced.');
                    }
                }
            } catch (e) {
                addLog('ZATCA certificate sync skipped: ' + e.message, 'warn');
            }

            lastSyncAt.value = new Date().toLocaleString();
            await db.settings.put({ key: 'last_sync_at', data: lastSyncAt.value });
            addLog('Sync complete!');
            if (!quietOk) {
                toast(t('sync_completed_summary', { products: productCount, customers: customerCount }), 'success');
            } else {
                addLog(t('sync_pull_log', { products: productCount, customers: customerCount }));
            }
            await refreshCashRegisterPermissions();
        };

        const syncAll = async () => {
            if (!requireSync()) return;
            if (isSyncing.value) return;

            // Always warn before pull if there are unsynced local invoices.
            const unsyncedCount = await db.transactions
                .where('sync_status')
                .anyOf(['pending', 'failed', 'conflict'])
                .count();
            if (unsyncedCount > 0) {
                const proceed = confirm(t('unsynced_pull_warning', { count: unsyncedCount }));
                if (!proceed) return;
            }

            isSyncing.value = true;

            try {
                await runStructuredPullSync({ quietSuccessToast: false });
            } catch (e) {
                addLog('Sync error: ' + e.message, 'error');
                toast(t('sync_failed', { error: e.message }), 'error');
            } finally {
                isSyncing.value  = false;
                syncStatus.value = '';
            }
        };

        // ════════════════════════════════════════════════════════════════════
        // SYNC: PUSH SALES (receive-transactions)
        // ════════════════════════════════════════════════════════════════════

        const sortPendingForSync = (pendingRaw) => [
            ...pendingRaw.filter(s => s.type !== 'sell_return').sort((a, b) => new Date(a.created_at) - new Date(b.created_at)),
            ...pendingRaw.filter(s => s.type === 'sell_return').sort((a, b) => new Date(a.created_at) - new Date(b.created_at)),
        ];

        const buildReceiveTransactionsPayload = (pending) => pending.map((s) => {
            if (s.type === 'sell_return') {
                return {
                    local_uuid:                 s.local_uuid,
                    type:                       'sell_return',
                    return_parent_invoice_no:   s.return_parent_invoice_no,
                    location_id:                s.location_id || settings.value.locationId,
                    final_total:                +(s.total || 0),
                    tax_amount:                 0,
                    discount_type:              null,
                    discount_amount:            0,
                    transaction_date:           s.created_at,
                    offline_created_at:         s.created_at,
                    sell_lines: (s.items || []).map(item => ({
                        variation_sku:        item.sku,
                        quantity:             item.quantity,
                        unit_price:           +(item.unit_price || 0),
                        unit_price_inc_tax:   +(item.unit_price || 0),
                        item_tax:             0,
                        line_discount_type:   null,
                        line_discount_amount: 0,
                    })),
                    payment_lines: (s.payments || [{ method: 'cash', amount: +(s.total || 0) }]).map(p => ({
                        method:     p.method || 'cash',
                        amount:     +(p.amount || s.total || 0),
                        is_return:  true,
                        account_id: null,
                    })),
                };
            }

            return {
                local_uuid:              s.local_uuid,
                location_id:             s.location_id || settings.value.locationId,
                type:                    'sell',
                status:                  s.status || 'final',
                invoice_no:              s.invoice_no,
                final_total:             +(s.total    || 0),
                total_before_tax:        +(s.subtotal || s.total || 0),
                tax_amount:              +(s.tax      || 0),
                discount_type:           s.discount_type  || null,
                discount_amount:         +(s.discount     || 0),
                total_line_disc:         +(s.total_line_disc || 0),
                payment_status:          s.payment_status || 'paid',
                contact_mobile:          s.customer_phone || null,
                ...(s.new_customer && typeof s.new_customer === 'object'
                    ? { new_customer: s.new_customer }
                    : {}),
                transaction_date:        s.transaction_date || s.created_at,
                offline_created_at:      s.created_at,
                additional_notes:        s.sale_note  || null,
                staff_note:              s.staff_note || null,
                zatca_qr_code:           s.zatca_qr_code || null,
                shipping_charges:        +(s.shipping_charges  || 0),
                shipping_details:        s.shipping_details    || null,
                shipping_address:        s.shipping_address    || null,
                shipping_status:         s.shipping_status     || null,
                delivered_to:            s.delivered_to        || null,
                delivery_person:         s.delivery_person     || null,
                packing_charge:          +(s.packing_charge    || 0),
                rp_redeemed:             +(s.rp_redeemed       || 0),
                rp_redeemed_amount:      +(s.rp_redeemed_amount || 0),
                commission_agent_id:     s.commission_agent_id  || null,
                price_group_id:          s.price_group_id       || null,
                invoice_scheme_id:       s.invoice_scheme_id    || null,
                tax_rate_id:             s.tax_rate_id          || null,
                round_off_amount:        +(s.round_off_amount   || 0),
                change_return_amount:    +(s.change_return_amount || 0),
                change_return_method:    s.change_return_method  || null,
                sell_lines: (s.items || []).map(item => ({
                    variation_sku:        item.sku,
                    quantity:             item.quantity,
                    unit_price:           +((item.unit_price_exc_tax ?? item.unit_price) || 0),
                    unit_price_inc_tax:   +(item.unit_price || 0),
                    item_tax:             +(item.item_tax_per_unit ?? 0),
                    line_discount_type:   item.line_discount_type   || null,
                    line_discount_amount: +(item.line_discount_amount || 0),
                    sell_line_note:       item.line_note || null,
                    lot_number:           item.lot_number  || null,
                    lot_expiry:           item.lot_expiry  || null,
                    selected_modifiers:   item.selected_modifiers || [],
                    combo_variations:     item.combo_variations   || [],
                    unit_multiplier:      +(item.unit_multiplier   || 1),
                })),
                payment_lines: (s.payments || []).map(p => ({
                    method:              p.method  || 'cash',
                    amount:              +(p.amount || 0),
                    account_id:          null,
                    card_number:         p.card_number         || null,
                    card_holder_name:    p.card_holder         || null,
                    card_type:           p.card_type           || null,
                    card_exp_month:      p.card_exp_month      || null,
                    card_exp_year:       p.card_exp_year       || null,
                    card_security_code:  p.card_security_code  || null,
                    cheque_number:       p.cheque_number       || null,
                    bank_account_number: p.bank_account_number || null,
                    transaction_number:  p.transaction_number  || null,
                })),
            };
        });

        const resultRowLocalUuid = (r) =>
            (r && (r.local_uuid ?? r.localUuid)) || null;

        /** Align with Laravel / POS sync payloads that vary casing and wording */
        const resultRowIsSynced = (r) => {
            if (r && r.success === true && !r.error) return true;
            const st = String(r?.status ?? '').trim().toLowerCase().replace(/-/g, '_');
            if (['synced', 'already_synced', 'success', 'completed', 'ok', 'done'].includes(st)) return true;
            if (r?.synced === true || r?.already_synced === true) return true;
            return false;
        };

        const resultRowIsConflict = (r) => {
            const st = String(r?.status ?? '').trim().toLowerCase().replace(/-/g, '_');
            return st === 'conflict' || st === 'conflicts';
        };

        const extractReceiveTransactionResultRows = (result) => {
            if (Array.isArray(result)) return result;
            if (!result || typeof result !== 'object') return [];
            const rows = result.results ?? result.data?.results ?? (Array.isArray(result.data) ? result.data : null);
            return Array.isArray(rows) ? rows : [];
        };

        const applyReceiveTransactionsResults = async (pending, results) => {
            let synced = 0;
            let failed = 0;
            let abandoned = 0;
            const failureDetails = [];
            const newlyAbandoned = [];
            for (const r of (results || [])) {
                const uuid = resultRowLocalUuid(r);
                const sale = uuid ? pending.find(s => s.local_uuid === uuid) : null;
                if (!sale) continue;
                if (resultRowIsSynced(r)) {
                    await db.transactions.update(sale.id, {
                        sync_status:       'synced',
                        server_invoice_no: r.invoice_no || null,
                        server_id:         r.cloud_id   || null,
                        server_receipt:    r.receipt    || null,
                        sync_error:        null,
                        sync_attempts:     0,
                    });
                    synced++;
                } else if (resultRowIsConflict(r)) {
                    const msg = (r.conflicts || []).join('; ') || 'Conflict';
                    const attempts = (sale.sync_attempts || 0) + 1;
                    const isAbandoned = attempts >= MAX_SYNC_ATTEMPTS;
                    await db.transactions.update(sale.id, {
                        sync_status:  isAbandoned ? 'abandoned' : 'conflict',
                        sync_error:   msg,
                        sync_attempts: attempts,
                    });
                    if (isAbandoned) {
                        newlyAbandoned.push({ ...sale, sync_error: msg, sync_attempts: attempts });
                        abandoned++;
                    } else {
                        failureDetails.push({ local_uuid: sale.local_uuid, invoice_no: sale.invoice_no, message: msg });
                        failed++;
                    }
                } else {
                    const msg = r.error || r.message || String(r.status || 'Unknown error');
                    const attempts = (sale.sync_attempts || 0) + 1;
                    const isAbandoned = attempts >= MAX_SYNC_ATTEMPTS;
                    await db.transactions.update(sale.id, {
                        sync_status:  isAbandoned ? 'abandoned' : 'failed',
                        sync_error:   msg,
                        sync_attempts: attempts,
                    });
                    if (isAbandoned) {
                        newlyAbandoned.push({ ...sale, sync_error: msg, sync_attempts: attempts });
                        abandoned++;
                    } else {
                        failureDetails.push({ local_uuid: sale.local_uuid, invoice_no: sale.invoice_no, message: msg });
                        failed++;
                    }
                }
            }
            await loadSales();
            if (newlyAbandoned.length || failureDetails.length) {
                const allFailed = [
                    ...failureDetails.map(f => ({ ...pending.find(s => s.local_uuid === f.local_uuid), sync_error: f.message, abandoned: false })),
                    ...newlyAbandoned.map(s => ({ ...s, abandoned: true })),
                ];
                await appendSyncFailureLog(allFailed);
            }
            if (newlyAbandoned.length && hasSyncCredentials() && isOnline.value) {
                reportAbandonedToServer(newlyAbandoned).catch(() => {});
            }
            return { synced, failed, abandoned, failureDetails };
        };

        /** Fire-and-forget: report newly-abandoned sales to the server for centralized logging. */
        const reportAbandonedToServer = async (sales) => {
            const payload = sales.map(s => ({
                local_uuid:    s.local_uuid,
                invoice_no:    s.invoice_no   || null,
                type:          s.type         || null,
                total:         s.total        ?? null,
                location_id:   s.location_id  ?? settings.value.locationId ?? null,
                created_at:    s.created_at   || null,
                sync_attempts: s.sync_attempts,
                sync_error:    s.sync_error   || null,
            }));
            await fetch(`${settings.value.serverUrl}/api/sync/report-abandoned`, {
                method:  'POST',
                headers: apiHeaders(),
                body:    JSON.stringify({
                    device_id:      settings.value.deviceId || null,
                    sublocation_id: settings.value.sublocationId || null,
                    sales:          payload,
                }),
            });
        };

        /** One POST for all current pending rows (same semantics as legacy pushSales). */
        const pushPendingTransactionsOnce = async () => {
            if (hasSyncCredentials() && isOnline.value) {
                await syncPendingCustomersOutbox();
            }
            const pendingRaw = await db.transactions.where('sync_status').equals('pending').toArray();
            if (!pendingRaw.length) return { ran: false, synced: 0, failed: 0 };
            const pending = sortPendingForSync(pendingRaw);
            const transactions = buildReceiveTransactionsPayload(pending);
            const res = await fetch(`${settings.value.serverUrl}/api/sync/receive-transactions`, {
                method:  'POST',
                headers: apiHeaders(),
                body:    JSON.stringify({ transactions }),
            });
            if (res.status === 401) {
                notifySyncUnauthorized();
                const txt = await res.text();
                throw new Error(`HTTP 401: ${txt.slice(0, 200)}`);
            }
            if (!res.ok) {
                const txt = await res.text();
                throw new Error(`HTTP ${res.status}: ${txt.slice(0, 200)}`);
            }
            const result = await res.json();
            if (result && Object.prototype.hasOwnProperty.call(result, 'success') && result.success === false) {
                const msg = result.message || result.error || t('server_rejected_batch');
                throw new Error(msg);
            }
            const rows = extractReceiveTransactionResultRows(result);
            const { synced, failed, failureDetails } = await applyReceiveTransactionsResults(pending, rows);
            if (synced > 0 && hasSyncCredentials() && isOnline.value) {
                try {
                    await pullCustomersDeltaSinceWatermark({ quiet: true });
                } catch (e) {
                    addLog('Customer delta after push: ' + e.message, 'warn');
                }
            }
            return { ran: true, synced, failed, failureDetails };
        };

        /** Short text from recent failed/conflict rows (after a push). */
        const collectRecentSyncErrors = async () => {
            const rows = await db.transactions.where('sync_status').anyOf(['failed', 'conflict']).toArray();
            const parts = [];
            const seen = new Set();
            for (const r of rows) {
                const err = String(r.sync_error || '').trim();
                if (!err || seen.has(err)) continue;
                seen.add(err);
                parts.push(err);
                if (parts.length >= 4) break;
            }
            return parts.join(' · ');
        };

        /** For close-register: upload until no pending, then fail if any failed/conflict remain */
        const flushPendingTransactionsForClose = async () => {
            const maxRounds = 40;
            for (let round = 0; round < maxRounds; round++) {
                const pendingBefore = await db.transactions.where('sync_status').equals('pending').count();
                if (!pendingBefore) break;

                const batch = await pushPendingTransactionsOnce();
                if (!batch.ran) break;

                if (batch.failed > 0) {
                    await recordPushFailures(
                        batch.failureDetails,
                        batch.failureDetails?.length
                            ? null
                            : t('close_register_batch_failed_no_detail', { count: batch.failed }),
                    );
                    const detail = await collectRecentSyncErrors();
                    return { ok: false, reason: 'batch_failed', detail };
                }

                const pendingAfter = await db.transactions.where('sync_status').equals('pending').count();
                if (pendingAfter >= pendingBefore) {
                    const detail = await collectRecentSyncErrors();
                    return {
                        ok: false,
                        reason: 'stuck_pending',
                        detail: detail || t('server_no_result_check_sales'),
                    };
                }
            }

            if (await db.transactions.where('sync_status').equals('pending').count() > 0) {
                return {
                    ok: false,
                    reason: 'max_rounds',
                    detail: t('push_queue_not_drained'),
                };
            }

            return { ok: true };
        };

        /** Optional: refresh server policy after a successful manual or automatic push */
        const refreshSyncConfigAfterManualPush = async () => {
            if (!hasSyncCredentials() || !isOnline.value) return;
            try {
                const cfg = await apiGet('/api/sync/config' + (settings.value.locationId ? '?location_id=' + encodeURIComponent(settings.value.locationId) : ''));
                await applySublocationFromConfig(cfg);
                await applyTokenExpiryFromConfig(cfg);
                await applyCashierFromConfig(cfg);
                await persistConfig();
            } catch { /* ignore */ }
        };

        /** Parse admin `.env` snippet (CLOUD_SYNC_*, SUBLOCATION_SEQUENCE, …) */
        const parseEnvSnippet = (text) => {
            const out = {};
            const lines = String(text || '').split(/\r?\n/);
            for (let line of lines) {
                line = line.trim();
                if (!line || line.startsWith('#')) continue;
                const eq = line.indexOf('=');
                if (eq < 1) continue;
                const k = line.slice(0, eq).trim();
                let v = line.slice(eq + 1).trim();
                if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
                    v = v.slice(1, -1);
                }
                out[k] = v;
            }
            return out;
        };

        const parseEnvSnippetForSync = (text) => {
            const raw = parseEnvSnippet(text);
            const serverUrl = (raw.CLOUD_SYNC_URL || raw.cloud_sync_url || '').trim().replace(/\/+$/, '');
            const apiKey = (raw.CLOUD_SYNC_TOKEN || raw.cloud_sync_token || '').trim();
            const subSeq = (raw.SUBLOCATION_SEQUENCE || raw.sublocation_sequence || '').trim();
            const exp = (raw.CLOUD_SYNC_TOKEN_EXPIRES_AT || raw.cloud_sync_token_expires_at || '').trim();
            return { raw, serverUrl, apiKey, subSeq, tokenExpiresAt: exp };
        };

        /** Raw token only (same idea as Settings → API key); tolerates a single `CLOUD_SYNC_TOKEN=…` line. */
        const normalizeOfflineTokenInput = (text) => {
            let s = String(text || '').trim();
            const lines = s.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
            const last = lines.length ? lines[lines.length - 1] : '';
            const m = last.match(/^CLOUD_SYNC_TOKEN\s*=\s*(.+)$/i);
            s = m ? m[1].trim() : last;
            if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) {
                s = s.slice(1, -1);
            }
            return s.trim();
        };

        /** Flush uploads + pull so switching accounts is safe (requires empty queue + online). */
        const runPreAccountSwitchSync = async () => {
            if (!requireSync()) return { ok: false };
            if (!isOnline.value) {
                toast(t('switch_requires_online'), 'error');
                return { ok: false };
            }
            preAccountSwitchBusy.value = true;
            try {
                for (let round = 0; round < 45; round++) {
                    const pend = await db.transactions.where('sync_status').equals('pending').count();
                    if (!pend) break;
                    const batch = await pushPendingTransactionsOnce();
                    if (!batch.ran) break;
                    if (batch.failed > 0) {
                        await recordPushFailures(
                            batch.failureDetails,
                            batch.failureDetails?.length ? null : t('push_failed_prepare_switch'),
                        );
                        toast(t('couldnt_drain_pending_sales'), 'error', 6000);
                        return { ok: false };
                    }
                }
                if (await db.transactions.where('sync_status').equals('pending').count() > 0) {
                    toast(t('still_invoices_waiting_push'), 'error');
                    return { ok: false };
                }
                const bad = await db.transactions.where('sync_status').anyOf(['failed', 'conflict']).count();
                if (bad > 0) {
                    toast(t('failed_or_conflict_before_switch'), 'error', 5500);
                    return { ok: false };
                }
                isSyncing.value = true;
                try {
                    await runStructuredPullSync({ quietSuccessToast: true });
                } finally {
                    isSyncing.value  = false;
                    syncStatus.value = '';
                }
                const left = await db.transactions
                    .where('sync_status')
                    .anyOf(['pending', 'failed', 'conflict'])
                    .count();
                if (left > 0) {
                    toast(t('sync_queue_not_empty_after_round'), 'error');
                    return { ok: false };
                }
                toast(t('sync_done_can_switch'), 'success');
                return { ok: true };
            } catch (e) {
                toast(String(e.message || e), 'error');
                return { ok: false };
            } finally {
                preAccountSwitchBusy.value = false;
            }
        };

        const openSwitchAccountModal = (profileId) => {
            const reg = profileRegistry.value;
            if (!profileId || profileId === reg.activeProfileId) return;
            const profile = reg.profiles.find((p) => p.id === profileId);
            switchAccountTargetId.value  = profileId;
            switchAccountUsername.value  = profile?.label || '';
            switchAccountPassword.value  = '';
            switchAccountError.value     = '';
            showSwitchAccountModal.value = true;
        };

        const verifyCashierAndSwitch = async () => {
            if (!switchAccountUsername.value.trim() || !switchAccountPassword.value) {
                switchAccountError.value = t('enter_username_password');
                return;
            }
            if (!isOnline.value) {
                switchAccountError.value = t('switch_requires_online_short');
                return;
            }
            const block = await db.transactions.where('sync_status').anyOf(['pending', 'failed', 'conflict']).count();
            if (block > 0) {
                switchAccountError.value = t('unsynced_sync_first_before_switch');
                return;
            }
            switchAccountBusy.value  = true;
            switchAccountError.value = '';
            try {
                const res = await fetch(`${settings.value.serverUrl}/api/sync/verify-cashier`, {
                    method: 'POST',
                    headers: { ...apiHeaders(), 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        username: switchAccountUsername.value.trim(),
                        password: switchAccountPassword.value,
                    }),
                });
                if (res.status === 429) {
                    switchAccountError.value = t('too_many_attempts');
                    return;
                }
                let body = {};
                try { body = await res.json(); } catch { /* ignore */ }
                if (res.status === 422 || body?.code === 'no_token_provisioned') {
                    switchAccountError.value = t('no_presence_token_for_user');
                    return;
                }
                if (res.status === 401 || body?.code === 'invalid_credentials') {
                    switchAccountError.value = t('invalid_username_or_password');
                    return;
                }
                if (!res.ok || !body?.success) {
                    switchAccountError.value = t('identity_verify_failed');
                    return;
                }
                showSwitchAccountModal.value = false;
                await switchToProfile(switchAccountTargetId.value);
            } catch (e) {
                switchAccountError.value = String(e.message || e);
            } finally {
                switchAccountBusy.value = false;
            }
        };

        const switchToProfile = async (targetId) => {
            const reg = profileRegistry.value;
            if (!targetId || targetId === reg.activeProfileId) return;
            if (!isOnline.value) {
                toast(t('switch_requires_online_after_sync'), 'error', 6000);
                return;
            }
            const block = await db.transactions
                .where('sync_status')
                .anyOf(['pending', 'failed', 'conflict'])
                .count();
            if (block > 0) {
                toast(t('press_sync_before_switch'), 'error', 6500);
                return;
            }
            try {
                await db.close();
            } catch { /* ignore */ }
            db = openOfflineProfileDb(targetId);
            await db.open();
            const next = { ...reg, activeProfileId: targetId };
            saveProfileRegistry(next);
            profileRegistry.value = next;
            await afterProfileDbChange();
            if (settings.value.serverUrl && settings.value.apiKey && isOnline.value) {
                try {
                    const cfg = await apiGet(
                        '/api/sync/config' + (settings.value.locationId ? '?location_id=' + encodeURIComponent(settings.value.locationId) : ''),
                    );
                    await applySublocationFromConfig(cfg);
                    await applyTokenExpiryFromConfig(cfg);
                    await applyCashierFromConfig(cfg);
                    await persistConfig();
                } catch {
                    /* keep cached */
                }
            }
            await refreshCashRegisterPermissions();
            restartAutoSyncScheduler();
            toast(t('account_switched'), 'success');
        };

        const addAccountFromEnvSnippet = async () => {
            const serverUrl = String(settings.value.serverUrl || '').trim().replace(/\/+$/, '');
            const sharedLocationId = String(settings.value.locationId || '').trim();
            const rawTokenField = String(addAccountTokenInput.value || '');
            const parsed = parseEnvSnippetForSync(rawTokenField);
            const apiKey = (parsed.apiKey || normalizeOfflineTokenInput(rawTokenField)).trim();
            if (!serverUrl) {
                toast(t('save_server_url_first'), 'error');
                return;
            }
            if (!sharedLocationId) {
                toast(t('select_location_before_account'), 'error', 7000);
                return;
            }
            if (!apiKey) {
                toast(t('enter_sync_token'), 'error');
                return;
            }
            const newId = newProfileId();
            const reg = { ...profileRegistry.value, profiles: [...profileRegistry.value.profiles, { id: newId, label: null }], activeProfileId: newId };
            saveProfileRegistry(reg);
            profileRegistry.value = reg;
            try {
                await db.close();
            } catch { /* ignore */ }
            db = openOfflineProfileDb(newId);
            await db.open();
            settings.value = {
                serverUrl,
                apiKey,
                locationId: sharedLocationId,
            };
            cashierDisplayName.value = '';
            syncTokenExpiresAt.value = null;
            await persistConfig();
            addAccountTokenInput.value = '';
            showAddAccountModal.value = false;
            showSettings.value      = false;
            await afterProfileDbChange();
            if (isOnline.value) {
                try {
                    const cfgPath =
                        '/api/sync/config' +
                        (settings.value.locationId
                            ? '?location_id=' + encodeURIComponent(settings.value.locationId)
                            : '');
                    const cfg = await apiGet(cfgPath);
                    await applySublocationFromConfig(cfg);
                    await applyTokenExpiryFromConfig(cfg);
                    await applyCashierFromConfig(cfg);
                    await persistConfig();
                } catch (e) {
                    toast(t('account_saved_locally_settings_fail', { error: e.message }), 'warn', 6000);
                }
            }
            await refreshCashRegisterPermissions();
            restartAutoSyncScheduler();
            toast(t('account_added_switched'), 'success');
        };

        const addAccountFromOtp = async () => {
            const serverUrl = String(settings.value.serverUrl || '').trim().replace(/\/+$/, '');
            const sharedLocationId = String(settings.value.locationId || '').trim();
            const otpCode = String(addAccountOtpInput.value || '').replace(/\s/g, '');

            if (!serverUrl) {
                toast(t('save_server_url_first'), 'error');
                return;
            }
            if (!sharedLocationId) {
                toast(t('select_location_before_account'), 'error', 7000);
                return;
            }
            if (!otpCode || otpCode.length !== 6) {
                addAccountOtpError.value = t('enter_6_digit_otp');
                return;
            }

            addAccountOtpBusy.value  = true;
            addAccountOtpError.value = '';
            try {
                const res = await fetch(`${serverUrl}/api/sync/redeem-otp`, {
                    method:  'POST',
                    headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
                    body:    JSON.stringify({ otp_code: otpCode }),
                });
                const data = await res.json().catch(() => ({}));

                if (!res.ok) {
                    const code = data.code || '';
                    addAccountOtpError.value = code === 'invalid_or_expired_otp'
                        ? t('otp_invalid_or_expired')
                        : (data.message || t('otp_redeem_failed'));
                    return;
                }

                const apiKey = String(data.token || '').trim();
                if (!apiKey) {
                    addAccountOtpError.value = t('otp_redeem_failed');
                    return;
                }

                const newId = newProfileId();
                const reg = {
                    ...profileRegistry.value,
                    profiles: [...profileRegistry.value.profiles, { id: newId, label: null }],
                    activeProfileId: newId,
                };
                saveProfileRegistry(reg);
                profileRegistry.value = reg;
                try { await db.close(); } catch { /* ignore */ }
                db = openOfflineProfileDb(newId);
                await db.open();
                settings.value = { serverUrl, apiKey, locationId: sharedLocationId };
                cashierDisplayName.value = '';
                syncTokenExpiresAt.value = null;
                await persistConfig();
                addAccountOtpInput.value  = '';
                showAddAccountModal.value = false;
                showSettings.value        = false;
                await afterProfileDbChange();
                if (isOnline.value) {
                    try {
                        const cfgPath = '/api/sync/config' + (settings.value.locationId
                            ? '?location_id=' + encodeURIComponent(settings.value.locationId)
                            : '');
                        const cfg = await apiGet(cfgPath);
                        await applySublocationFromConfig(cfg);
                        await applyTokenExpiryFromConfig(cfg);
                        await applyCashierFromConfig(cfg);
                        await persistConfig();
                    } catch (e) {
                        toast(t('account_saved_locally_settings_fail', { error: e.message }), 'warn', 6000);
                    }
                }
                await refreshCashRegisterPermissions();
                restartAutoSyncScheduler();
                toast(t('account_added_switched'), 'success');
            } catch (e) {
                addAccountOtpError.value = t('otp_redeem_failed');
            } finally {
                addAccountOtpBusy.value = false;
            }
        };

        const pushSales = async () => {
            if (!requireSync()) return;
            if (pushingSales.value) return;
            if (closeRegisterFlowBusy.value) {
                toast(t('close_register_in_progress'), 'warn', 4000);
                return;
            }
            const pendingRaw = await db.transactions.where('sync_status').equals('pending').toArray();
            if (!pendingRaw.length) { toast(t('no_sales_waiting_push')); return; }
            pushingSales.value = true;
            addLog(`Pushing ${pendingRaw.length} sale(s)…`);
            try {
                const r = await pushPendingTransactionsOnce();
                if (!r.ran) return;
                addLog(`Push done: ${r.synced} synced, ${r.failed} failed`, r.failed ? 'error' : 'info');
                if (r.failed) {
                    await recordPushFailures(
                        r.failureDetails,
                        r.failureDetails?.length
                            ? null
                            : t('partial_push_no_details', { count: r.failed }),
                    );
                    const first = r.failureDetails?.[0];
                    const hint = first ? formatPushFailureDetailLine(first).slice(0, 120) : '';
                    toast(
                        t('partial_push_summary', { synced: r.synced, failed: r.failed, hint }),
                        'error',
                        6500,
                    );
                } else {
                    toast(t('push_synced_count', { count: r.synced }), 'success');
                }
                if (!r.failed) await refreshSyncConfigAfterManualPush();
            } catch (e) {
                await recordPushFailures(null, t('http_network_error', { error: e.message }));
                toast(t('push_failed', { error: e.message }), 'error');
            } finally {
                pushingSales.value = false;
            }
        };

        let autoSyncIntervalId = null;
        let autoSyncUiTimerId = null;
        let autoSyncInFlight = false;

        const stopAutoSyncScheduler = () => {
            if (autoSyncIntervalId != null) {
                clearInterval(autoSyncIntervalId);
                autoSyncIntervalId = null;
            }
            autoSyncNextFireAt.value = null;
        };

        /** Upload pending sales first, then full pull (same pipeline as manual sync). */
        const maybeRunAutoSyncCycle = async () => {
            if (!isOnline.value || !hasSyncCredentials() || !sublocation.value || !autoSyncIntervalSeconds.value) return;
            if (pushingSales.value || autoSyncInFlight || isSyncing.value || closeRegisterFlowBusy.value) return;

            autoSyncInFlight = true;
            autoSyncRunning.value = true;
            try {
                const pendingRaw = await db.transactions.where('sync_status').equals('pending').toArray();
                if (pendingRaw.length) {
                    addLog(`Auto-sync: pushing ${pendingRaw.length} sale(s)…`);
                    try {
                        const r = await pushPendingTransactionsOnce();
                        if (r.ran) {
                            addLog(`Auto-sync: ${r.synced} synced, ${r.failed} failed`, r.failed ? 'error' : 'info');
                            if (r.failed) {
                                await recordPushFailures(
                                    r.failureDetails,
                                    r.failureDetails?.length
                                        ? null
                                        : t('auto_sync_failed_no_details', { count: r.failed }),
                                );
                                toast(t('auto_sync_partial_toast', { count: r.failed }), 'warn', 5500);
                            }
                        }
                    } catch (e) {
                        await recordPushFailures(null, t('auto_sync_error_record', { error: e.message }));
                        toast(t('auto_sync_push_failed_toast', { error: e.message }), 'error');
                    }
                }

                if (!isOnline.value || !hasSyncCredentials()) return;
                if (isSyncing.value) {
                    addLog('Auto-sync pull skipped: manual sync already running.');
                    return;
                }

                isSyncing.value = true;
                try {
                    await runStructuredPullSync({ quietSuccessToast: true });
                } catch (e) {
                    addLog('Auto-sync pull: ' + e.message, 'error');
                    toast(t('auto_sync_pull_failed_toast', { error: e.message }), 'error');
                } finally {
                    isSyncing.value = false;
                    syncStatus.value = '';
                }
            } finally {
                autoSyncInFlight = false;
                autoSyncRunning.value = false;
                restartAutoSyncScheduler();
            }
        };

        const restartAutoSyncScheduler = () => {
            stopAutoSyncScheduler();
            if (!autoSyncIntervalSeconds.value || !sublocation.value || !hasSyncCredentials()) return;
            const periodMs = autoSyncIntervalSeconds.value * 1000;
            autoSyncNextFireAt.value = Date.now() + periodMs;
            autoSyncIntervalId = setInterval(() => {
                const sec = autoSyncIntervalSeconds.value;
                if (!sec || !sublocation.value) return;
                const p = sec * 1000;
                autoSyncNextFireAt.value = Date.now() + p;
                void maybeRunAutoSyncCycle();
            }, periodMs);
        };

        watch([autoSyncIntervalSeconds, sublocation, () => settings.value.serverUrl, () => settings.value.apiKey], () => {
            if (autoSyncRunning.value) return;
            restartAutoSyncScheduler();
        });

        const autoSyncEveryLabel = computed(() => {
            const s = autoSyncIntervalSeconds.value;
            if (!s || !sublocation.value) return '';
            return formatAutoSyncEveryAr(s);
        });

        const autoSyncSidebarStatus = computed(() => {
            if (!sublocation.value || !autoSyncIntervalSeconds.value) return '';
            if (!isOnline.value) return t('waiting_online_for_auto_sync');
            if (autoSyncRunning.value) return t('auto_sync_running');
            if (pushingSales.value) return t('pushing_sales');
            if (isSyncing.value) return t('pulling_data');
            const until = autoSyncNextFireAt.value;
            if (!until) return '';
            const ms = until - autoSyncClock.value;
            if (ms <= 0) return t('next_attempt_soon');
            return t('next_attempt_in', { time: formatCountdownAr(ms) });
        });

        // ════════════════════════════════════════════════════════════════════
        // CLOSE CASH REGISTER (sync API — بعد رفع المعاملات)
        // ════════════════════════════════════════════════════════════════════

        const initCloseRegisterFormFromSnapshot = (snap) => {
            const reg = snap?.register;
            const denoms = {};
            for (const v of (reg?.cash_denomination_values || [])) denoms[String(v)] = 0;
            closeRegisterForm.value = {
                closing_amount:       +(reg?.suggested_closing_amount ?? 0),
                total_card_slips:     +(reg?.defaults?.total_card_slips ?? 0),
                total_cheques:        +(reg?.defaults?.total_cheques ?? 0),
                closing_note:         '',
                denominationCounts:   denoms,
            };
        };

        const buildCloseRegisterDenominationsPayload = () => {
            const out = {};
            const d = closeRegisterForm.value.denominationCounts || {};
            for (const [k, v] of Object.entries(d)) {
                const n = parseInt(v, 10);
                if (!Number.isFinite(n) || n <= 0) continue;
                out[k] = n;
            }
            return Object.keys(out).length ? out : undefined;
        };

        const runCloseRegisterFlow = async () => {
            closeRegisterFlowBusy.value = true;
            try {
                closeRegisterStep.value = 'upload';
                closeRegisterMessage.value = t('pushing_pending_before_close');
                let flush;
                try {
                    flush = await flushPendingTransactionsForClose();
                } catch (e) {
                    await recordPushFailures(null, t('close_push_error_record', { error: e.message }));
                    closeRegisterStep.value = 'error';
                    closeRegisterMessage.value = e.message || String(e);
                    return;
                }
                if (!flush.ok) {
                    closeRegisterStep.value = 'error';
                    let base;
                    if (flush.reason === 'stuck_pending' || flush.reason === 'max_rounds') {
                        base = t('close_queue_not_drained');
                    } else if (flush.reason === 'batch_failed') {
                        base = t('close_server_rejected_some');
                    } else {
                        base = t('close_push_incomplete');
                    }
                    const tail = flush.detail ? `\n\n${flush.detail}` : '';
                    closeRegisterMessage.value = base + tail;
                    return;
                }

                closeRegisterStep.value = 'fetching';
                closeRegisterMessage.value = t('loading_register_summary');
                const { ok, status, data } = await apiFetchJson('/api/sync/cash-register');
                if (status === 403) {
                    if (data?.permissions) await persistCashRegisterPermissions(data.permissions);
                    closeRegisterStep.value = 'error';
                    closeRegisterMessage.value = data?.message || t('not_allowed_view_close_register');
                    return;
                }
                if (!ok) {
                    closeRegisterStep.value = 'error';
                    closeRegisterMessage.value = (data && data.message) || t('couldnt_load_register', { status });
                    return;
                }
                if (data?.permissions) await persistCashRegisterPermissions(data.permissions);
                closeRegisterSnapshot.value = data;
                if (!data.has_open_register) {
                    hasOpenRegister.value = false;
                    closeRegisterStep.value = 'no_register';
                    closeRegisterMessage.value = data.message || t('no_open_register');
                    return;
                }

                // Block close only for failed/conflict sales from THIS session.
                // Old failures from previous sessions are irrelevant to the current register's summary.
                const openTs = data.register?.open_time ? new Date(data.register.open_time).getTime() : null;
                const sessionBlocked = await db.transactions
                    .where('sync_status').anyOf(['failed', 'conflict'])
                    .filter(tx => !openTs || new Date(tx.created_at).getTime() >= openTs)
                    .count();
                if (sessionBlocked > 0) {
                    const detail = await collectRecentSyncErrors();
                    closeRegisterStep.value = 'error';
                    closeRegisterMessage.value = t('close_failed_sales') + (detail ? `\n\n${detail}` : '');
                    return;
                }

                hasOpenRegister.value = true;
                initCloseRegisterFormFromSnapshot(data);
                closeRegisterStep.value = 'form';
                closeRegisterMessage.value = '';
            } finally {
                closeRegisterFlowBusy.value = false;
            }
        };

        const openCloseRegisterFlow = async () => {
            if (!hasSyncCredentials()) { toast(t('set_server_and_api_first'), 'error'); return; }
            if (!isOnline.value) {
                toast(t('close_requires_online'), 'error');
                return;
            }
            if (closeRegisterFlowBusy.value) return;
            showCloseRegisterModal.value = true;
            closeRegisterSnapshot.value = null;
            closeRegisterStep.value = 'upload';
            closeRegisterMessage.value = '';
            await runCloseRegisterFlow();
        };

        const retryCloseRegisterFlow = () => { runCloseRegisterFlow(); };

        const submitCloseRegister = async () => {
            if (!hasSyncCredentials() || !isOnline.value) return;
            if (closeRegisterFlowBusy.value) return;
            const f = closeRegisterForm.value;
            const slips = parseInt(f.total_card_slips, 10);
            const cheques = parseInt(f.total_cheques, 10);
            if (!Number.isFinite(slips) || slips < 0 || !Number.isFinite(cheques) || cheques < 0) {
                toast(t('enter_valid_slip_counts'), 'error');
                return;
            }
            const body = {
                closing_amount:     f.closing_amount,
                total_card_slips:   slips,
                total_cheques:      cheques,
                closing_note:       f.closing_note || undefined,
            };
            const denoms = buildCloseRegisterDenominationsPayload();
            if (denoms) body.denominations = denoms;

            closeRegisterFlowBusy.value = true;
            closeRegisterStep.value = 'submitting';
            closeRegisterMessage.value = t('closing_register');
            try {
                const { ok, status, data } = await apiFetchJson('/api/sync/cash-register/close', {
                    method: 'POST',
                    body: JSON.stringify(body),
                });
                if (status === 403) {
                    closeRegisterStep.value = 'error';
                    closeRegisterMessage.value = data?.message || t('not_allowed_close_register');
                    return;
                }
                if (!ok || !data?.success) {
                    closeRegisterStep.value = 'error';
                    const errs = data?.errors ? Object.values(data.errors).flat().join(' ') : '';
                    closeRegisterMessage.value = (data?.message || errs || t('close_failed_status', { status })).trim();
                    return;
                }
                toast(data?.message || t('register_closed'), 'success');
                hasOpenRegister.value = false;
                openRegisterAutoDismissed.value = false;
                showCloseRegisterModal.value = false;
                resetCart();
                await loadSales();
            } catch (e) {
                closeRegisterStep.value = 'error';
                closeRegisterMessage.value = e.message || String(e);
            } finally {
                closeRegisterFlowBusy.value = false;
            }
        };

        const dismissCloseRegisterModal = () => {
            if (closeRegisterFlowBusy.value) return;
            showCloseRegisterModal.value = false;
        };

        const retryFailed = async () => {
            const failed = await db.transactions
                .where('sync_status').anyOf(['failed', 'conflict']).toArray();
            for (const s of failed) {
                await db.transactions.update(s.id, { sync_status: 'pending', sync_error: null });
            }
            await loadSales();
        };

        // ════════════════════════════════════════════════════════════════════
        // MOUNT
        // ════════════════════════════════════════════════════════════════════

        onMounted(async () => {
            // Mobile (Android) Bluetooth printer discovery results pushed from printer.js.
            window.addEventListener('zat-android-bluetooth-printers', (e) => {
                bluetoothPrinters.value = (e.detail && e.detail.devices) || [];
            });

            await loadSettings();

            // ─── Initialize app version from platform API ───────────────
            appVersion.value = await window.api.getAppVersion();

            // ─── Initialize network status from Capacitor (if available) ───
            // NOTE: this must run inside an async function — these two blocks were
            // previously top-level statements in setup() (which is not async), an
            // invalid `await` that made the entire file fail to parse.
            if (window.api?.isCapacitor?.()) {
                try {
                    const status = await window.api.getNetworkStatus();
                    isOnline.value = status.connected;
                } catch (e) {
                    console.warn('Could not initialize Capacitor network status:', e);
                }
            }

            // ─── Subscribe to Capacitor Network changes (Android only) ───
            if (window.api?.isCapacitor?.()) {
                try {
                    const { Network } = window.Capacitor.Plugins;
                    await Network.addListener('networkStatusChange', (status) => {
                        // Android redelivers this event on every minor link change (signal/
                        // link-speed fluctuations), not just real connect/disconnect — so
                        // only react when the state actually flips, or every blip re-toasts.
                        const wasOnline = isOnline.value;
                        isOnline.value = status.connected;
                        if (status.connected === wasOnline) return;
                        if (status.connected) {
                            toast(t('back_online'), 'success');
                            refreshCashRegisterPermissions();
                            restartAutoSyncScheduler();
                        } else {
                            toast(t('connection_lost'), 'error');
                        }
                    });
                } catch (e) {
                    console.warn('Could not subscribe to Capacitor network changes:', e);
                }
            }

            if (settings.value.serverUrl && settings.value.apiKey && isOnline.value) {
                try {
                    const cfg = await apiGet('/api/sync/config' + (settings.value.locationId ? '?location_id=' + encodeURIComponent(settings.value.locationId) : ''));
                    await applySublocationFromConfig(cfg);
                    await applyTokenExpiryFromConfig(cfg);
                    await applyCashierFromConfig(cfg);
                    await persistConfig();
                } catch {
                    /* offline or server unreachable — keep cached expiry */
                }
                await refreshCashRegisterPermissions();
            }
            products.value  = await db.products.toArray();
            productsReady.value = true;
            await refreshCustomerList();
            await loadSales();
            await loadHeldSales();
            refocusSearch();

            // Measure grid container height so virtual scroll knows how many rows fit.
            nextTick(() => {
                if (gridEl.value) {
                    gridContainerH.value = gridEl.value.clientHeight;
                    new ResizeObserver(() => {
                        if (gridEl.value) gridContainerH.value = gridEl.value.clientHeight;
                    }).observe(gridEl.value);
                }
            });

            document.addEventListener('click', (e) => {
                if (!e.target.closest('[data-pos-dropdown]')) {
                    showCustomerDropdown.value  = false;
                    showProductSuggestion.value = false;
                }
            });

            // ─── Drag-to-resize between products panel and cart panel ───
            let dragging = false, startX = 0, startW = 0;
            let savedProdWidth = '';
            let savedCartWidth = '';
            let activeDragHandle = null;

            const getResizeEls = () => {
                const layout = document.getElementById('pos-layout');
                const prodPanel = document.getElementById('products-panel');
                const cartPanel = document.getElementById('cart-panel');
                const dragHandle = document.getElementById('drag-handle');
                if (!layout || !prodPanel || !cartPanel || !dragHandle) return null;
                return { layout, prodPanel, cartPanel, dragHandle };
            };

            const stopDragging = () => {
                if (!dragging) return;
                dragging = false;
                if (activeDragHandle) activeDragHandle.classList.remove('dragging');
                activeDragHandle = null;
                document.body.style.cursor = '';
                document.body.style.userSelect = '';
            };

            const applyCartLayoutMode = (mode, prevMode) => {
                const els = getResizeEls();
                if (!els) return;
                const { prodPanel, cartPanel } = els;

                if (mode === 'fullcart') {
                    // Keep the user split ratio and restore it when leaving full-cart mode.
                    if (prevMode !== 'fullcart') {
                        savedProdWidth = prodPanel.style.width;
                        savedCartWidth = cartPanel.style.width;
                    }
                    stopDragging();
                    cartPanel.style.width = '100%';
                    cartPanel.style.flex = '1 1 auto';
                    return;
                }

                cartPanel.style.flex = '1';
                cartPanel.style.width = savedCartWidth || '';
                prodPanel.style.width = savedProdWidth || '70%';
                prodPanel.style.flex = 'none';
            };

            watch(tileSize, (mode, prevMode) => {
                applyCartLayoutMode(mode, prevMode);
            }, { immediate: true });

            document.addEventListener('mousedown', (e) => {
                const handle = e.target && e.target.closest ? e.target.closest('#drag-handle') : null;
                if (!handle || tileSize.value === 'fullcart') return;
                const els = getResizeEls();
                if (!els) return;

                dragging = true;
                startX = e.clientX;
                startW = els.prodPanel.offsetWidth;
                activeDragHandle = els.dragHandle;
                activeDragHandle.classList.add('dragging');
                document.body.style.cursor = 'col-resize';
                document.body.style.userSelect = 'none';
            });

            document.addEventListener('mousemove', (e) => {
                if (!dragging) return;
                const els = getResizeEls();
                if (!els) {
                    stopDragging();
                    return;
                }

                const { layout, prodPanel, cartPanel, dragHandle } = els;
                const totalW = layout.offsetWidth - dragHandle.offsetWidth;
                const delta = e.clientX - startX;
                const newW = Math.max(200, Math.min(totalW - 200, startW + delta));
                prodPanel.style.width = newW + 'px';
                prodPanel.style.flex = 'none';
                cartPanel.style.width = (totalW - newW) + 'px';
                cartPanel.style.flex = 'none';
            });

            document.addEventListener('mouseup', stopDragging);

            // Touch support
            document.addEventListener('touchstart', (e) => {
                const handle = e.target && e.target.closest ? e.target.closest('#drag-handle') : null;
                if (!handle || tileSize.value === 'fullcart' || !e.touches || !e.touches[0]) return;
                const els = getResizeEls();
                if (!els) return;

                dragging = true;
                startX = e.touches[0].clientX;
                startW = els.prodPanel.offsetWidth;
                activeDragHandle = els.dragHandle;
                activeDragHandle.classList.add('dragging');
            }, { passive: true });

            document.addEventListener('touchmove', (e) => {
                if (!dragging || !e.touches || !e.touches[0]) return;
                const els = getResizeEls();
                if (!els) {
                    stopDragging();
                    return;
                }

                const { layout, prodPanel, cartPanel, dragHandle } = els;
                const totalW = layout.offsetWidth - dragHandle.offsetWidth;
                const delta = e.touches[0].clientX - startX;
                const newW = Math.max(200, Math.min(totalW - 200, startW + delta));
                prodPanel.style.width = newW + 'px';
                prodPanel.style.flex = 'none';
                cartPanel.style.width = (totalW - newW) + 'px';
                cartPanel.style.flex = 'none';
            }, { passive: true });

            document.addEventListener('touchend', stopDragging);

            autoSyncUiTimerId = setInterval(() => {
                autoSyncClock.value = Date.now();
            }, 1000);
        });

        onUnmounted(() => {
            stopAutoSyncScheduler();
            if (autoSyncUiTimerId != null) {
                clearInterval(autoSyncUiTimerId);
                autoSyncUiTimerId = null;
            }
        });

        // ─── Browser network listeners (fallback for Electron/Web) ───
        // Skipped under Capacitor: the WebView still dispatches these same DOM events
        // alongside the native Network plugin listener above, so registering both
        // fired every connectivity change (and toast) twice on Android.
        if (!window.api?.isCapacitor?.()) {
            window.addEventListener('online',  () => {
                isOnline.value = true;
                toast(t('back_online'), 'success');
                refreshCashRegisterPermissions();
                restartAutoSyncScheduler();
            });
            window.addEventListener('offline', () => { isOnline.value = false; toast(t('connection_lost'), 'error'); });
        }

        // ════════════════════════════════════════════════════════════════════
        // EXPOSE
        // ════════════════════════════════════════════════════════════════════

        return {
            // Data
            products, categories, brands, customers, locations, business, sales, heldSales, printers,
            commissionAgents, priceGroups, invoiceSchemes, customerGroups, taxRates,
            // Cart
            cart, selectedCustomer, selectedCustomerName,
            orderDiscountInput, discountType, saleNote, staffNote, saleStatus,
            // Order config
            transactionDate, commissionAgentId, selectedPriceGroupId, invoiceSchemeId,
            // Shipping
            shippingCharges, shippingDetails, shippingAddress, shippingStatus, deliveredTo, deliveryPerson,
            showShippingModal,
            // Order tax
            selectedOrderTaxRateId, showOrderTaxModal,
            // Round off
            enableRoundOff,
            // Packing
            packingCharge, showPackingModal,
            // RP
            rpRedeemed, rpRedeemedAmount, maxRpRedeemable, rpAmountPerPoint,
            // UI
            currentPage, productSearch, selectedCategory, selectedBrand,
            showProductSuggestion, showCustomerDropdown,
            showPaymentModal, showDiscountModal, showLineEditModal,
            showSyncPanel, showSettings, showBrandDrawer, sideNavCollapsed, productsReady,
            showHeldSalesModal, showOrderConfigStrip,
            showClearCartConfirmModal,
            showCloseRegisterControl,
            showCloseRegisterModal, closeRegisterStep, closeRegisterMessage, closeRegisterSnapshot, closeRegisterForm,
            showOpenRegisterModal, openRegisterBusy, openRegisterError, openRegisterForm,
            editingItem, editingIndex, viewingSale, lastReceipt,
            searchFields, showSearchConfigModal, tileSize,
            showManualSearchModal, manualSearchQuery,
            manualSearchCategoryId, manualSearchBrandId, manualSearchQty,
            addToCartManual,
            // Suspend
            showSuspendModal, suspendNote,
            // Recent transactions
            showRecentTransactionsModal, recentTransTab, recentTransCounts,
            // Modifiers
            showModifierModal, pendingProductForModifier, tempModifierSelections,
            // Lots
            showLotModal, pendingProductForLot, selectedLot,
            showAddCustomerModal, newCustomerForm, newCustomerFieldErrors,
            // Returns
            showReturnModal, returningFromSale, returnItems, returnTotal, returnMethod,
            // Payment
            payments, paymentMethods, changeReturnMethod,
            // Sales filters
            salesSearch, salesDateFrom, salesDateTo, salesStatusFilter, salesSyncFilter,
            // Sync
            isOnline, isSyncing, pushingSales, syncStatus, syncLog, pushFailureAudit, lastSyncAt, sublocation,
            autoSyncIntervalSeconds, autoSyncEveryLabel, autoSyncSidebarStatus,
            syncTokenExpiryBanner,
            // Toasts
            toasts,
            // Settings
            settings, searchInput,
            // i18n
            lang, dir, t, setLang,
            profileRegistry, cashierDisplayName, activeProfileEntry, currentLocationName, unsyncedForAccountSwitch,
            showAddAccountModal, addAccountTokenInput, preAccountSwitchBusy,
            addAccountOtpInput, addAccountOtpBusy, addAccountOtpError, addAccountFromOtp,
            showConnectForm, connectServerUrl, connectOtpDigits, connectOtpBusy, connectOtpError,
            connectPendingToken, connectLocations, connectLocationId, connectSaveBusy,
            openConnectForm, onOtpDigitInput, onOtpDigitKeydown, saveConnection,
            // Computed
            displayProducts, filteredProducts, filteredCustomers, manualSearchResults,
            pricedProducts, recentSalesForTab,
            totalItems, subtotalGross, totalLineDisc, subtotal,
            orderDiscount, orderTaxAmount, grandTotal, totalPaid, balanceDue, changeReturn,
            roundOffAmount, baseTotal,
            pendingSalesCount, failedSalesCount, abandonedSalesCount, filteredSales,
            // Line helpers
            lineGross, lineDiscAmt, lineNet, lineModifiersTotal,
            // Formatters
            fmt, fmtDate,
            // Methods
            addToCart, updateQty, removeFromCart, clearCart, resetCart, addFirstSearchResult, focusSearch,
            startCameraBarcodeScan, cancelCameraBarcodeScan, scannerActive,
            confirmClearCart,
            onPrimarySearchInput,
            selectCustomer, clearCustomer,
            openAddCustomerModal, dismissAddCustomerModal, submitNewCustomer,
            openLineEdit, saveLineItem,
            openModifierModal, confirmModifiers,
            openLotModal, confirmLot,
            applyRewardPoints, removeRewardPoints,
            holdSale, openSuspendModal, confirmSuspend, loadHeldSales, resumeHeldSale, deleteHeldSale,
            openRecentTransactions, resumeFromRecent,
            openPaymentModal, addPaymentRow, expressCash, expressCard, expressCreditSale, saveSale, processPayment,
            printReceipt,
            openReturnModal, selectAllReturnItems, saveReturn,
            loadSales, viewSale, retrySingle, discardLocalUnsyncedSale,
            saveSettings, loadLocations, saveLocalPrinterConfig, localPrinterName,
            // Mobile (Android) UI + printer picker
            mobileCartOpen, mobileProductViewMode,
            bluetoothPrinters, isScanningBluetoothPrinters, selectedBluetoothPrinterInfo,
            wifiPrinterIp, selectedPrinterType,
            scanBluetoothPrinters, selectBluetoothPrinter, saveWifiPrinterIp,
            // Settings tabs + printer CRUD
            settingsTab, localPrinters, printerPickerOptions,
            showPrinterFormModal, editingLocalPrinterId, printerForm,
            openAddPrinterForm, openEditPrinterForm, savePrinterForm, deleteLocalPrinter,
            trayHealth, availableTrayPrinters, isLoadingTrayPrinters,
            refreshTrayHealth, loadAvailableTrayPrinters,
            switchToProfile, openSwitchAccountModal, verifyCashierAndSwitch,
            showSwitchAccountModal, switchAccountUsername, switchAccountPassword, switchAccountBusy, switchAccountError,
            addAccountFromEnvSnippet, runPreAccountSwitchSync,
            syncAll, pushSales, retryFailed, clearPushFailureAudit,
            syncFailureLog, clearSyncFailureLog,
            appVersion, updateStatus, updateInfo, checkForUpdate, openUpdateDownload,
            openCloseRegisterFlow, retryCloseRegisterFlow, submitCloseRegister, dismissCloseRegisterModal,
            openOpenRegisterFlow, submitOpenRegister, dismissOpenRegisterModal, switchCloseModalToOpenRegister,
            gridEl, onGridScroll, visibleProducts, vTopPad, vBottomPad, vTotalH,
            mListVisibleProducts, mListTopPad, mListBottomPad,
            // Backup
            autoBackupEnabled, backupFileApiSupported, isExporting, isImporting,
            exportBackup, importBackup, pickAutoBackupFile, disableAutoBackup,
        };
    }
}).mount('#app');
