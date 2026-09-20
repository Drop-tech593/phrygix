/**
 * Phrygix — Temporary Email Service
 * Powered by Mail.tm API (https://docs.mail.tm)
 * 
 * Anonymous disposable email addresses. Burn after use.
 */

'use strict';

class TempMail {
    constructor() {
        // API Configuration
        this.BASE_URL = 'https://api.mail.tm';
        this.REFRESH_INTERVAL = 10000; // 10 seconds
        this.STORAGE_KEY = 'phrygix_account_v1';

        // Account State
        this.token = null;
        this.accountId = null;
        this.email = null;
        this.password = null;

        // Runtime State
        this.refreshTimer = null;
        this.toastTimer = null;
        this.knownMessageIds = new Set();
        this.isFetching = false;
        this.currentMessages = [];
        this.hasBaseline = false;

        this.initElements();
        this.bindEvents();
        this.initNodeId();
        this.restoreSession();
    }

    /* ==========================================================
       INITIALIZATION
       ========================================================== */

    initElements() {
        this.el = {
            emailInput: document.getElementById('emailAddress'),
            generateBtn: document.getElementById('generateBtn'),
            refreshBtn: document.getElementById('refreshBtn'),
            deleteBtn: document.getElementById('deleteBtn'),
            copyBtn: document.getElementById('copyBtn'),
            messages: document.getElementById('messages'),
            messageCount: document.getElementById('messageCount'),
            toast: document.getElementById('toast'),
            modal: document.getElementById('modal'),
            modalSubject: document.getElementById('modalSubject'),
            modalFrom: document.getElementById('modalFrom'),
            modalDate: document.getElementById('modalDate'),
            modalBody: document.getElementById('modalBody'),
            closeModal: document.getElementById('closeModal'),
            nodeId: document.getElementById('nodeId')
        };
    }

    bindEvents() {
        this.el.generateBtn.addEventListener('click', () => this.generateEmail());
        this.el.refreshBtn.addEventListener('click', () => this.fetchMessages(true));
        this.el.deleteBtn.addEventListener('click', () => this.deleteAccount());
        this.el.copyBtn.addEventListener('click', () => this.copyEmail());
        this.el.closeModal.addEventListener('click', () => this.closeModalView());

        // Close modal on backdrop click
        this.el.modal.addEventListener('click', (e) => {
            if (e.target === this.el.modal) this.closeModalView();
        });

        // Close modal on ESC
        document.addEventListener('keydown', (e) => {
            if (e.key === 'Escape' && this.el.modal.classList.contains('active')) {
                this.closeModalView();
            }
        });

        // Cleanup on page unload
        window.addEventListener('beforeunload', () => this.stopAutoRefresh());

        // Resume fetching when tab becomes visible again
        document.addEventListener('visibilitychange', () => {
            if (!document.hidden && this.token) {
                this.fetchMessages();
            }
        });
    }

    initNodeId() {
        if (!this.el.nodeId) return;
        const id = 'NX-' + Math.random().toString(36).substring(2, 8).toUpperCase();
        this.el.nodeId.textContent = id;
    }

    /* ==========================================================
       SESSION MANAGEMENT
       ========================================================== */

    restoreSession() {
        const saved = localStorage.getItem(this.STORAGE_KEY);
        if (!saved) return;

        try {
            const data = JSON.parse(saved);
            if (!data.token || !data.email) return;

            this.token = data.token;
            this.accountId = data.accountId;
            this.email = data.email;
            this.password = data.password;

            this.el.emailInput.value = this.email;
            this.enableButtons();
            this.fetchMessages();
            this.startAutoRefresh();
        } catch (err) {
            console.warn('Failed to restore session:', err);
            localStorage.removeItem(this.STORAGE_KEY);
        }
    }

    saveSession() {
        try {
            localStorage.setItem(this.STORAGE_KEY, JSON.stringify({
                token: this.token,
                accountId: this.accountId,
                email: this.email,
                password: this.password,
                savedAt: Date.now()
            }));
        } catch (err) {
            console.warn('Failed to save session:', err);
        }
    }

    clearSession() {
        localStorage.removeItem(this.STORAGE_KEY);
    }

    /* ==========================================================
       ACCOUNT GENERATION
       ========================================================== */

    async generateEmail() {
        this.setButtonLoading(this.el.generateBtn, 'GENERATING...');

        try {
            // Step 1: Fetch available domains
            const domain = await this.fetchAvailableDomain();
            if (!domain) throw new Error('No email domains available');

            // Step 2: Build credentials
            const address = `${this.randomString(12)}@${domain}`;
            const password = this.randomString(16, true);

            // Step 3: Create account
            const account = await this.createAccount(address, password);

            // Step 4: Get auth token
            const token = await this.getToken(address, password);

            // Step 5: Update state
            this.token = token;
            this.accountId = account.id;
            this.email = address;
            this.password = password;
            this.knownMessageIds.clear();
            this.currentMessages = [];
            this.hasBaseline = false;

            this.el.emailInput.value = address;
            this.enableButtons();
            this.clearMessages();
            this.saveSession();
            this.showToast('>> ADDRESS GENERATED');
            this.startAutoRefresh();

            // Immediate first fetch
            this.fetchMessages();

        } catch (err) {
            console.error('Generate error:', err);
            this.showToast('!! ' + (err.message || 'FAILED TO GENERATE'), true);
        } finally {
            this.resetButton(this.el.generateBtn, 'GENERATE ADDRESS');
        }
    }

    async fetchAvailableDomain() {
        const res = await this.request('/domains?page=1');
        const list = this.getCollection(res);
        if (!list.length) return null;

        // Prefer a domain that's active
        const active = list.find(d => d.isActive !== false) || list[0];
        return active.domain;
    }

    async createAccount(address, password) {
        const res = await this.request('/accounts', {
            method: 'POST',
            body: { address, password }
        });

        if (!res.id) throw new Error('Invalid account response');
        return res;
    }

    async getToken(address, password) {
        const res = await this.request('/token', {
            method: 'POST',
            body: { address, password }
        });

        if (!res.token) throw new Error('Authentication failed');
        return res.token;
    }

    /* ==========================================================
       FETCHING MESSAGES
       ========================================================== */

    async fetchMessages(showSpinner = false) {
        if (!this.token || this.isFetching) return;
        this.isFetching = true;

        if (showSpinner) {
            this.el.refreshBtn.innerHTML = '<span class="loading"></span> REFRESHING...';
            this.el.refreshBtn.disabled = true;
        }

        try {
            const res = await this.request('/messages?page=1', {}, true);

            // Auth expired
            if (res === null) {
                this.handleAuthError();
                return;
            }

            const messages = this.getCollection(res);
            this.detectNewMessages(messages);
            this.renderMessages(messages);
            this.currentMessages = messages;

        } catch (err) {
            console.error('Fetch error:', err);
            if (showSpinner) this.showToast('!! ' + err.message, true);
        } finally {
            this.isFetching = false;
            if (showSpinner) {
                this.resetButton(this.el.refreshBtn, '⟳ REFRESH INBOX');
            }
        }
    }

    detectNewMessages(messages) {
        if (!messages.length) {
            this.hasBaseline = true;
            return;
        }

        const incoming = messages.filter(m => !this.knownMessageIds.has(m.id));
        messages.forEach(m => this.knownMessageIds.add(m.id));

        // Only notify if we already had a baseline (skip first load)
        if (this.hasBaseline && incoming.length > 0) {
            const count = incoming.length;
            this.showToast(`>> ${count} NEW TRANSMISSION${count > 1 ? 'S' : ''} INTERCEPTED`);
        }

        this.hasBaseline = true;
    }

    /* ==========================================================
       RENDERING
       ========================================================== */

    renderMessages(messages) {
        this.el.messageCount.textContent = messages.length;

        if (messages.length === 0) {
            this.el.messages.innerHTML = `
                <div class="empty-state">
                    <div class="empty-glyph">&gt;_</div>
                    <p>No transmissions intercepted.</p>
                    <p class="empty-hint">Generate an address to begin monitoring.</p>
                </div>
            `;
            return;
        }

        // Sort newest first
        const sorted = [...messages].sort(
            (a, b) => new Date(b.createdAt || 0) - new Date(a.createdAt || 0)
        );

        this.el.messages.innerHTML = sorted.map(msg => `
            <div class="message-item" data-id="${this.escapeAttr(msg.id)}" role="button" tabindex="0">
                <div class="msg-from">${this.escapeHtml(msg.from?.address || 'unknown@relay')}</div>
                <div class="msg-subject">${this.escapeHtml(msg.subject || '(no subject)')}</div>
                <div class="msg-preview">${this.escapeHtml(msg.intro || 'no preview available')}</div>
                <div class="msg-date">${this.formatDate(msg.createdAt)}</div>
            </div>
        `).join('');

        // Attach click + keyboard listeners
        this.el.messages.querySelectorAll('.message-item').forEach(el => {
            const id = el.dataset.id;
            el.addEventListener('click', () => this.viewMessage(id));
            el.addEventListener('keydown', (e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault();
                    this.viewMessage(id);
                }
            });
        });
    }

    async viewMessage(id) {
        try {
            const msg = await this.request(`/messages/${id}`, {}, true);
            if (!msg || !msg.id) {
                this.showToast('!! MESSAGE NO LONGER AVAILABLE', true);
                this.fetchMessages();
                return;
            }

            this.el.modalSubject.textContent = msg.subject || '(no subject)';
            this.el.modalFrom.textContent = msg.from?.address || 'unknown';
            this.el.modalDate.textContent = this.formatDate(msg.createdAt, true);

            this.renderMessageBody(msg);
            this.el.modal.classList.add('active');
            document.body.style.overflow = 'hidden';

        } catch (err) {
            console.error('View message error:', err);
            this.showToast('!! FAILED TO LOAD MESSAGE', true);
        }
    }

    renderMessageBody(msg) {
        const body = this.el.modalBody;
        body.innerHTML = '';

        const htmlParts = Array.isArray(msg.html) ? msg.html : (msg.html ? [msg.html] : []);
        const textBody = Array.isArray(msg.text) ? msg.text.join('\n') : (msg.text || '');

        if (htmlParts.length > 0) {
            // Render HTML safely in a sandboxed iframe
            const iframe = document.createElement('iframe');
            iframe.setAttribute('sandbox', 'allow-popups allow-popups-to-escape-sandbox');
            iframe.setAttribute('referrerpolicy', 'no-referrer');
            body.appendChild(iframe);

            const doc = iframe.contentDocument || iframe.contentWindow.document;
            doc.open();
            doc.write(this.buildIframeDocument(htmlParts.join('\n')));
            doc.close();

            // Auto-resize
            iframe.addEventListener('load', () => {
                try {
                    const h = doc.documentElement.scrollHeight;
                    iframe.style.height = Math.max(300, h + 40) + 'px';
                } catch (_) { /* cross-origin guard */ }
            });
        } else if (textBody) {
            const pre = document.createElement('pre');
            pre.style.whiteSpace = 'pre-wrap';
            pre.style.fontFamily = 'inherit';
            pre.textContent = textBody;
            body.appendChild(pre);
        } else {
            const p = document.createElement('p');
            p.style.color = 'var(--text-mute)';
            p.textContent = '(empty transmission)';
            body.appendChild(p);
        }
    }

    buildIframeDocument(html) {
        return `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<base target="_blank">
<style>
    * { max-width: 100%; }
    html, body {
        margin: 0;
        padding: 16px;
        font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
        font-size: 14px;
        line-height: 1.6;
        color: #1e293b;
        background: #ffffff;
        word-wrap: break-word;
        overflow-wrap: break-word;
    }
    img { max-width: 100%; height: auto; }
    a { color: #00b8cc; }
    table { max-width: 100%; }
    pre { white-space: pre-wrap; word-wrap: break-word; }
</style>
</head>
<body>${html}</body>
</html>`;
    }

    closeModalView() {
        this.el.modal.classList.remove('active');
        document.body.style.overflow = '';
        this.el.modalBody.innerHTML = '';
    }

    /* ==========================================================
       ACTIONS
       ========================================================== */

    async deleteAccount() {
        if (!this.token) return;
        if (!confirm('Terminate this address? This action is irreversible.')) return;

        try {
            if (this.accountId) {
                await fetch(`${this.BASE_URL}/accounts/${this.accountId}`, {
                    method: 'DELETE',
                    headers: { 'Authorization': `Bearer ${this.token}` }
                }).catch(() => { /* ignore */ });
            }
        } catch (err) {
            console.warn('Delete error:', err);
        }

        this.clearSession();
        this.resetUI();
        this.showToast('>> SESSION TERMINATED');
    }

    async copyEmail() {
        if (!this.email) {
            this.showToast('!! GENERATE AN ADDRESS FIRST', true);
            return;
        }

        try {
            if (navigator.clipboard && window.isSecureContext) {
                await navigator.clipboard.writeText(this.email);
            } else {
                this.fallbackCopy(this.email);
            }
            this.showToast('>> COPIED TO CLIPBOARD');
        } catch (err) {
            console.error('Copy error:', err);
            this.showToast('!! COPY FAILED', true);
        }
    }

    fallbackCopy(text) {
        const ta = document.createElement('textarea');
        ta.value = text;
        ta.style.position = 'fixed';
        ta.style.opacity = '0';
        ta.style.pointerEvents = 'none';
        document.body.appendChild(ta);
        ta.select();
        try { document.execCommand('copy'); } finally { document.body.removeChild(ta); }
    }

    /* ==========================================================
       AUTO-REFRESH
       ========================================================== */

    startAutoRefresh() {
        this.stopAutoRefresh();
        this.refreshTimer = setInterval(() => {
            if (!document.hidden) this.fetchMessages();
        }, this.REFRESH_INTERVAL);
    }

    stopAutoRefresh() {
        if (this.refreshTimer) {
            clearInterval(this.refreshTimer);
            this.refreshTimer = null;
        }
    }

    /* ==========================================================
       UI STATE
       ========================================================== */

    resetUI() {
        this.stopAutoRefresh();
        this.token = null;
        this.accountId = null;
        this.email = null;
        this.password = null;
        this.knownMessageIds.clear();
        this.currentMessages = [];
        this.hasBaseline = false;

        this.el.emailInput.value = '';
        this.el.refreshBtn.disabled = true;
        this.el.deleteBtn.disabled = true;
        this.clearMessages();
    }

    handleAuthError() {
        this.clearSession();
        this.resetUI();
        this.showToast('!! SESSION EXPIRED — REGENERATE', true);
    }

    enableButtons() {
        this.el.refreshBtn.disabled = false;
        this.el.deleteBtn.disabled = false;
    }

    clearMessages() {
        this.el.messageCount.textContent = '0';
        this.el.messages.innerHTML = `
            <div class="empty-state">
                <div class="empty-glyph">&gt;_</div>
                <p>No transmissions intercepted.</p>
                <p class="empty-hint">Generate an address to begin monitoring.</p>
            </div>
        `;
    }

    setButtonLoading(btn, text) {
        btn.disabled = true;
        btn.dataset.originalText = btn.textContent;
        btn.innerHTML = `<span class="loading"></span> ${text}`;
    }

    resetButton(btn, text) {
        btn.disabled = false;
        btn.textContent = text;
    }

    showToast(message, isError = false) {
        this.el.toast.textContent = message;
        this.el.toast.className = 'toast show' + (isError ? ' error' : '');

        clearTimeout(this.toastTimer);
        this.toastTimer = setTimeout(() => {
            this.el.toast.classList.remove('show');
        }, 3200);
    }

    /* ==========================================================
       HTTP HELPER (with detailed error handling)
       ========================================================== */

    async request(path, options = {}, requiresAuth = false) {
        const headers = { 'Accept': 'application/json' };

        if (options.body) {
            headers['Content-Type'] = 'application/json';
        }

        if (requiresAuth) {
            if (!this.token) return null;
            headers['Authorization'] = `Bearer ${this.token}`;
        }

        let response;
        try {
            response = await fetch(`${this.BASE_URL}${path}`, {
                method: options.method || 'GET',
                headers,
                body: options.body ? JSON.stringify(options.body) : undefined,
                mode: 'cors',
                cache: 'no-store'
            });
        } catch (networkErr) {
            console.error('Network error on', path, networkErr);
            throw new Error(
                'Network blocked. Disable ad-blockers or try incognito.'
            );
        }

        // Auth expired / invalid
        if (response.status === 401) {
            return null;
        }

        // Rate limited
        if (response.status === 429) {
            throw new Error('Rate limited. Wait 60s and retry.');
        }

        // Forbidden
        if (response.status === 403) {
            throw new Error('Request forbidden (403).');
        }

        if (!response.ok) {
            let detail = `Request failed (${response.status})`;
            try {
                const err = await response.json();
                detail = err['hydra:description'] || err.message || err.detail || detail;
            } catch (_) { /* ignore */ }
            throw new Error(detail);
        }

        if (response.status === 204) return {};

        return response.json();
    }

    /**
     * Normalize Mail.tm collection responses.
     */
    getCollection(data) {
        if (!data) return [];
        if (Array.isArray(data)) return data;
        if (Array.isArray(data['hydra:member'])) return data['hydra:member'];
        if (Array.isArray(data.member)) return data.member;
        return [];
    }

    /* ==========================================================
       UTILITIES
       ========================================================== */

    randomString(length, includeSymbols = false) {
        const letters = 'abcdefghijklmnopqrstuvwxyz';
        const digits = '0123456789';
        const symbols = '!@#$%^&*';
        let charset = letters + digits + letters.toUpperCase();
        if (includeSymbols) charset += symbols;

        const cryptoObj = window.crypto || window.msCrypto;
        if (cryptoObj && cryptoObj.getRandomValues) {
            const bytes = new Uint8Array(length);
            cryptoObj.getRandomValues(bytes);
            let out = '';
            for (let i = 0; i < length; i++) {
                out += charset[bytes[i] % charset.length];
            }
            return out;
        }

        let out = '';
        for (let i = 0; i < length; i++) {
            out += charset[Math.floor(Math.random() * charset.length)];
        }
        return out;
    }

    formatDate(dateStr, full = false) {
        if (!dateStr) return '';
        const date = new Date(dateStr);
        if (isNaN(date.getTime())) return '';

        if (full) {
            return date.toLocaleString(undefined, {
                dateStyle: 'medium',
                timeStyle: 'short'
            });
        }

        const diffSec = (Date.now() - date.getTime()) / 1000;
        if (diffSec < 60) return 'just now';
        if (diffSec < 3600) return `${Math.floor(diffSec / 60)}m ago`;
        if (diffSec < 86400) return `${Math.floor(diffSec / 3600)}h ago`;
        if (diffSec < 604800) return `${Math.floor(diffSec / 86400)}d ago`;

        return date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
    }

    escapeHtml(text) {
        if (text == null) return '';
        return String(text)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#39;');
    }

    escapeAttr(text) {
        return this.escapeHtml(text).replace(/`/g, '&#96;');
    }
}

/* ==========================================================
   BOOTSTRAP
   ========================================================== */

document.addEventListener('DOMContentLoaded', () => {
    try {
        window.phrygix = new TempMail();
    } catch (err) {
        console.error('Failed to initialize Phrygix:', err);
    }
});
