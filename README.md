# chrome-dino-game

Plays the Chrome T-Rex Runner (an open-source clone of it) using Ollama's
`tev1:4b` decision model. Every jump/duck/run the dino makes is a real
answer from the model, asked live via Ollama's `/v1/systemone` decision
API, not hardcoded game logic.

A live dashboard panel renders under the game showing each raw decision:
the model's choice, its per-option probabilities, and its confidence.

## Setup

1. **Install [Ollama](https://ollama.com)** and make sure it's running
   (`ollama serve`, or just open the app).

2. **Pull the decision model:**

   ```bash
   ollama pull tev1:4b
   ```

3. **Install dependencies:**

   ```bash
   npm install
   npx playwright install chromium
   ```

## Run

```bash
node dino-bot.js
```

This opens a visible Chromium window and starts playing. The first
decision takes a couple of seconds (the model loads into memory); after
that, responses are near-instant. Console output logs every decision the
model makes and when the dino crashes.

Stop it anytime with `Ctrl+C`.

## How it works

- **State, not pixels**: the script reads obstacle type, height, and game
  speed directly from the page's own `Runner.instance_` object instead of
  using image recognition.
- **Speed-adaptive timing**: the distance at which the dino reacts scales
  with the game's current speed, so reaction time stays roughly constant
  as the game accelerates.
- **Model-only decisions**: the model's answer is always what gets
  executed. The only fallback is a timeout safety net for when the model
  hasn't responded yet by the moment of truth, never a correctness
  override of an answer it already gave.
