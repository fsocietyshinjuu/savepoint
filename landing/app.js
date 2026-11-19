const THEME_KEY = 'savepoint-theme';

const root = document.documentElement;
const nav = document.getElementById('nav');
const themeToggle = document.getElementById('themeToggle');
const themeIcon = themeToggle ? themeToggle.querySelector('.theme-icon') : null;

/* ---------- theme ---------- */

function systemTheme() {
  return window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
}

function storedTheme() {
  try {
    const value = localStorage.getItem(THEME_KEY);
    return value === 'light' || value === 'dark' ? value : null;
  } catch {
    return null;
  }
}

function applyTheme(theme, persist = true) {
  root.dataset.theme = theme;
  if (themeIcon) themeIcon.textContent = theme === 'dark' ? '☾' : '☀';
  if (themeToggle) themeToggle.setAttribute('aria-label', theme === 'dark' ? 'Switch to light theme' : 'Switch to dark theme');
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.setAttribute('content', theme === 'dark' ? '#080a07' : '#f3f1e8');
  if (persist) {
    try { localStorage.setItem(THEME_KEY, theme); } catch { /* private mode */ }
  }
}

applyTheme(storedTheme() || systemTheme(), false);

themeToggle?.addEventListener('click', () => {
  applyTheme(root.dataset.theme === 'dark' ? 'light' : 'dark');
});

window.matchMedia('(prefers-color-scheme: light)').addEventListener('change', () => {
  if (!storedTheme()) applyTheme(systemTheme(), false);
});

/* ---------- screenshot theme switch ---------- */

const shotButtons = [...document.querySelectorAll('[data-shot]')];
const shots = [...document.querySelectorAll('[data-shot-img]')];

function showShot(name) {
  for (const button of shotButtons) {
    const active = button.dataset.shot === name;
    button.classList.toggle('is-active', active);
    button.setAttribute('aria-pressed', String(active));
  }
  for (const image of shots) {
    image.classList.toggle('is-active', image.dataset.shotImg === name);
  }
}

for (const button of shotButtons) {
  button.addEventListener('click', () => showShot(button.dataset.shot));
}

/* the light screenshot is hidden on load, so lazy loading would leave it blank
   for a beat on first switch — warm it once the page has finished loading */
function warmLightShot() {
  const image = new Image();
  image.src = './assets/app-light.png';
}

if (document.readyState === 'complete') {
  warmLightShot();
} else {
  window.addEventListener('load', warmLightShot, { once: true });
}

/* ---------- nav ---------- */

let lastScrolled = null;
function syncNav() {
  const scrolled = window.scrollY > 10;
  if (scrolled === lastScrolled) return;
  lastScrolled = scrolled;
  nav?.classList.toggle('is-scrolled', scrolled);
}

syncNav();
window.addEventListener('scroll', syncNav, { passive: true });

/* ---------- reveal on scroll ---------- */

const prefersReduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
const revealables = [
  ...document.querySelectorAll('.section-head, .card, .steps li, .split-copy, .spec-card, .faq details, .cta-inner, .hero-facts'),
];

if (!prefersReduced && 'IntersectionObserver' in window) {
  const observer = new IntersectionObserver((entries) => {
    for (const entry of entries) {
      if (!entry.isIntersecting) continue;
      entry.target.classList.add('in');
      observer.unobserve(entry.target);
    }
  }, { rootMargin: '0px 0px -8% 0px', threshold: 0.08 });

  for (const element of revealables) {
    element.classList.add('reveal');
    observer.observe(element);
  }
}

/* ---------- hero pointer glow ---------- */

const hero = document.querySelector('.hero');
if (hero && !prefersReduced && window.matchMedia('(hover: hover) and (pointer: fine)').matches) {
  let frame = 0;
  hero.addEventListener('pointermove', (event) => {
    if (frame) return;
    frame = requestAnimationFrame(() => {
      frame = 0;
      const rect = hero.getBoundingClientRect();
      const x = ((event.clientX - rect.left) / rect.width) * 100;
      const y = ((event.clientY - rect.top) / rect.height) * 100;
      hero.style.setProperty('--mx', `${Math.max(0, Math.min(100, x))}%`);
      hero.style.setProperty('--my', `${Math.max(0, Math.min(100, y))}%`);
    });
  }, { passive: true });
}

/* ---------- download links follow the latest release ---------- */

const REPO = 'fsocietyshinjuu/savepoint';
for (const link of document.querySelectorAll('#heroDownload, #navDownload, #footerDownload')) {
  link.href = `https://github.com/${REPO}/releases/latest`;
}
for (const link of document.querySelectorAll('#sourceLink')) {
  link.href = `https://github.com/${REPO}`;
}
