/**
 * Phrygix — Temporary Email Service
 * Powered by 1secmail API (https://www.1secmail.com/api/)
 *
 * Anonymous disposable email addresses. Burn after use.
 */

'use strict';

class TempMail {
    constructor() {
        this.API_BASE = 'https://www.1secmail.com/api/v1/';
        this.REFRESH_INTERVAL = 10000;
        this.STORAGE_KEY = 'phrygix_account_v1';

        this.email = null;
        this.login = null;
        this.domain = null;

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

        this.el.modal.addEventListener('click', (e) => {
            if (e.target === this.el.modal) this.closeModalView();
        });

        document.addEventListener('keydown', (e) => {
            if (e.key === 'Escape' && this.el.modal.classList.contains('active')) {
                this.closeModalView();
            }
        });

        window.addEventListener('beforeunload', () => this.stopAutoRefresh());

        document.addEventListener('visibilitychange', () => {
            if (!document.hidden && this.email) this.fetchMessages();
        });
    }

    initNodeId() {
        if (!this.el.nodeId) return;
        this.el.nodeId.textContent = 'NX-' + Math.random().toString(36).substring(2, 8).toUpperCase();
    }

    /* ==========================================================
       SESSION
       ========================================================== */

    restoreSession() {
        const saved = localStorage.getItem(this.STORAGE_KEY);
        if (!saved) return;
        try {
            const data = JSON.parse(saved);
            if (!data.email || !data.login || !data.domain) return;
            this.email = data.email;
            this.login = data.login;
            this.domain = data.domain;
            this.el.emailInput.value = this.email;
            this.enableButtons();
            this.fetchMessages();
            this.startAutoRefresh();
        } catch (err) {
            localStorage.removeItem(this.STORAGE_KEY);
        }
    }

    saveSession() {
        localStorage.setItem(this.STORAGE_KEY, JSON.stringify({
            email: this.email,
            login: this.login,
            domain: this.domain,
            savedAt: Date.now()
        }));
    }

    clearSession() {
        localStorage.removeItem(this.STORAGE_KEY);
    }

    /* ==========================================================
       GENERATE
       ========================================================== */

    async generateEmail() {
        this.setButtonLoading(this.el.generateBtn, 'GENERATING...');

        try {
            const res = await fetch(`${this.API_BASE}?action=genRandomMailbox&count=1`);
            if (!res.ok) throw new Error(`API error (${res.status})`);
            const data = await res.json();

            if (!Array.isArray(data) || data.length === 0) {
                throw new Error('No email generated');
            }

            const fullEmail = data[0];
            const [login, domain] = fullEmail.split('@');

            this.email = fullEmail;
            this.login = login;
            this.domain = domain;
            this.knownMessageIds.clear();
            this.currentMessages = [];
            this.hasBaseline = false;

            this.el.emailInput.value = fullEmail;
            this.enableButtons();
            this.clearMessages();
            this.saveSession();
            this.showToast('>> ADDRESS GENERATED');
            this.startAutoRefresh();
            this.fetchMessages();

        } catch (err) {
            console.error('Generate error:', err);
            this.showToast('!! ' + (err.message || 'FAILED TO GENERATE'), true);
        } finally {
            this.resetButton(this.el.generateBtn, 'GENERATE ADDRESS');
        }
    }

    /* ==========================================================
       FETCH MESSAGES
       ========================================================== */

    async fetchMessages(showSpinner = false) {
        if (!this.email || this.isFetching) return;
        this.isFetching = true;

        if (showSpinner) {
            this.el.refreshBtn.innerHTML = '<span class="loading"></span> REFRESHING...';
            this.el.refreshBtn.disabled = true;
        }

        try {
            const url = `${this.API_BASE}?action=getMessages&login=${encodeURIComponent(this.login)}&domain=${encodeURIComponent(this.domain)}`;
            const res = await fetch(url);

            if (!res.ok) throw new Error(`API error (${res.status})`);

            const messages = await res.json();
            const list = Array.isArray(messages) ? messages : [];

            this.detectNewMessages(list);
            this.renderMessages(list);
            this.currentMessages = list;

        } catch (err) {
            console.error('Fetch error:', err);
            if (showSpinner) this.showToast('!! ' + err.message, true);
        } finally {
            this.isFetching = false;
            if (showSpinner) this.resetButton(this.el.refreshBtn, '⟳ REFRESH INBOX');
        }
    }

    detectNewMessages(messages) {
        if (!messages.length) { this.hasBaseline = true; return; }
        const incoming = messages.filter(m => !this.knownMessageIds.has(m.id));
        messages.forEach(m => this.knownMessageIds.add(m.id));
        if (this.hasBaseline && incoming.length > 0) {
            const count = incoming.length;
            this.showToast(`>> ${count} NEW TRANSMISSION${count > 1 ? 'S' : ''} INTERCEPTED`);
        }
        this.hasBaseline = true;
    }

    /* ==========================================================
       RENDER
       ========================================================== */

    renderMessages(messages) {
        this.el.messageCount.textContent = messages.length;

        if (messages.length === 0) {
            this.el.messages.innerHTML = `
                <div class="empty-state">
                    <div class="empty-glyph">&gt;_</div>
                    <p>No transmissions intercepted.</p>
                    <p class="empty-hint">Generate an address to begin monitoring.</p>
                </div>`;
            return;
        }

        const sorted = [...messages].sort((a, b) => new Date(b.date || 0) - new Date(a.date || 0));

        this.el.messages.innerHTML = sorted.map(msg => `
            <div class="message-item" data-id="${this.escapeAttr(msg.id)}" role="button" tabindex="0">
                <div class="msg-from">${this.escapeHtml(msg.from || 'unknown@relay')}</div>
                <div class="msg-subject">${this.escapeHtml(msg.subject || '(no subject)')}</div>
                <div class="msg-preview">${this.escapeHtml((msg.subject || '').substring(0, 60) || 'no preview')}</div>
                <div class="msg-date">${this.formatDate(msg.date)}</div>
            </div>
        `).join('');

        this.el.messages.querySelectorAll('.message-item').forEach(el => {
            const id = el.dataset.id;
            el.addEventListener('click', () => this.viewMessage(id));
            el.addEventListener('keydown', (e) => {
                if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); this.viewMessage(id); }
            });
        });
    }

    async viewMessage(id) {
        try {
            const url = `${this.API_BASE}?action=readMessage&login=${encodeURIComponent(this.login)}&domain=${encodeURIComponent(this.domain)}&id=${encodeURIComponent(id)}`;
            const res = await fetch(url);
            if (!res.ok) throw new Error(`API error (${res.status})`);

            const msg = await res.json();
            if (!msg || !msg.id) {
                this.showToast('!! MESSAGE NO LONGER AVAILABLE', true);
                this.fetchMessages();
                return;
            }

            this.el.modalSubject.textContent = msg.subject || '(no subject)';
            this.el.modalFrom.textContent = msg.from || 'unknown';
            this.el.modalDate.textContent = this.formatDate(msg.date, true);

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

        const htmlBody = msg.htmlBody || '';
        const textBody = msg.textBody || '';

        if (htmlBody) {
            const iframe = document.createElement('iframe');
            iframe.setAttribute('sandbox', 'allow-popups allow-popups-to-escape-sandbox');
            iframe.setAttribute('referrerpolicy', 'no-referrer');
            body.appendChild(iframe);
            const doc = iframe.contentDocument || iframe.contentWindow.document;
            doc.open();
            doc.write(this.buildIframeDocument(htmlBody));
            doc.close();
            iframe.addEventListener('load', () => {
                try {
                    const h = doc.documentElement.scrollHeight;
                    iframe.style.height = Math.max(300, h + 40) + 'px';
                } catch (_) {}
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
        return `<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><base target="_blank"><style>*{max-width:100%}html,body{margin:0;padding:16px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;font-size:14px;line-height:1.6;color:#1e293b;background:#fff;word-wrap:break-word;overflow-wrap:break-word}img{max-width:100%;height:auto}a{color:#00b8cc}table{max-width:100%}pre{white-space:pre-wrap;word-wrap:break-word}</style></head><body>${html}</body></html>`;
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
        if (!this.email) return;
        if (!confirm('Terminate this address? This action is irreversible.')) return;
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
            this.showToast('!! COPY FAILED', true);
        }
    }

    fallbackCopy(text) {
        const ta = document.createElement('textarea');
        ta.value = text; ta.style.position = 'fixed'; ta.style.opacity = '0';
        document.body.appendChild(ta); ta.select();
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
        if (this.refreshTimer) { clearInterval(this.refreshTimer); this.refreshTimer = null; }
    }

    /* ==========================================================
       UI STATE
       ========================================================== */

    resetUI() {
        this.stopAutoRefresh();
        this.email = null; this.login = null; this.domain = null;
        this.knownMessageIds.clear();
        this.currentMessages = [];
        this.hasBaseline = false;
        this.el.emailInput.value = '';
        this.el.refreshBtn.disabled = true;
        this.el.deleteBtn.disabled = true;
        this.clearMessages();
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
            </div>`;
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
        this.toastTimer = setTimeout(() => this.el.toast.classList.remove('show'), 3200);
    }

    /* ==========================================================
       UTILITIES
       ========================================================== */

    formatDate(dateStr, full = false) {
        if (!dateStr) return '';
        const date = new Date(dateStr);
        if (isNaN(date.getTime())) return '';
        if (full) return date.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
        const diffSec = (Date.now() - date.getTime()) / 1000;
        if (diffSec < 60) return 'just now';
        if (diffSec < 3600) return `${Math.floor(diffSec / 60)}m ago`;
        if (diffSec < 86400) return `${Math.floor(diffSec / 3600)}h ago`;
        return date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
    }

    escapeHtml(text) {
        if (text == null) return '';
        return String(text).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
    }

    escapeAttr(text) { return this.escapeHtml(text).replace(/`/g, '&#96;'); }
}

document.addEventListener('DOMContentLoaded', () => {
    try { window.phrygix = new TempMail(); }
    catch (err) { console.error('Failed to initialize Phrygix:', err); }
});
