/* Rail Survey – live dictation into the notes box via the Web Speech API (webkitSpeechRecognition).
   Appends to existing text, en-GB. States: idle | starting | listening | stopping.
   Every path ends back at 'idle' (fallback timers), so the button can never freeze. */
'use strict';

let DICT_START_TIMEOUT_MS = 5000;   // no 'start' event within this → give up
let DICT_STOP_FALLBACK_MS = 1500;   // no 'end' event after stop() → force idle
let DICT_MAX_MS = 120000;           // hard limit per dictation session

function speechClass() { return window.SpeechRecognition || window.webkitSpeechRecognition || null; }

class Dictation {
  constructor({ textarea, button, cancelButton, status, onState }) {
    this.ta = textarea; this.btn = button; this.cancelBtn = cancelButton; this.statusEl = status; this.onState = onState || (() => {});
    this.state = 'idle'; this.rec = null; this.session = 0; this.base = ''; this.finalText = ''; this.timers = []; this.lastTap = 0;
    this.render();
  }
  get supported() { return !!speechClass(); }
  clearTimers() { this.timers.forEach(t => clearTimeout(t)); this.timers = []; }
  later(fn, ms) { const s = this.session; this.timers.push(setTimeout(() => { if (s === this.session) fn(); }, ms)); }
  setState(s, msg) { this.state = s; if (msg !== undefined) this.message = msg; this.render(); this.onState(s); }
  render() {
    if (!this.btn) return;
    const s = this.state;
    this.btn.classList.toggle('listening', s === 'listening' || s === 'starting');
    this.btn.disabled = s === 'stopping';
    this.btn.innerHTML = s === 'idle' ? '<span aria-hidden="true">🎙</span> Dictate'
      : s === 'starting' ? '<span class="spinner"></span> Starting…'
      : s === 'listening' ? '<span class="rec-dot" aria-hidden="true"></span> Stop'
      : '<span class="spinner"></span> Finishing…';
    if (this.cancelBtn) this.cancelBtn.hidden = !(s === 'listening' || s === 'starting');
    if (this.statusEl) {
      let m = this.message || '';
      if (!m && s === 'listening') m = 'Listening… speak now. Tap Stop when done.';
      this.statusEl.textContent = m; this.statusEl.hidden = !m;
      this.statusEl.classList.toggle('warn', !!this.message && s === 'idle');
    }
  }
  toggle() {
    const now = Date.now(); if (now - this.lastTap < 400) return; this.lastTap = now; // ignore double taps
    if (this.state === 'idle') this.start();
    else if (this.state === 'listening' || this.state === 'starting') this.stop();
  }
  start() {
    const SR = speechClass();
    if (!SR) { this.setState('idle', 'Live dictation isn’t available here. Tap in the notes box and use the 🎤 microphone key on the iPhone keyboard instead.'); return; }
    this.teardown();
    const session = this.session;
    this.base = this.ta.value; this.finalText = '';
    let r;
    try { r = new SR(); r.lang = 'en-GB'; r.continuous = true; r.interimResults = true; r.maxAlternatives = 1; }
    catch (e) { this.setState('idle', 'Couldn’t start dictation – use the 🎤 key on the iPhone keyboard instead.'); return; }
    r.onstart = () => { if (session === this.session && this.state === 'starting') this.setState('listening', ''); };
    r.onaudiostart = r.onstart;
    r.onresult = ev => {
      if (session !== this.session) return;
      if (this.state === 'starting') this.setState('listening', '');
      let interim = '';
      for (let i = ev.resultIndex; i < ev.results.length; i++) {
        const res = ev.results[i];
        if (res.isFinal) this.finalText += res[0].transcript.trim() + ' ';
        else interim += res[0].transcript;
      }
      this.write((this.finalText + interim).trim());
    };
    r.onerror = ev => {
      if (session !== this.session) return;
      const n = ev && ev.error;
      const msg = (n === 'not-allowed' || n === 'service-not-allowed')
        ? 'Dictation isn’t allowed. Check iPhone Settings › Safari › Microphone, and that Siri & Dictation is on – or use the 🎤 key on the keyboard.'
        : n === 'no-speech' ? 'Didn’t hear anything – tap Dictate to try again.'
        : n === 'network' ? 'Dictation needs a data connection here – use the 🎤 key on the iPhone keyboard (works offline on newer iPhones).'
        : n === 'audio-capture' ? 'No microphone available.'
        : n === 'aborted' ? '' : 'Dictation stopped unexpectedly – your text has been kept.';
      this.finish(msg);
    };
    r.onend = () => { if (session === this.session) this.finish(this.state === 'starting' ? (this.message || 'Dictation ended before it started – try again, or use the keyboard 🎤.') : undefined); };
    this.rec = r;
    this.setState('starting', '');
    try { r.start(); }
    catch (e) { this.finish('Couldn’t start dictation – use the 🎤 key on the iPhone keyboard instead.'); return; }
    this.later(() => { if (this.state === 'starting') { this.abortRec(); this.finish('Dictation didn’t start – try again, or use the 🎤 key on the iPhone keyboard.'); } }, DICT_START_TIMEOUT_MS);
    this.later(() => { if (this.state === 'listening') this.stop(); }, DICT_MAX_MS);
  }
  write(text) {
    const b = this.base; const sep = b && !/\s$/.test(b) && text ? (/[.!?]$/.test(b.trim()) ? ' ' : ' ') : '';
    this.ta.value = b + sep + text;
    this.ta.dispatchEvent(new Event('input', { bubbles: true }));
  }
  stop() {
    if (!this.rec) { this.finish(); return; }
    this.setState('stopping');
    try { this.rec.stop(); } catch (e) { /* ignore */ }
    this.later(() => { if (this.state === 'stopping') { this.abortRec(); this.finish(); } }, DICT_STOP_FALLBACK_MS);
  }
  cancel() { // stop and put the notes back as they were before dictation
    const base = this.base; const wasActive = this.state !== 'idle';
    this.teardown();
    if (wasActive) { this.ta.value = base; this.ta.dispatchEvent(new Event('input', { bubbles: true })); }
    this.setState('idle', wasActive ? 'Dictation cancelled.' : '');
  }
  abortRec() { const r = this.rec; if (!r) return; r.onresult = r.onerror = r.onend = r.onstart = r.onaudiostart = null; try { r.abort(); } catch (e) { /* ignore */ } }
  finish(msg) { this.abortRec(); this.rec = null; this.clearTimers(); this.session++; this.setState('idle', msg === undefined ? '' : msg); }
  teardown() { this.abortRec(); this.rec = null; this.clearTimers(); this.session++; this.state = 'idle'; }
  reset() { this.teardown(); this.message = ''; this.render(); }
}
