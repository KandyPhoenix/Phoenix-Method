/* ============================================
   PHOENIX METHOD — SHARED NAV + FOOTER JS
   Edit this file to update ALL pages at once.
   ============================================ */

(function () {
  var NAV_HTML = `<nav class="nav" id="nav">
    <div class="nav-inner">
      <a href="https://phoenixmethodseo.com/" class="nav-logo" aria-label="Phoenix Home">
        <img src="https://phoenixmethodseo.com/assets/phoenix-full-logo.png" alt="Phoenix Method - Search. Rise. Dominate." class="nav-logo-img" width="1077" height="502" fetchpriority="high">
      </a>
      <button class="nav-toggle" id="navToggle" aria-label="Toggle menu">
        <span></span><span></span><span></span>
      </button>
      <ul class="nav-links" id="navLinks">
        <li class="nav-dropdown">
          <a href="/small-business-seo/">Services</a>
          <ul class="nav-dropdown-menu">
            <li><a href="/small-business-seo/"><strong>Small Business SEO</strong></a></li>
            <li><a href="/services/local-seo/">Local SEO</a></li>
            <li><a href="/services/technical-seo/">Technical SEO</a></li>
            <li><a href="/services/content-seo/">Content SEO</a></li>
            <li><a href="/services/gbp-optimization/">GBP Optimization</a></li>
            <li><a href="/services/ai-overview-optimization/">AI Overview Optimization</a></li>
          </ul>
        </li>
        <li class="nav-dropdown">
          <a href="/industries/">Industries</a>
          <ul class="nav-dropdown-menu">
            <li><a href="/industries/"><strong>All Industries</strong></a></li>
            <li><a href="/industries/healthcare-seo/">Healthcare SEO</a></li>
            <li><a href="/industries/mental-health-seo/">Mental Health SEO</a></li>
            <li><a href="/industries/dental-seo/">Dental SEO</a></li>
            <li><a href="/industries/agriculture-seo/">Agriculture SEO</a></li>
            <li><a href="/industries/oil-gas-seo/">Oil &amp; Gas SEO</a></li>
          </ul>
        </li>
        <li><a href="/about/">About</a></li>
        <li class="nav-dropdown dropdown-right">
          <a href="/small-business-seo-pricing/">Investment</a>
          <ul class="nav-dropdown-menu">
            <li><a href="/small-business-seo-pricing/"><strong>Pricing Overview</strong></a></li>
            <li><a href="/plans/spark/">Spark — $500/mo</a></li>
            <li><a href="/plans/blaze/">Blaze — $900/mo</a></li>
            <li><a href="/plans/inferno/">Inferno — $1,500/mo</a></li>
          </ul>
        </li>
        <li class="nav-dropdown">
          <a href="/order.html">Shop</a>
          <ul class="nav-dropdown-menu">
            <li><a href="/order.html"><strong>All Offerings</strong></a></li>
            <li><a href="/order.html#content-packs">Content Packs</a></li>
            <li><a href="/order.html#fixed-price">Fixed-Price Services</a></li>
            <li><a href="/order.html#scoped">Scoped Services</a></li>
          </ul>
        </li>
        <li><a href="/blog/">Blog</a></li>
        <li><a href="/#faq">FAQ</a></li>
        <li><a href="/contact/" class="nav-cta">Contact</a></li>
      </ul>
    </div>
  </nav>`;

  var FOOTER_HTML = `<footer class="footer">
    <div class="container">
      <div class="footer-inner">
        <div class="footer-brand">
          <p class="footer-tagline">Data-driven SEO &amp; SEM<br>consulting.<br>Your rankings. Our fire.</p>
        </div>
        <div class="footer-links">
          <div class="footer-col">
            <h4>Services</h4>
            <a href="/small-business-seo/">Small Business SEO</a>
            <a href="/services/local-seo/">Local SEO</a>
            <a href="/services/technical-seo/">Technical SEO</a>
            <a href="/services/content-seo/">Content SEO</a>
            <a href="/services/gbp-optimization/">GBP Optimization</a>
            <a href="/services/ai-overview-optimization/">AI Overview Optimization</a>
          </div>
          <div class="footer-col">
            <h4>Industries</h4>
            <a href="/industries/">All Industries</a>
            <a href="/industries/healthcare-seo/">Healthcare SEO</a>
            <a href="/industries/mental-health-seo/">Mental Health SEO</a>
            <a href="/industries/dental-seo/">Dental SEO</a>
            <a href="/industries/agriculture-seo/">Agriculture SEO</a>
            <a href="/industries/oil-gas-seo/">Oil &amp; Gas SEO</a>
          </div>
          <div class="footer-col">
            <h4>Company</h4>
            <a href="/about/">About</a>
            <a href="/#process">Our Process</a>
            <a href="/small-business-seo-pricing/">Pricing</a>
            <a href="/order.html">Shop</a>
            <a href="/#faq">FAQ</a>
            <a href="/blog/">Blog</a>
          </div>
          <div class="footer-col">
            <h4>Contact</h4>
            <a href="mailto:hello@phoenixmethodseo.com">Quick Email &rarr;</a>
            <a href="/contact/">Contact Us &rarr;</a>
            <a href="/services/seo-development/" style="align-self: flex-start; margin-top: 8px;">Custom Project &rarr;</a>
            <a href="/portal/" style="align-self: flex-start; margin-top: 8px;">Client Portal &rarr;</a>
          </div>
        </div>
      </div>
      <div class="footer-bottom">
        <p>&copy; 2026 Phoenix Method. All rights reserved.</p>
      </div>
    </div>
  </footer>`;

  document.addEventListener('DOMContentLoaded', function () {
    // Inject nav
    var navEl = document.getElementById('pm-nav');
    if (navEl) navEl.outerHTML = NAV_HTML;

    // Inject footer
    var footerEl = document.getElementById('pm-footer');
    if (footerEl) footerEl.outerHTML = FOOTER_HTML;

    // Wire up mobile toggle (nav was just injected)
    var nav = document.getElementById('nav');
    var navToggle = document.getElementById('navToggle');
    var navLinks = document.getElementById('navLinks');

    if (nav) {
      window.addEventListener('scroll', function () {
        nav.classList.toggle('scrolled', window.scrollY > 60);
      }, { passive: true });
    }

    if (navToggle && navLinks) {
      navToggle.addEventListener('click', function () {
        navLinks.classList.toggle('open');
      });
      navLinks.querySelectorAll('a').forEach(function (link) {
        link.addEventListener('click', function () {
          navLinks.classList.remove('open');
        });
      });
    }
  });
})();
