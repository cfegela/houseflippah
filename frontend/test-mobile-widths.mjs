import { spawn } from 'node:child_process';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';

async function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function startStaticServer(dir, port) {
  const mimeTypes = {
    '.html': 'text/html',
    '.js': 'text/javascript',
    '.css': 'text/css',
    '.svg': 'image/svg+xml'
  };

  const server = http.createServer((req, res) => {
    let filePath = path.join(dir, req.url === '/' ? 'index.html' : req.url);
    if (!fs.existsSync(filePath)) {
      filePath = path.join(dir, 'index.html');
    }
    const ext = path.extname(filePath);
    const contentType = mimeTypes[ext] || 'application/octet-stream';

    try {
      const data = fs.readFileSync(filePath);
      res.writeHead(200, { 'Content-Type': contentType });
      res.end(data);
    } catch (e) {
      res.writeHead(500);
      res.end('Error loading ' + req.url);
    }
  });

  return new Promise((resolve) => {
    server.listen(port, '127.0.0.1', () => resolve(server));
  });
}

async function getDebuggerUrl() {
  for (let i = 0; i < 30; i++) {
    try {
      const res = await fetch('http://127.0.0.1:9222/json');
      const data = await res.json();
      if (data && data[0] && data[0].webSocketDebuggerUrl) {
        return data[0].webSocketDebuggerUrl;
      }
    } catch (e) {
      // wait and retry
    }
    await wait(200);
  }
  throw new Error('Chrome remote debugger not responding');
}

async function run() {
  const PORT = 5199;
  const staticServer = await startStaticServer(path.resolve('dist'), PORT);
  console.log(`✓ Local static test server listening on http://127.0.0.1:${PORT}`);

  const testUrl = `http://127.0.0.1:${PORT}`;
  console.log('🚀 Launching Chrome Headless at 375x812 (iPhone SE)...');
  const chrome = spawn(
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    [
      '--headless=new',
      '--remote-debugging-port=9222',
      '--window-size=375,812',
      '--disable-gpu',
      '--no-sandbox',
      testUrl
    ],
    { stdio: 'ignore' }
  );

  try {
    const wsUrl = await getDebuggerUrl();
    console.log('✓ Connected to Chrome CDP:', wsUrl);

    const ws = new WebSocket(wsUrl);
    await new Promise((resolve) => ws.onopen = resolve);

    let msgId = 1;
    function send(method, params = {}) {
      return new Promise((resolve, reject) => {
        const id = msgId++;
        const handler = (evt) => {
          const msg = JSON.parse(evt.data);
          if (msg.id === id) {
            ws.removeEventListener('message', handler);
            if (msg.error) reject(msg.error);
            else resolve(msg.result);
          }
        };
        ws.addEventListener('message', handler);
        ws.send(JSON.stringify({ id, method, params }));
      });
    }

    await send('Page.enable');
    await send('Page.navigate', { url: testUrl });
    await wait(1000);

    await send('Emulation.setDeviceMetricsOverride', {
      width: 375,
      height: 812,
      deviceScaleFactor: 2,
      mobile: true,
      fitWindow: false
    });

    await wait(500);

    // Evaluate viewport measurements across different views
    const testCases = [
      {
        name: 'Initial Home/Auth View',
        setupJs: '/* default */'
      },
      {
        name: 'Lobby View (3-button actions row)',
        setupJs: `
          document.getElementById('home-view').classList.add('hidden');
          document.getElementById('lobby-view').classList.remove('hidden');
          document.getElementById('host-invite-controls').classList.remove('hidden');
          document.getElementById('btn-start-game').classList.remove('hidden');
        `
      },
      {
        name: 'Game Dashboard View (HUD + 6 Hub Cards)',
        setupJs: `
          document.getElementById('lobby-view').classList.add('hidden');
          document.getElementById('game-view').classList.remove('hidden');
          document.getElementById('game-dashboard-view').classList.remove('hidden');
        `
      },
      {
        name: 'Purchase Confirmation Modal (50/50 Button Row)',
        setupJs: `
          document.getElementById('purchase-confirm-modal').classList.remove('hidden');
        `
      },
      {
        name: 'End Game Confirmation Modal (50/50 Button Row)',
        setupJs: `
          document.getElementById('purchase-confirm-modal').classList.add('hidden');
          document.getElementById('end-game-modal').classList.remove('hidden');
        `
      },
      {
        name: 'Improvement Modal (3-col metrics + items)',
        setupJs: `
          document.getElementById('end-game-modal').classList.add('hidden');
          document.getElementById('improve-property-modal').classList.remove('hidden');
        `
      },
      {
        name: 'Delinquency Alert Modal (Turn Start Warning)',
        setupJs: `
          document.getElementById('improve-property-modal').classList.add('hidden');
          document.getElementById('delinquency-alert-modal').classList.remove('hidden');
          document.getElementById('modal-delinquency-content').innerHTML = \`
            <div style="background: rgba(239, 68, 68, 0.12); border: 1px solid rgba(239, 68, 68, 0.4); border-radius: 8px; padding: 0.85rem 1rem; margin-bottom: 0.5rem;">
              <div style="font-size: 1.05rem; font-weight: 800; color: #f87171; margin-bottom: 0.25rem;">
                ⚠️ Foreclosure Threat
              </div>
              <div style="font-size: 0.85rem; color: var(--text-muted); line-height: 1.45;">
                You missed a mortgage payment last round. To prevent losing your investment, go to Make Payments to make a payment.
              </div>
            </div>
            <div class="delinquency-alert-item">
              <div class="delinquency-alert-header">
                <span class="delinquency-alert-prop-name">
                  <span class="delinquency-alert-dot" style="background-color: #8B5A2B;"></span>
                  Mediterranean Avenue
                </span>
                <span class="delinquency-alert-badge">Delinquent</span>
              </div>
              <div class="delinquency-alert-details">
                <div class="delinquency-alert-breakdown">
                  <span>Payment to Stave Off:</span>
                  <strong style="color: #f87171; font-weight: 700;">$1,500</strong>
                </div>
                <div class="delinquency-alert-breakdown">
                  <span>Remaining Mortgage Balance:</span>
                  <strong style="color: var(--text-main); font-weight: 600;">$54,000</strong>
                </div>
              </div>
            </div>
          \`;
        `
      },
      {
        name: 'Property Details View (Back + Buy side-by-side)',
        setupJs: `
          document.getElementById('delinquency-alert-modal').classList.add('hidden');
          document.getElementById('game-dashboard-view').classList.add('hidden');
          document.getElementById('game-property-details-view').classList.remove('hidden');
          document.getElementById('property-details-container').innerHTML = \`
            <div class="property-detail-card">
              <div class="property-detail-hero"></div>
              <div class="property-detail-body">
                <div class="property-detail-grid">
                  <div class="property-detail-stat"><span class="property-detail-stat-val">100k</span></div>
                  <div class="property-detail-stat"><span class="property-detail-stat-val">10k</span></div>
                </div>
              </div>
              <div class="property-detail-actions">
                <button class="btn-detail-back">← Market</button>
                <button class="btn-detail-buy">Buy for $10,000</button>
              </div>
            </div>
          \`;
        `
      },
      {
        name: 'Sell Property View (5-tile grid with Flipstimate)',
        setupJs: `
          document.getElementById('game-property-details-view').classList.add('hidden');
          document.getElementById('game-sell-properties-view').classList.remove('hidden');
          document.getElementById('sell-properties-container').innerHTML = \`
            <div class="property-detail-card">
              <div class="property-detail-stripe" style="background-color: #8B5A2B;"></div>
              <div class="property-detail-body">
                <div class="property-detail-header-row">
                  <div class="property-detail-title-group"><h3 style="margin: 0;">Mediterranean Avenue</h3></div>
                </div>
                <div class="property-detail-grid">
                  <div class="property-detail-stat">
                    <span class="property-detail-stat-label">Asking Price</span>
                    <span class="property-detail-stat-val" style="color: #38bdf8; font-weight: 800;">$120,000</span>
                  </div>
                  <div class="property-detail-stat">
                    <span class="property-detail-stat-label">Flipstimate</span>
                    <span class="property-detail-stat-val">30%</span>
                  </div>
                  <div class="property-detail-stat">
                    <span class="property-detail-stat-label">Market Value</span>
                    <span class="property-detail-stat-val" style="color: #22c55e;">$120,000</span>
                  </div>
                  <div class="property-detail-stat">
                    <span class="property-detail-stat-label">Purchase Price</span>
                    <span class="property-detail-stat-val">$60,000</span>
                  </div>
                  <div class="property-detail-stat">
                    <span class="property-detail-stat-label">Mortgage / Round</span>
                    <span class="property-detail-stat-val" style="color: #38bdf8;">$1,500</span>
                  </div>
                </div>
              </div>
              <div class="property-detail-actions" style="justify-content: flex-end;">
                <div>
                  <button class="btn-detail-buy btn-delist-property" style="background: rgba(239, 68, 68, 0.15); border: 1px solid rgba(239, 68, 68, 0.4); color: #f87171;">
                    Delist Property
                  </button>
                </div>
              </div>
            </div>
          \`;
        `
      },
      {
        name: 'Make Payments View (Single + Double Pay side-by-side)',
        setupJs: `
          document.getElementById('game-sell-properties-view').classList.add('hidden');
          document.getElementById('game-make-payments-view').classList.remove('hidden');
          document.getElementById('mortgage-payments-container').innerHTML = \`
            <div class="mortgage-card is-delinquent">
              <div class="mortgage-card-header"><h4>Delinquent Mortgage</h4></div>
              <div class="mortgage-card-body">
                <div class="mortgage-stat"><span class="mortgage-stat-val">$1,500</span></div>
                <div class="mortgage-stat"><span class="mortgage-stat-val">$60,000</span></div>
              </div>
              <div class="mortgage-card-footer">
                <div class="actions-delinquent-row" style="display: flex; gap: 0.5rem; width: 100%;">
                  <button class="btn-pay-mortgage btn-pay-single-delinquent" style="flex: 1; min-width: 0; padding: 0.65rem 0.35rem; font-size: 0.82rem;">
                    Pay Single ($1,500)
                    <span style="display: block; font-size: 0.72rem; opacity: 0.9; margin-top: 2px;">Stave Off</span>
                  </button>
                  <button class="btn-pay-mortgage btn-pay-double-delinquent" style="flex: 1; min-width: 0; padding: 0.65rem 0.35rem; font-size: 0.82rem;">
                    Pay Double ($3,000)
                    <span style="display: block; font-size: 0.72rem; opacity: 0.9; margin-top: 2px;">Bring Current</span>
                  </button>
                </div>
              </div>
            </div>
          \`;
        `
      },
      {
        name: 'Financial Report View (Balance Sheet)',
        setupJs: `
          document.getElementById('game-make-payments-view').classList.add('hidden');
          document.getElementById('game-financial-report-view').classList.remove('hidden');
          const bsRow = (label, amt, cls = '', dot = '') => '<div class="bs-row ' + cls + '"><span class="bs-row-label">' + (dot ? '<span class="bs-dot" style="background-color:' + dot + ';"></span>' : '') + '<span class="bs-row-label-text">' + label + '</span></span><span class="bs-amount">' + amt + '</span></div>';
          document.getElementById('financial-report-container').innerHTML =
            '<div class="balance-sheet">' +
              '<div class="bs-title-bar"><h3 class="bs-title">Balance Sheet</h3><div class="bs-subtitle">Round 12 • A Very Long Player Name</div></div>' +
              '<div class="bs-section"><div class="bs-section-title">Assets</div>' +
                '<div class="bs-group-title">Current Assets</div>' + bsRow('Cash (bank account)', '$1,234,567') +
                '<div class="bs-group-title">Fixed Assets</div>' +
                bsRow('Pennsylvania Avenue Extra Long Name Estate', '$1,200,000', '', '#16a34a') +
                bsRow('Mediterranean Avenue', '$120,000', '', '#8B5A2B') +
                bsRow('Total Fixed Assets', '$1,320,000', 'bs-subtotal') +
                bsRow('Total Assets', '$2,554,567', 'bs-total') +
              '</div>' +
              '<div class="bs-section"><div class="bs-section-title">Liabilities</div>' +
                '<div class="bs-group-title">Mortgages Payable</div>' + bsRow('Pennsylvania Avenue Extra Long Name Estate', '$1,080,000', '', '#16a34a') +
                '<div class="bs-group-title">Past-Due Payments</div>' + bsRow('Mediterranean Avenue', '$1,500', '', '#8B5A2B') +
                bsRow('Total Liabilities', '$1,081,500', 'bs-total') +
              '</div>' +
              '<div class="bs-section" style="border-bottom:none;padding-bottom:0;"><div class="bs-section-title">Equity</div>' +
                bsRow('Owner Equity (Assets - Liabilities)', '$1,473,067', 'bs-total bs-equity-row') +
              '</div>' +
            '</div>';
        `
      },
      {
        name: 'Market Report View (Empty Purchases)',
        setupJs: `
          document.getElementById('game-financial-report-view').classList.add('hidden');
          document.getElementById('game-market-report-view').classList.remove('hidden');
          document.getElementById('market-report-container').innerHTML = \`
            <div class="market-temperature-card">
              <div class="market-temperature-label">Market Temperature</div>
              <div class="market-temperature-val temp-toasty">Toasty</div>
            </div>
            <div class="market-leaderboard-card">
              <div class="market-leaderboard-header">
                <h3 class="market-leaderboard-title">Leaderboard</h3>
              </div>
              <div class="market-leaderboard-list">
                <div class="market-leaderboard-item">
                  <div class="leaderboard-player-left">
                    <span class="leaderboard-rank rank-1">#1</span>
                    <span class="leaderboard-name">Alice Extra Long Name</span>
                  </div>
                  <span class="leaderboard-equity">$1,234,567</span>
                </div>
                <div class="market-leaderboard-item">
                  <div class="leaderboard-player-left">
                    <span class="leaderboard-rank rank-2">#2</span>
                    <span class="leaderboard-name">Bob</span>
                  </div>
                  <span class="leaderboard-equity">$100,000</span>
                </div>
              </div>
            </div>
            <div class="sales-history-section">
              <h3 class="sales-history-title">Sales History (0)</h3>
              <div class="card placeholder-card" style="padding: 3rem 1.5rem;">
                <h4 style="margin-bottom: 0.5rem; font-size: 1.25rem;">No Purchases Yet</h4>
                <p style="color: var(--text-muted); max-width: 440px; margin: 0 auto; line-height: 1.5; font-size: 0.95rem;">
                  No properties have been purchased yet this game.
                </p>
              </div>
            </div>
          \`;
        `
      },
      {
        name: 'Market Report View (Populated Sales History)',
        setupJs: `
          document.getElementById('market-report-container').innerHTML = \`
            <div class="market-temperature-card">
              <div class="market-temperature-label">Market Temperature</div>
              <div class="market-temperature-val temp-on-fire">On Fire</div>
            </div>
            <div class="market-leaderboard-card">
              <div class="market-leaderboard-header">
                <h3 class="market-leaderboard-title">Leaderboard</h3>
              </div>
              <div class="market-leaderboard-list">
                <div class="market-leaderboard-item">
                  <div class="leaderboard-player-left">
                    <span class="leaderboard-rank rank-1">#1</span>
                    <span class="leaderboard-name">Charlie</span>
                  </div>
                  <span class="leaderboard-equity">$1,200,000</span>
                </div>
                <div class="market-leaderboard-item">
                  <div class="leaderboard-player-left">
                    <span class="leaderboard-rank rank-2">#2</span>
                    <span class="leaderboard-name">Alice Extra Long Name</span>
                  </div>
                  <span class="leaderboard-equity">$1,060,000</span>
                </div>
                <div class="market-leaderboard-item">
                  <div class="leaderboard-player-left">
                    <span class="leaderboard-rank rank-3">#3</span>
                    <span class="leaderboard-name">Bob</span>
                  </div>
                  <span class="leaderboard-equity">$100,000</span>
                </div>
                <div class="market-leaderboard-item">
                  <div class="leaderboard-player-left">
                    <span class="leaderboard-rank">#4</span>
                    <span class="leaderboard-name">Dave</span>
                  </div>
                  <span class="leaderboard-equity">$90,000</span>
                </div>
              </div>
            </div>
            <div class="sales-history-section">
              <h3 class="sales-history-title">Sales History (2)</h3>
              <div class="sales-history-list">
                <div class="sales-history-item">
                  <div class="sales-history-stripe" style="background-color: #8B5A2B;"></div>
                  <div class="sales-history-content">
                    <div class="sales-history-prop-group">
                      <span class="sales-history-prop-name">Mediterranean Avenue</span>
                      <div class="sales-history-meta"><span>Buyer: Player 1</span></div>
                    </div>
                    <div class="sales-history-price-group">
                      <span class="sales-history-price">$60,000</span>
                      <span class="sales-history-badge">Round 1</span>
                    </div>
                  </div>
                </div>
                <div class="sales-history-item">
                  <div class="sales-history-stripe" style="background-color: #0ea5e9;"></div>
                  <div class="sales-history-content">
                    <div class="sales-history-prop-group">
                      <span class="sales-history-prop-name">Oriental Avenue</span>
                      <div class="sales-history-meta"><span>Buyer: Player 2</span></div>
                    </div>
                    <div class="sales-history-price-group">
                      <span class="sales-history-price">$100,000</span>
                      <span class="sales-history-badge">Round 2</span>
                    </div>
                  </div>
                </div>
              </div>
            </div>
          \`;
        `
      }
    ];

    let allPassed = true;

    for (const tc of testCases) {
      await send('Runtime.evaluate', { expression: tc.setupJs });
      await wait(100);

      const evalRes = await send('Runtime.evaluate', {
        expression: `(() => {
          const docEl = document.documentElement;
          const body = document.body;
          const scrollWidth = Math.max(docEl.scrollWidth, body.scrollWidth);
          const clientWidth = docEl.clientWidth;
          const overflows = [];
          for (const el of document.querySelectorAll('*')) {
            if (el.offsetParent !== null) {
              const r = el.getBoundingClientRect();
              if (r.right > clientWidth + 1) {
                overflows.push(el.tagName + '.' + el.className + ' (right=' + r.right + ')');
              }
            }
          }

          // Check if any visible .modal-actions-row, .property-detail-actions, or .actions-delinquent-row has stacked buttons
          const actionRows = [];
          for (const row of document.querySelectorAll('.modal-actions-row, .property-detail-actions, .actions-delinquent-row')) {
            const btns = Array.from(row.querySelectorAll('button'));
            if (btns.length >= 2) {
              const r0 = btns[0].getBoundingClientRect();
              const r1 = btns[1].getBoundingClientRect();
              const isSideBySide = Math.abs(r0.top - r1.top) < 8;
              actionRows.push({ selector: row.className, isSideBySide, b0Top: r0.top, b1Top: r1.top, w0: r0.width, w1: r1.width });
            }
          }

          return {
            url: location.href,
            htmlLen: document.body.innerHTML.length,
            scrollWidth,
            clientWidth,
            hasHorizontalScroll: scrollWidth > clientWidth,
            overflowCount: overflows.length,
            overflowSample: overflows.slice(0, 3),
            totalButtons: document.querySelectorAll('button').length,
            actionRows
          };
        })()`,
        returnByValue: true
      });

      const metrics = evalRes.result.value;
      const pass = !metrics.hasHorizontalScroll && metrics.overflowCount === 0;
      if (!pass) allPassed = false;

      console.log(`\nView: [${tc.name}]`);
      console.log(`  url: ${metrics.url}, htmlLen: ${metrics.htmlLen}`);
      console.log(`  clientWidth: ${metrics.clientWidth}px, scrollWidth: ${metrics.scrollWidth}px (totalButtons: ${metrics.totalButtons})`);
      console.log(`  actionRows detected:`, metrics.actionRows);
      console.log(`  horizontal scroll: ${metrics.hasHorizontalScroll ? '⚠️ YES (FAIL)' : '✓ None (PASS)'}`);
      if (metrics.overflowCount > 0) {
        console.log(`  overflow elements:`, metrics.overflowSample);
      }
      if (metrics.actionRows.length > 0) {
        for (const ar of metrics.actionRows) {
          console.log(`  action row (${ar.selector}) side-by-side: ${ar.isSideBySide ? '✓ YES (Single line)' : '⚠️ NO (Stacked)'}`);
          if (!ar.isSideBySide) allPassed = false;
        }
      }
    }

    ws.close();
    if (allPassed) {
      console.log('\n🎉 ALL 375px MOBILE SQUEEZE TESTS PASSED PERFECTLY!');
    } else {
      console.log('\n❌ SOME CHECKS FAILED');
      process.exit(1);
    }
  } finally {
    chrome.kill('SIGKILL');
    staticServer.close();
  }
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
