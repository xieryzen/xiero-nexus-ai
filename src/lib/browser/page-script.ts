/**
 * What runs inside a page: the script that reads it and finds what an action
 * is meant for. It runs in a world of its own next to the page's scripts: it
 * sees the same document, and the page's scripts see nothing of it.
 *
 * It is plain JavaScript in a string, because it is sent to the browser as
 * it is. No backticks and no "${" in it.
 */
export const PAGE_SCRIPT = String.raw`
(function () {
  if (globalThis.__xn) return;
  var REFS = new Map();
  var SIGN = {};
  var lastChange = Date.now();
  try {
    new MutationObserver(function () { lastChange = Date.now(); })
      .observe(document, { subtree: true, childList: true, attributes: true, characterData: true });
  } catch (e) {}

  var SKIP = /^(SCRIPT|STYLE|NOSCRIPT|TEMPLATE|HEAD|META|LINK|TITLE|SVG|CANVAS|VIDEO|AUDIO|OBJECT|EMBED|MAP|AREA|SOURCE|TRACK|PARAM|DATALIST)$/i;
  var BLOCK = /^(ADDRESS|ARTICLE|ASIDE|BLOCKQUOTE|DD|DETAILS|DIALOG|DIV|DL|DT|FIELDSET|FIGCAPTION|FIGURE|FOOTER|FORM|HEADER|LI|MAIN|NAV|OL|P|PRE|SECTION|TABLE|TR|UL|SUMMARY|LEGEND|TBODY|THEAD|TFOOT|CAPTION|OPTGROUP)$/;
  var TEXT_TYPES = /^(text|email|password|search|tel|url|number|date|datetime-local|month|week|time|)$/;
  var MAX_CHARS = 200000;
  var MAX_REFS = 3000;

  function clean(s) { return String(s == null ? '' : s).replace(/\s+/g, ' ').trim(); }
  function cut(s, n) { s = clean(s); return s.length > n ? s.slice(0, n - 1) + '…' : s; }
  function quote(s) { return '"' + String(s).replace(/"/g, "'") + '"'; }
  function viewOf(el) { return (el.ownerDocument && el.ownerDocument.defaultView) || window; }

  function shown(el) {
    try {
      if (el.checkVisibility) return el.checkVisibility({ checkOpacity: false, checkVisibilityCSS: true });
      var cs = viewOf(el).getComputedStyle(el);
      return cs.display !== 'none' && cs.visibility !== 'hidden';
    } catch (e) { return true; }
  }
  function sized(el) {
    var r = el.getBoundingClientRect();
    return r.width >= 1 && r.height >= 1;
  }

  function textOfIds(el, attr) {
    var ids = (el.getAttribute(attr) || '').split(/\s+/).filter(Boolean);
    var doc = el.ownerDocument;
    return clean(ids.map(function (id) { var t = doc.getElementById(id); return t ? t.textContent : ''; }).join(' '));
  }
  function ownText(el) {
    var t = clean(el.innerText != null ? el.innerText : el.textContent);
    if (t) return t;
    var img = el.querySelector && el.querySelector('img[alt]');
    if (img && clean(img.alt)) return clean(img.alt);
    var titled = el.querySelector && el.querySelector('svg title');
    return titled ? clean(titled.textContent) : '';
  }
  /** The words of a label, without what is typed or chosen in the fields it wraps. */
  function wordsOf(node) {
    if (node.nodeType === 3) return node.nodeValue || '';
    if (node.nodeType !== 1) return '';
    if (/^(SELECT|TEXTAREA|INPUT|BUTTON|SCRIPT|STYLE)$/.test(node.tagName)) return '';
    var out = '';
    for (var i = 0; i < node.childNodes.length; i++) out += wordsOf(node.childNodes[i]) + ' ';
    return out;
  }
  /** What a person would call the element. */
  function labelOf(el) {
    var aria = clean(el.getAttribute('aria-label')) || textOfIds(el, 'aria-labelledby');
    var tag = el.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || el.isContentEditable) {
      var type = (el.getAttribute('type') || '').toLowerCase();
      if (tag === 'INPUT' && /^(button|submit|reset)$/.test(type)) return aria || clean(el.value) || clean(el.title) || type;
      if (tag === 'INPUT' && type === 'image') return aria || clean(el.alt) || clean(el.title) || 'image';
      if (aria) return aria;
      var labels = el.labels;
      if (labels && labels.length) {
        var parts = [];
        for (var i = 0; i < labels.length; i++) parts.push(wordsOf(labels[i]));
        var joined = clean(parts.join(' '));
        if (joined) return joined;
      }
      return clean(el.getAttribute('placeholder')) || clean(el.title) || clean(el.getAttribute('name')) || clean(el.id);
    }
    return aria || ownText(el) || clean(el.title) || clean(el.getAttribute('value')) || clean(el.getAttribute('name'));
  }

  function linkTarget(el) {
    var href = el.getAttribute('href') || '';
    if (!href || href.charAt(0) === '#' || /^javascript:/i.test(href)) return '';
    try {
      var u = new URL(href, el.ownerDocument.baseURI);
      if (u.protocol !== 'http:' && u.protocol !== 'https:') return cut(href, 60);
      var same = u.origin === location.origin;
      return cut((same ? '' : u.host) + u.pathname + u.search, 90);
    } catch (e) { return ''; }
  }

  /** What kind of thing an element is to someone who acts on the page, or ''. */
  function kindOf(el) {
    var tag = el.tagName;
    var role = (el.getAttribute('role') || '').toLowerCase();
    var type = (el.getAttribute('type') || '').toLowerCase();
    if (tag === 'A' && el.hasAttribute('href')) return 'link';
    if (tag === 'BUTTON' || tag === 'SUMMARY') return 'button';
    if (tag === 'SELECT') return 'select';
    if (tag === 'TEXTAREA') return 'field';
    if (tag === 'INPUT') {
      if (type === 'hidden') return '';
      if (type === 'checkbox') return 'checkbox';
      if (type === 'radio') return 'radio';
      if (type === 'file') return 'upload';
      if (/^(button|submit|reset|image)$/.test(type)) return 'button';
      if (type === 'range' || type === 'color') return 'field';
      return TEXT_TYPES.test(type) ? 'field' : 'field';
    }
    if (role === 'button') return 'button';
    if (role === 'link') return 'link';
    if (role === 'checkbox' || role === 'switch') return 'checkbox';
    if (role === 'radio') return 'radio';
    if (role === 'textbox' || role === 'searchbox' || role === 'combobox') return 'field';
    if (role === 'tab') return 'tab';
    if (role === 'menuitem' || role === 'menuitemcheckbox' || role === 'menuitemradio') return 'menu item';
    if (role === 'option' || role === 'treeitem') return 'option';
    if (el.isContentEditable && !(el.parentElement && el.parentElement.isContentEditable)) return 'field';
    return '';
  }

  function clickable(el, st) {
    if (st.inClickable) return false;
    if (el.hasAttribute('onclick') || el.getAttribute('tabindex') === '0') return true;
    try {
      var cs = viewOf(el).getComputedStyle(el);
      if (cs.cursor !== 'pointer') return false;
      var parent = el.parentElement;
      if (parent && viewOf(parent).getComputedStyle(parent).cursor === 'pointer') return false;
      return true;
    } catch (e) { return false; }
  }

  function fieldWords(el) {
    return [el.getAttribute('name'), el.id, el.getAttribute('placeholder'), el.getAttribute('aria-label'), el.getAttribute('autocomplete')].join(' ').toLowerCase();
  }
  var CODE_WORDS = /(one-time-code|\botp\b|one.?time|verification.?code|verify.?code|security.?code|auth.?code|2fa|two.?factor|mfa|totp|kode.?(otp|verifikasi|keamanan))/;

  function ref(el, st) {
    if (st.refs >= MAX_REFS) return 0;
    st.refs++;
    REFS.set(st.refs, el);
    return st.refs;
  }

  function mark(st, n, words) { st.out.push(' [' + n + ': ' + words + '] '); }

  function field(el, st) {
    var tag = el.tagName;
    var type = (el.getAttribute('type') || (tag === 'TEXTAREA' ? 'text, several lines' : tag === 'INPUT' ? 'text' : 'text')).toLowerCase();
    var label = cut(labelOf(el), 80);
    var words = fieldWords(el);
    var value;
    if (type === 'password') {
      st.signals.passwordFields++;
      value = el.value ? '[hidden]' : '""';
    } else {
      var raw = tag === 'INPUT' || tag === 'TEXTAREA' ? el.value : (el.innerText || el.textContent || '');
      value = quote(cut(raw, 200));
    }
    if (/captcha/.test(words) || /captcha/i.test(label)) st.signals.captchaField = true;
    else if (type !== 'password' && (CODE_WORDS.test(words) || CODE_WORDS.test(label.toLowerCase()))) st.signals.codeField = true;
    var n = ref(el, st);
    if (!n) return;
    mark(st, n, 'field ' + quote(label) + ' (' + type + ')' + (el.disabled ? ' (disabled)' : el.readOnly ? ' (read only)' : '') + ' = ' + value);
  }

  function walk(node, st) {
    if (st.chars > MAX_CHARS) return;
    if (node.nodeType === 3) {
      var t = node.nodeValue;
      if (st.inLabel) return;
      if (t && /\S/.test(t)) {
        var piece = st.pre ? t : t.replace(/\s+/g, ' ');
        st.out.push(piece);
        st.chars += piece.length;
      }
      return;
    }
    if (node.nodeType === 11) { each(node.childNodes, st); return; }
    if (node.nodeType !== 1) return;
    var el = node;
    var tag = el.tagName.toUpperCase();
    if (SKIP.test(tag)) return;
    if (tag === 'SLOT') {
      var assigned = el.assignedNodes ? el.assignedNodes({ flatten: true }) : [];
      each(assigned.length ? assigned : el.childNodes, st);
      return;
    }
    if (!shown(el)) return;

    if (tag === 'IFRAME' || tag === 'FRAME') { frame(el, st); return; }
    if (tag === 'BR') { st.out.push('\n'); return; }
    if (tag === 'HR') { st.out.push('\n---\n'); return; }
    if (tag === 'IMG') {
      var alt = clean(el.getAttribute('alt'));
      if (alt && sized(el)) st.out.push(' (image: ' + cut(alt, 100) + ') ');
      return;
    }

    // What shows that a person is asked for.
    if (el.hasAttribute('data-sitekey') || /(^|\s)(g-recaptcha|h-captcha|cf-turnstile)(\s|$)/.test(el.className && el.className.baseVal == null ? el.className : '')) {
      if ((el.getAttribute('data-size') || '') !== 'invisible' && sized(el)) st.signals.widgets.push(cut(String(el.className) + ' ' + (el.getAttribute('data-callback') || ''), 80));
    }
    if (el.id === 'challenge-form' || el.id === 'cf-challenge-running' || el.id === 'challenge-running' || el.id === 'cf-please-wait') st.signals.checkPage = true;

    var kind = kindOf(el);
    if (kind === 'upload') { st.out.push(' (a file upload ' + quote(cut(labelOf(el), 60)) + ': the browser tool does not upload files) '); return; }
    if (kind) {
      var usable = sized(el) || kind === 'checkbox' || kind === 'radio';
      if (usable) {
        if (kind === 'field') { field(el, st); return; }
        var label = cut(labelOf(el), kind === 'option' ? 60 : 100);
        var off = el.disabled || el.getAttribute('aria-disabled') === 'true' ? ' (disabled)' : '';
        if (kind === 'select') {
          var chosen = el.selectedOptions && el.selectedOptions.length ? clean(el.selectedOptions[0].textContent) : '';
          var names = [];
          for (var i = 0; i < el.options.length && i < 15; i++) names.push(cut(el.options[i].textContent, 40));
          var n1 = ref(el, st);
          if (n1) mark(st, n1, 'select ' + quote(label) + off + ' = ' + quote(cut(chosen, 60)) + '; options: ' + names.join(' | ') + (el.options.length > 15 ? ' | … (' + el.options.length + ' in all)' : ''));
          return;
        }
        if (kind === 'checkbox' || kind === 'radio') {
          var on = el.tagName === 'INPUT' ? el.checked : el.getAttribute('aria-checked') === 'true';
          var n2 = ref(el, st);
          if (n2) mark(st, n2, kind + ' ' + quote(label) + off + ' (' + (on ? (kind === 'radio' ? 'chosen' : 'ticked') : (kind === 'radio' ? 'not chosen' : 'not ticked')) + ')');
          // The text of a label that wraps it is read as text below; one that is its own child is not.
          if (el.tagName !== 'INPUT') return;
          return;
        }
        var n3 = ref(el, st);
        if (n3) {
          var to = kind === 'link' ? linkTarget(el) : '';
          var state = kind === 'tab' && el.getAttribute('aria-selected') === 'true' ? ' (chosen)' : el.getAttribute('aria-expanded') === 'true' ? ' (open)' : '';
          mark(st, n3, kind + ' ' + quote(label) + off + state + (to ? ' → ' + to : ''));
          st.chars += label.length;
        }
        return;
      }
      // Something to act on that takes no room: left out, with what is in it.
      if (kind !== 'link') return;
    }

    var block = BLOCK.test(tag);
    var heading = /^H[1-6]$/.test(tag);
    var wasPre = st.pre;
    var wasClickable = st.inClickable;
    var wasLabel = st.inLabel;
    // The words of a label are the name of its field: they are said once, in the field's mark.
    if (tag === 'LABEL' && el.control && shown(el.control) && kindOf(el.control) !== 'upload') {
      st.inLabel = true;
      if (!within(el.control, el)) { st.inLabel = wasLabel; return; }
    }
    if (tag === 'PRE') st.pre = true;
    if (heading) st.out.push('\n\n' + '######'.slice(0, Number(tag.charAt(1))) + ' ');
    else if (tag === 'LI') st.out.push('\n- ');
    else if (block) st.out.push('\n');
    if (!kind && clickable(el, st) && sized(el)) {
      var n4 = ref(el, st);
      if (n4) { mark(st, n4, 'clickable'); st.inClickable = true; }
    }
    if (el.shadowRoot) each(el.shadowRoot.childNodes, st);
    else each(el.childNodes, st);
    if (tag === 'TD' || tag === 'TH') st.out.push(' | ');
    if (heading) st.out.push('\n');
    else if (block && tag !== 'LI') st.out.push('\n');
    st.pre = wasPre;
    st.inClickable = wasClickable;
    st.inLabel = wasLabel;
  }
  function each(nodes, st) { for (var i = 0; i < nodes.length; i++) walk(nodes[i], st); }

  function frame(el, st) {
    var src = el.getAttribute('src') || '';
    var r = el.getBoundingClientRect();
    if (r.width >= 1 && r.height >= 1) st.signals.frames.push({ src: cut(el.src || src, 300), title: cut(el.getAttribute('title') || '', 80), width: Math.round(r.width), height: Math.round(r.height) });
    var doc = null;
    try { doc = el.contentDocument; } catch (e) { doc = null; }
    if (doc && doc.body && doc.location && doc.location.href !== 'about:blank') {
      st.out.push('\n[a frame of the page]\n');
      walk(doc.body, st);
      st.out.push('\n[end of the frame]\n');
    } else if (r.width >= 40 && r.height >= 20) {
      var host = '';
      try { host = new URL(el.src, location.href).host; } catch (e) {}
      if (host) st.out.push('\n(a frame from ' + host + ': what is in it cannot be read or used here)\n');
    }
  }

  function tidy(parts) {
    return parts.join('')
      .replace(/[ \t\u00a0]+/g, ' ')
      .replace(/ ?\n ?/g, '\n')
      .replace(/\n{3,}/g, '\n\n')
      .replace(/^\s+|\s+$/g, '');
  }

  function snapshot() {
    REFS = new Map();
    var st = { out: [], chars: 0, refs: 0, pre: false, inClickable: false, inLabel: false,
      signals: { frames: [], widgets: [], captchaField: false, codeField: false, checkPage: false, passwordFields: 0 } };
    if (document.body) walk(document.body, st);
    var text = tidy(st.out);
    if (/^(just a moment|attention required|verifying you are human|one moment, please|checking your browser)/i.test(document.title || '')) st.signals.checkPage = true;
    return {
      url: location.href,
      title: clean(document.title),
      text: text.length > MAX_CHARS ? text.slice(0, MAX_CHARS) : text,
      refs: st.refs,
      ready: document.readyState,
      signals: {
        frames: st.signals.frames.slice(0, 40),
        widgets: st.signals.widgets.slice(0, 10),
        captchaField: st.signals.captchaField,
        codeField: st.signals.codeField,
        checkPage: st.signals.checkPage,
        passwordFields: st.signals.passwordFields,
        textLength: text.length
      }
    };
  }

  // ─── Finding what an action is meant for ───────────────────────────────────

  function target(key) { return typeof key === 'number' ? REFS.get(key) : SIGN[key]; }

  /** The parent in the tree as it is shown: out of a shadow root into its host, out of a frame into the frame. */
  function up(node) {
    if (node.parentNode) return node.parentNode.nodeType === 11 && node.parentNode.host ? node.parentNode.host : node.parentNode;
    if (node.nodeType === 9 && node.defaultView && node.defaultView.frameElement) return node.defaultView.frameElement;
    return null;
  }
  function within(inner, outer) {
    for (var n = inner; n; n = up(n)) if (n === outer) return true;
    return false;
  }
  /** Where an element is in the window, through the frames it is in. */
  function place(el) {
    var r = el.getBoundingClientRect();
    var left = r.left, top = r.top;
    var win = viewOf(el);
    while (win && win !== window && win.frameElement) {
      var f = win.frameElement;
      var fr = f.getBoundingClientRect();
      left += fr.left + f.clientLeft;
      top += fr.top + f.clientTop;
      win = viewOf(f);
    }
    return { left: left, top: top, width: r.width, height: r.height };
  }
  /** What is at a point of the window, through frames and shadow roots. */
  function at(x, y) {
    var doc = document, el = null;
    for (var depth = 0; depth < 12; depth++) {
      var found = doc.elementFromPoint(x, y);
      if (!found) break;
      el = found;
      while (el.shadowRoot) {
        var deeper = el.shadowRoot.elementFromPoint(x, y);
        if (!deeper || deeper === el) break;
        el = deeper;
      }
      if (el.tagName === 'IFRAME' || el.tagName === 'FRAME') {
        var inner = null;
        try { inner = el.contentDocument; } catch (e) { inner = null; }
        if (!inner) break;
        var fr = el.getBoundingClientRect();
        x -= fr.left + el.clientLeft;
        y -= fr.top + el.clientTop;
        doc = inner;
        continue;
      }
      break;
    }
    return el;
  }
  function describe(el) {
    if (!el) return 'nothing';
    var n = el, text = '';
    for (var i = 0; i < 4 && n && n.nodeType === 1; i++) {
      text = cut(n.innerText || n.textContent || '', 80);
      if (text) break;
      n = n.parentElement;
    }
    return (el.tagName || '').toLowerCase() + (text ? ' ' + quote(text) : '');
  }

  /** Bring an element into view and say where it is, and whether it can be clicked there. */
  function locate(key) {
    var el = target(key);
    if (!el || !el.isConnected) return { gone: true };
    try { el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' }); } catch (e) { try { el.scrollIntoView(); } catch (e2) {} }
    var kind = kindOf(el);
    var info = { kind: kind, label: cut(labelOf(el), 80), tag: el.tagName.toLowerCase(), type: (el.getAttribute('type') || '').toLowerCase(),
      disabled: !!el.disabled || el.getAttribute('aria-disabled') === 'true', url: location.href };
    var p = place(el);
    if (p.width < 1 || p.height < 1) { info.small = true; return info; }
    var x = Math.min(Math.max(p.left + p.width / 2, 1), window.innerWidth - 2);
    var y = Math.min(Math.max(p.top + p.height / 2, 1), window.innerHeight - 2);
    info.x = x; info.y = y;
    var hit = at(x, y);
    if (hit && (within(hit, el) || within(el, hit) && kindOf(hit) === '' )) info.clear = true;
    else {
      var labels = el.labels;
      var byLabel = false;
      if (hit && labels) for (var i = 0; i < labels.length; i++) if (within(hit, labels[i])) byLabel = true;
      if (byLabel) info.clear = true;
      else info.cover = describe(hit);
    }
    return info;
  }

  function press(key) {
    var el = target(key);
    if (!el || !el.isConnected) return { gone: true };
    el.click();
    return { ok: true };
  }

  /** Put the cursor into a field with everything in it selected, and empty it. */
  function ready(key) {
    var el = target(key);
    if (!el || !el.isConnected) return { gone: true };
    var tag = el.tagName;
    var kind = kindOf(el);
    if (kind !== 'field') return { wrong: kind || tag.toLowerCase() };
    if (el.disabled || el.readOnly) return { fixed: true };
    try { el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' }); } catch (e) {}
    el.focus();
    if (tag === 'INPUT' || tag === 'TEXTAREA') {
      var proto = tag === 'INPUT' ? viewOf(el).HTMLInputElement.prototype : viewOf(el).HTMLTextAreaElement.prototype;
      var setter = Object.getOwnPropertyDescriptor(proto, 'value');
      if (el.value !== '') {
        if (setter && setter.set) setter.set.call(el, ''); else el.value = '';
        el.dispatchEvent(new Event('input', { bubbles: true }));
      }
      try { el.select(); } catch (e) {}
    } else {
      var sel = viewOf(el).getSelection();
      var range = el.ownerDocument.createRange();
      range.selectNodeContents(el);
      sel.removeAllRanges();
      sel.addRange(range);
      try { el.ownerDocument.execCommand('delete'); } catch (e) {}
    }
    var active = el.ownerDocument.activeElement;
    return { ok: true, focused: active === el || within(active, el), password: (el.getAttribute('type') || '').toLowerCase() === 'password', label: cut(labelOf(el), 80), url: location.href };
  }

  function changed(el) {
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  }

  function choose(key, wanted) {
    var el = target(key);
    if (!el || !el.isConnected) return { gone: true };
    if (el.tagName !== 'SELECT') return { wrong: kindOf(el) || el.tagName.toLowerCase() };
    if (el.disabled) return { fixed: true };
    var want = clean(wanted).toLowerCase();
    var options = [];
    for (var i = 0; i < el.options.length; i++) options.push(el.options[i]);
    var found = options.find(function (o) { return clean(o.textContent).toLowerCase() === want; })
      || options.find(function (o) { return String(o.value).toLowerCase() === want; })
      || options.find(function (o) { return want && clean(o.textContent).toLowerCase().indexOf(want) === 0; })
      || options.find(function (o) { return want && clean(o.textContent).toLowerCase().indexOf(want) >= 0; });
    if (!found) return { options: options.slice(0, 40).map(function (o) { return cut(o.textContent, 60); }) };
    if (found.disabled) return { fixed: true };
    el.value = found.value;
    found.selected = true;
    changed(el);
    return { ok: true, chosen: cut(found.textContent, 60), label: cut(labelOf(el), 80), url: location.href };
  }

  // ─── The form one signs in with ────────────────────────────────────────────

  function usable(el) { return shown(el) && sized(el) && !el.disabled && !el.readOnly; }
  function all(root, selector) { var out = []; var list = root.querySelectorAll(selector); for (var i = 0; i < list.length; i++) out.push(list[i]); return out; }
  var NAME_WORDS = /(user|email|e-mail|login|identifier|account|akun|pengguna|surel|phone|telepon|nomor|\bid\b)/;
  var SIGN_WORDS = /(log.?in|sign.?in|masuk|auth|account|akun|session|sso)/i;
  var GO_WORDS = /(log.?in|sign.?in|masuk|continue|next|lanjut|berikut|submit|kirim)/i;

  function nameField(root, before) {
    var fields = all(root, 'input').filter(function (el) {
      var type = (el.getAttribute('type') || 'text').toLowerCase();
      if (!/^(text|email|tel|)$/.test(type)) return false;
      if (!usable(el)) return false;
      var words = fieldWords(el);
      if (/search|captcha|\bq\b/.test(words) || CODE_WORDS.test(words)) return false;
      return true;
    });
    if (before) {
      var earlier = fields.filter(function (el) { return el.compareDocumentPosition(before) & 4; });
      if (earlier.length) return earlier[earlier.length - 1];
      return null;
    }
    var named = fields.filter(function (el) {
      var type = (el.getAttribute('type') || '').toLowerCase();
      return type === 'email' || NAME_WORDS.test(fieldWords(el)) || NAME_WORDS.test(labelOf(el).toLowerCase());
    });
    return named.length ? named[0] : null;
  }
  function goButton(root) {
    var buttons = all(root, 'button, input[type=submit], input[type=image], [role=button]').filter(function (el) {
      if (!shown(el) || !sized(el) || el.disabled) return false;
      var type = (el.getAttribute('type') || '').toLowerCase();
      return type !== 'button' || el.tagName !== 'INPUT';
    });
    var worded = buttons.filter(function (el) { return GO_WORDS.test(labelOf(el)); });
    var submits = buttons.filter(function (el) { var type = (el.getAttribute('type') || '').toLowerCase(); return type === 'submit' || type === 'image' || (el.tagName === 'BUTTON' && !type); });
    return worded.filter(function (el) { return submits.indexOf(el) >= 0; })[0] || worded[0] || submits[0] || null;
  }

  /** The fields to sign in with, as far as the page shows them now. */
  function signIn() {
    SIGN = {};
    var passwords = all(document, 'input[type=password]').filter(usable);
    var looks = SIGN_WORDS.test(location.pathname + ' ' + document.title);
    var result = { url: location.href, passwords: passwords.length, user: false, pass: false, go: false, looks: looks };
    if (passwords.length > 2) return result;
    if (passwords.length >= 1) {
      // Two password fields are a form that makes an account or changes a password, unless it says that it signs in.
      if (passwords.length === 2 && !looks) return result;
      var pass = passwords[0];
      var form = pass.form || document;
      SIGN.pass = pass;
      result.pass = true;
      var user = nameField(form, pass) || (form !== document ? nameField(document, pass) : null);
      if (user) { SIGN.user = user; result.user = true; result.userHeld = user.value.length; }
      var go = goButton(form);
      if (go) { SIGN.go = go; result.go = true; }
      return result;
    }
    // The name first, the password on the next page.
    var forms = all(document, 'form');
    var roots = forms.length ? forms : [document];
    for (var i = 0; i < roots.length; i++) {
      var root = roots[i];
      var name = nameField(root, null);
      if (!name) continue;
      var button = goButton(root);
      var says = looks || SIGN_WORDS.test((root.getAttribute && (root.getAttribute('action') || '') + ' ' + (root.id || '') + ' ' + (root.className || '')) || '') || (button && /(log.?in|sign.?in|masuk)/i.test(labelOf(button)));
      if (!says) continue;
      SIGN.user = name;
      result.user = true;
      result.userHeld = name.value.length;
      if (button) { SIGN.go = button; result.go = true; }
      return result;
    }
    return result;
  }

  globalThis.__xn = {
    snapshot: snapshot,
    locate: locate,
    press: press,
    ready: ready,
    choose: choose,
    signIn: signIn,
    quiet: function () { return { since: Date.now() - lastChange, ready: document.readyState, url: location.href }; }
  };
})();
`;

/** The call of one of the script's functions, as it is sent to the browser: the script first, where the page has not got it yet. */
export function pageCall(name: string, args: readonly unknown[] = []): string {
  return `${PAGE_SCRIPT}\n__xn.${name}(${args.map((arg) => JSON.stringify(arg)).join(", ")})`;
}
