// lib/extract.js
//
// 页面内容提取 + 真人验证/登录页启发式判定（对应契约 §6）。
// 只做“读取页面信息”，不点击、不填表、不修改页面 DOM。
// 挑战判定“宁严勿滥”：结构信号（可见验证码元素等）优先，文本信号兜底。

/** 折叠空白并截断。 */
export function normalizeText(text, maxChars = 20000) {
  let result = String(text === undefined || text === null ? '' : text)
  result = result.replace(/\u00a0/g, ' ')
  result = result.replace(/\s+/g, ' ').trim()
  const limit =
    Number.isFinite(maxChars) && maxChars > 0 ? Math.max(1, Math.floor(maxChars)) : 20000
  if (result.length > limit) result = result.slice(0, limit)
  return result
}

// captcha 文本信号（契约 §6 的固定列表；正文已折叠为单行）。
const CAPTCHA_TEXT_PATTERN =
  /验证码|人机验证|真人验证|安全验证|拖动.*滑块|verify you are human|are you a robot|complete the captcha|checking your browser/i
// 2FA 文本信号
const TWO_FA_TEXT_PATTERN =
  /二次验证|两步验证|two-factor|two factor|verification code|authenticator/i
// 登录文本信号
const LOGIN_TEXT_PATTERN = /登录|登入|sign\s*in|log\s*in|login/i

// 页面内执行：收集结构信号 + 文本 + 链接。函数会被序列化注入页面，必须自包含。
function inspectPageInBrowser(args) {
  const options = args || {}
  const maxChars = Number.isFinite(options.maxChars) ? options.maxChars : 20000
  const maxLinks = Number.isFinite(options.maxLinks) ? options.maxLinks : 40

  const CAPTCHA_SELECTORS = [
    'iframe[src*="recaptcha" i]',
    'iframe[src*="hcaptcha" i]',
    'iframe[src*="turnstile" i]',
    'iframe[src*="challenges.cloudflare.com" i]',
    '.g-recaptcha',
    '.h-captcha',
    '.cf-turnstile',
    '#captcha',
    '[class*="captcha" i]',
    'input[name*="captcha" i]',
    '#challenge-running',
    '#cf-challenge-running',
    '#challenge-form',
    '[id^="cf-challenge-"]',
  ]
  const TWO_FA_SELECTORS = [
    'input[autocomplete="one-time-code" i]',
    'input[name*="otp" i]',
    'input[name*="verification code" i]',
  ]

  function isVisible(element) {
    try {
      if (!element || !element.isConnected) return false
      if (element.closest('[hidden]')) return false
      const style = window.getComputedStyle(element)
      if (!style) return false
      if (style.display === 'none' || style.visibility === 'hidden' || style.visibility === 'collapse') {
        return false
      }
      const opacity = Number(style.opacity)
      if (Number.isFinite(opacity) && opacity === 0) return false
      const rect = element.getBoundingClientRect()
      if (rect.width < 1 || rect.height < 1) return false
      return true
    } catch {
      return false
    }
  }

  function firstVisible(selectors) {
    for (const selector of selectors) {
      let nodes = []
      try {
        nodes = document.querySelectorAll(selector)
      } catch {
        continue
      }
      for (const node of nodes) {
        if (isVisible(node)) return { selector, node }
      }
    }
    return null
  }

  const title = String(document.title || '')
  const url = String(location.href || '')

  const captchaHit = firstVisible(CAPTCHA_SELECTORS)
  const twoFaHit = firstVisible(TWO_FA_SELECTORS)

  let hasPasswordField = false
  try {
    for (const input of document.querySelectorAll('input[type="password"]')) {
      if (isVisible(input)) {
        hasPasswordField = true
        break
      }
    }
  } catch {
    /* ignore */
  }

  let hasLoginForm = hasPasswordField
  if (!hasLoginForm) {
    try {
      for (const form of document.querySelectorAll('form')) {
        if (!isVisible(form)) continue
        const hasUserField = !!form.querySelector(
          'input[type="email"], input[type="text"], input[name*="user" i], input[autocomplete*="username" i]',
        )
        const hasSubmit = !!form.querySelector('button[type="submit"], input[type="submit"], button')
        if (hasUserField && hasSubmit) {
          hasLoginForm = true
          break
        }
      }
    } catch {
      /* ignore */
    }
  }

  let textRaw = ''
  if (document.body) {
    try {
      textRaw = String(document.body.innerText || '')
    } catch {
      textRaw = String(document.body.textContent || '')
    }
  }
  const textCap = Math.max(1000, Math.min(Math.max(1, maxChars) * 4, 120000))
  if (textRaw.length > textCap) textRaw = textRaw.slice(0, textCap)

  // header/nav/footer/aside 的文字块单独收集，宿主侧从正文里剔除（不修改页面 DOM）。
  const excludedTexts = []
  try {
    for (const node of document.querySelectorAll('nav, footer, aside, header')) {
      let chunk = ''
      try {
        chunk = String(node.innerText || '')
      } catch {
        /* ignore */
      }
      chunk = chunk.replace(/\s+/g, ' ').trim()
      if (chunk.length >= 24) excludedTexts.push(chunk)
    }
  } catch {
    /* ignore */
  }

  const links = []
  if (maxLinks > 0) {
    const seen = new Set()
    try {
      for (const anchor of document.querySelectorAll('a[href]')) {
        if (links.length >= maxLinks) break
        let absolute = ''
        try {
          absolute = new URL(anchor.getAttribute('href') || '', location.href).href
        } catch {
          continue
        }
        if (!/^https?:/i.test(absolute)) continue
        let text = ''
        try {
          text = String(anchor.innerText || anchor.textContent || '')
        } catch {
          /* ignore */
        }
        text = text.replace(/\s+/g, ' ').trim()
        if (!text) continue
        if (seen.has(absolute)) continue
        seen.add(absolute)
        links.push({ text: text.slice(0, 300), url: absolute })
      }
    } catch {
      /* ignore */
    }
  }

  return {
    url,
    title,
    textRaw,
    excludedTexts,
    links,
    captchaSelector: captchaHit ? captchaHit.selector : '',
    twoFaSelector: twoFaHit ? twoFaHit.selector : '',
    hasPasswordField,
    hasLoginForm,
  }
}

function removeExcludedText(text, excludedTexts) {
  let result = String(text || '')
  for (const chunk of excludedTexts || []) {
    if (!chunk || chunk.length < 16) continue
    if (result.indexOf(chunk) !== -1) result = result.split(chunk).join(' ')
  }
  return result
}

function classifyChallenge(raw, text) {
  const haystack = `${raw.title || ''}\n${text || ''}`
  // 1. captcha
  if (raw.captchaSelector) {
    return { kind: 'captcha', evidence: `检测到可见验证码元素：${raw.captchaSelector}` }
  }
  const captchaMatch = haystack.match(CAPTCHA_TEXT_PATTERN)
  if (captchaMatch) {
    return { kind: 'captcha', evidence: `页面文本命中验证码关键词：“${captchaMatch[0]}”` }
  }
  // 2. 2FA
  if (raw.twoFaSelector) {
    return { kind: '2fa', evidence: `检测到可见一次性验证码输入框：${raw.twoFaSelector}` }
  }
  const twoFaMatch = haystack.match(TWO_FA_TEXT_PATTERN)
  if (twoFaMatch) {
    return { kind: '2fa', evidence: `页面文本命中二次验证关键词：“${twoFaMatch[0]}”` }
  }
  // 3. login
  if (raw.hasPasswordField && LOGIN_TEXT_PATTERN.test(haystack)) {
    return { kind: 'login', evidence: '页面包含可见密码输入框且出现登录相关文案' }
  }
  return { kind: 'none', evidence: '' }
}

/**
 * 读取页面信息。
 * @returns {Promise<{url:string,title:string,text:string,links:{text,url}[],hasPasswordField:boolean,hasLoginForm:boolean,challenge:{kind,evidence}}>}
 */
export async function readPage(page, options = {}) {
  const maxChars =
    Number.isFinite(options.maxChars) && options.maxChars > 0 ? Math.floor(options.maxChars) : 20000
  const maxLinks =
    Number.isFinite(options.maxLinks) && options.maxLinks > 0 ? Math.floor(options.maxLinks) : 40
  const raw = await page.evaluate(inspectPageInBrowser, { maxChars, maxLinks })
  if (!raw || typeof raw !== 'object') throw new Error('读取页面失败：页面脚本返回了空结果。')
  const cleanText = removeExcludedText(raw.textRaw, raw.excludedTexts)
  const text = normalizeText(cleanText, maxChars)
  const challenge = classifyChallenge(raw, text)
  return {
    url: raw.url || '',
    title: raw.title || '',
    text,
    links: Array.isArray(raw.links) ? raw.links.slice(0, maxLinks).filter((item) => item && item.url) : [],
    hasPasswordField: !!raw.hasPasswordField,
    hasLoginForm: !!raw.hasLoginForm,
    challenge,
  }
}

/**
 * 只判定真人验证/登录状态，不返回正文（比 readPage 轻）。
 * @returns {Promise<{kind:'none'|'captcha'|'2fa'|'login', evidence:string}>}
 */
export async function detectChallenge(page) {
  const raw = await page.evaluate(inspectPageInBrowser, { maxChars: 3000, maxLinks: 0 })
  if (!raw || typeof raw !== 'object') throw new Error('检测页面状态失败：页面脚本返回了空结果。')
  const cleanText = removeExcludedText(raw.textRaw, raw.excludedTexts)
  const text = normalizeText(cleanText, 4000)
  return classifyChallenge(raw, text)
}
