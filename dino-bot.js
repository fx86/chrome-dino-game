const { chromium } = require('playwright');

const SYSTEMONE_URL = 'http://localhost:11434/v1/systemone';
const MODEL = 'tev1:4b';
const GAME_URL = 'https://wayou.github.io/t-rex-runner/';

// The game accelerates over time (currentSpeed climbs from ~6 to ~13),
// so a *fixed* px threshold means less and less real reaction time as
// speed rises. Instead, calibrate in frames (time) and scale the actual
// px threshold by the obstacle's current speed every tick, so the
// trigger distance grows automatically as the game gets faster.
// (Calibrated empirically at the game's starting speed, ~6.5px/frame:
// ASK ~40 frames out, EXECUTE ~17 frames out, i.e. the old 260px/115px.)
const ASK_LEAD_FRAMES = 40;
const EXECUTE_LEAD_FRAMES = 17;

// Ducking uses a WIDER collision box than running (59px vs 44px) and
// must already be fully lowered before the pterodactyl arrives, so it
// needs an earlier trigger and a longer hold than jump.
const DUCK_LEAD_FRAMES = 26;
const DUCK_HOLD_MULTIPLIER = 1.6;

const PANEL_CSS = `
/* The game auto-enables "arcade mode" on start, whose CSS forces
   .interstitial-wrapper to height:100vh (full viewport) -- that's what
   was pushing our panel far off-screen. Cancel it so the wrapper keeps
   its normal ~180px flow height and the panel sits right after it. */
.arcade-mode .interstitial-wrapper { height:auto !important; max-width:600px !important; }
body { padding-bottom:40px; }
#tev-panel { width:600px; margin:24px auto 0 auto; background:#fff; border:1px solid #e3e3e3;
  border-radius:12px; padding:20px 22px; box-shadow:0 1px 3px rgba(0,0,0,0.06);
  font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif; }
#tev-panel .tev-move { color:#8a8a8a; font-size:14px; margin-bottom:14px; }
#tev-panel pre { margin:0; font-family:'SF Mono',Menlo,Consolas,monospace; font-size:13px; line-height:1.55; white-space:pre-wrap; }
#tev-panel .k { color:#0f766e; }
#tev-panel .s { color:#15803d; }
#tev-panel .n { color:#b45309; }
#tev-panel .tev-caption { color:#9a9a9a; font-size:13px; text-align:center; margin-top:16px;
  padding-top:14px; border-top:1px solid #eee; font-family:-apple-system,sans-serif; }
`;

// Round probabilities to 2 decimals for display; keep everything else as-is.
function roundProbs(response) {
  const clone = JSON.parse(JSON.stringify(response));
  const action = clone.answers && clone.answers.action;
  if (action) {
    if (action.probabilities) {
      for (const k of Object.keys(action.probabilities)) {
        action.probabilities[k] = Math.round(action.probabilities[k] * 100) / 100;
      }
    }
    if (typeof action.confidence === 'number') {
      action.confidence = Math.round(action.confidence * 100) / 100;
    }
  }
  return clone;
}

function syntaxHighlight(json) {
  const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  return esc(json)
    .replace(/"([^"]+)":/g, '<span class="k">"$1"</span>:')
    .replace(/: "([^"]*)"/g, ': <span class="s">"$1"</span>')
    .replace(/: (-?\d+(\.\d+)?)/g, ': <span class="n">$1</span>');
}

async function setupPanel(page) {
  await page.evaluate((css) => {
    const style = document.createElement('style');
    style.textContent = css;
    document.head.appendChild(style);

    const panel = document.createElement('div');
    panel.id = 'tev-panel';
    panel.innerHTML = `
      <div class="tev-move" id="tev-move">Waiting for first obstacle…</div>
      <pre id="tev-json">{}</pre>
      <div class="tev-caption">tev1:4b running locally via Ollama, replayed at real-time speed.</div>
    `;
    document.body.appendChild(panel);
  }, PANEL_CSS);
}

async function updatePanel(page, moveNum, obstacleType, response) {
  const json = JSON.stringify(roundProbs(response), null, 2);
  await page.evaluate(
    ({ moveNum, obstacleType, html }) => {
      document.getElementById('tev-move').textContent = `Decision #${moveNum} — ${obstacleType}`;
      document.getElementById('tev-json').innerHTML = html;
    },
    { moveNum, obstacleType, html: syntaxHighlight(json) }
  );
}

function buildState(state) {
  const kind = state.obstacleType === 'PTERODACTYL' ? 'a flying pterodactyl' : 'a ground cactus';
  return `The dino is running at speed ${state.speed.toFixed(1)}. The nearest obstacle is ${kind}, ${state.distance.toFixed(
    0
  )}px ahead, at height yPos=${state.yPos} (lower yPos = higher off the ground; ground level is yPos 90-105).`;
}

async function askModel(state) {
  const res = await fetch(SYSTEMONE_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: MODEL,
      state: buildState(state),
      questions: {
        action: {
          type: 'choice',
          instructions: 'What should the dino do right now to survive the upcoming obstacle?',
          criteria: {
            jump: 'Jump over a ground-level obstacle, or a low-flying pterodactyl',
            duck: 'Duck to stay low and pass under a mid/high-flying pterodactyl',
            run: 'Take no action, the path ahead is currently clear enough',
          },
        },
      },
    }),
  });
  return res.json();
}

// Used ONLY if the model hasn't answered yet by the time we must act (a
// latency safety net, not a correctness check) -- every action the dino
// actually takes should come from the model's own answer.
function fallbackAction(obstacleType, yPos) {
  if (obstacleType !== 'PTERODACTYL') return 'jump';
  if (yPos >= 90) return 'jump';
  if (yPos >= 60) return 'duck';
  return 'run';
}

async function main() {
  const browser = await chromium.launch({ headless: false });
  const page = await browser.newPage({ viewport: { width: 700, height: 900 } });
  await page.goto(GAME_URL, { waitUntil: 'load' });
  await page.waitForTimeout(300);
  await setupPanel(page);

  console.log('Warming up the model (first call loads it into memory)...');
  await askModel({ speed: 6, distance: 300, obstacleType: 'CACTUS', yPos: 105 });
  console.log(`Dino bot running with decision model "${MODEL}".`);

  await page.keyboard.press('Space');

  let moveNum = 0;
  let pending = null; // { key, promise, distanceAtAsk }
  let executedForKey = null;

  while (true) {
    const state = await page.evaluate(() => {
      const r = window.Runner && window.Runner.instance_;
      if (!r) return null;
      const ob = r.horizon && r.horizon.obstacles[0];
      if (ob && ob.__tevId === undefined) {
        window.__tevObstacleCounter = (window.__tevObstacleCounter || 0) + 1;
        ob.__tevId = window.__tevObstacleCounter;
      }
      return {
        crashed: r.crashed,
        speed: r.currentSpeed,
        score: Math.floor(r.distanceRan / 50),
        tRexX: r.tRex.xPos,
        obstacle: ob
          ? { id: ob.__tevId, x: ob.xPos, yPos: ob.yPos, typeName: ob.typeConfig ? ob.typeConfig.type : 'UNKNOWN' }
          : null,
      };
    });

    if (!state) {
      await page.waitForTimeout(50);
      continue;
    }

    if (state.crashed) {
      console.log(`Crashed at score ${state.score} (speed ${state.speed.toFixed(1)}). Restarting...`);
      pending = null;
      executedForKey = null;
      await page.waitForTimeout(400);
      await page.keyboard.press('Space');
      await page.waitForTimeout(400);
      continue;
    }

    if (state.obstacle) {
      const distance = state.obstacle.x - state.tRexX;
      const key = state.obstacle.id;

      if (distance <= 0) {
        pending = null;
        executedForKey = null;
      } else {
        const isPtero = state.obstacle.typeName === 'PTERODACTYL';
        const gameState = {
          speed: state.speed,
          distance,
          obstacleType: isPtero ? 'PTERODACTYL' : 'CACTUS',
          yPos: state.obstacle.yPos,
        };

        // Scale trigger distances by the game's *current* speed, so they
        // represent a constant amount of reaction time regardless of how
        // fast the game has sped up. The obstacle's physical type/height
        // (not the model's eventual answer) tells us deterministically
        // whether this will need a jump-style or duck-style reaction --
        // ducking needs to start earlier since its collision box is wider.
        const likelyNeedsDuck = isPtero && gameState.yPos >= 60 && gameState.yPos < 90;
        const askZonePx = state.speed * ASK_LEAD_FRAMES;
        const executePx = state.speed * (likelyNeedsDuck ? DUCK_LEAD_FRAMES : EXECUTE_LEAD_FRAMES);

        // Phase 1: ask the model as soon as the obstacle enters the wide zone.
        if (distance < askZonePx && (!pending || pending.key !== key)) {
          moveNum++;
          const thisMoveNum = moveNum;
          const record = {
            key,
            obstacleType: gameState.obstacleType,
            resolved: null,
          };
          pending = record;
          askModel(gameState).then((resp) => {
            record.resolved = resp;
            updatePanel(page, thisMoveNum, record.obstacleType, resp).catch(() => {});
          });
        }

        // Phase 2: execute at the tight, calibrated window.
        if (distance < executePx && executedForKey !== key) {
          executedForKey = key;
          const modelAnswered = pending && pending.key === key && pending.resolved;
          const action = modelAnswered
            ? pending.resolved.answers.action.choice
            : fallbackAction(gameState.obstacleType, gameState.yPos);

          console.log(
            `  action: ${action}${modelAnswered ? ' (model)' : ' (fallback: model not ready yet)'} (${gameState.obstacleType} yPos=${gameState.yPos} distance ${distance.toFixed(0)}px speed=${state.speed.toFixed(1)})`
          );
          if (action === 'jump') {
            await page.keyboard.press('Space');
          } else if (action === 'duck') {
            // Hold duration scales inversely with speed (a fixed-width
            // obstacle takes less time to pass under at higher speed),
            // with a multiplier since the shorter default undershot it.
            const duckHoldMs = Math.max(200, 350 * DUCK_HOLD_MULTIPLIER * (6.5 / state.speed));
            await page.keyboard.down('ArrowDown');
            page.waitForTimeout(duckHoldMs).then(() => page.keyboard.up('ArrowDown').catch(() => {}));
          }
        }
      }
    } else {
      pending = null;
      executedForKey = null;
    }

    await page.waitForTimeout(16);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
