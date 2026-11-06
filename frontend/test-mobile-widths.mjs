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
        name: 'Property Details View (Back + Buy side-by-side)',
        setupJs: `
          document.getElementById('improve-property-modal').classList.add('hidden');
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
        name: 'Make Payments View (Single + Double Pay side-by-side)',
        setupJs: `
          document.getElementById('game-property-details-view').classList.add('hidden');
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
