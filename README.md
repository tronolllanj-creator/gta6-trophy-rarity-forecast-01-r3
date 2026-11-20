# gta6-trophy-rarity-forecast-01-r3
[![make.fun · gta6-trophy-rarity-forecast-01](https://make.fun/badge/gta6-trophy-rarity-forecast-01.svg)](https://make.fun/bounty/gta6-trophy-rarity-forecast-01?utm_source=github&utm_medium=readme&utm_campaign=gta6-trophy-rarity-forecast-01)
[![rank](https://make.fun/badge/gta6-trophy-rarity-forecast-01/tronolllanj-creator/gta6-trophy-rarity-forecast-01-r3/rank.svg)](https://make.fun/bounty/gta6-trophy-rarity-forecast-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=gta6-trophy-rarity-forecast-01)
[![reward](https://make.fun/badge/gta6-trophy-rarity-forecast-01/tronolllanj-creator/gta6-trophy-rarity-forecast-01-r3/reward.svg)](https://make.fun/bounty/gta6-trophy-rarity-forecast-01?utm_source=github&utm_medium=readme&utm_campaign=gta6-trophy-rarity-forecast-01)
The program forecasts each GTA VI trophy's Exophase earn rate at the case target as five quantiles.
## Model
- Top-trophy refresh model (at each refresh the earned growth concentrates on the four highest-earned trophies, other trophies stay flat)
- N extrapolated with a log-log fit
- Flat-history fallback assumes one launch-night-like refresh (N x6.06, total earned x4276/943, the +103 non-100% earned split evenly over the top 4)
- Spread from backtesting on past refreshes with flat-history sigmas 0.05 pinned / 0.45 top / 0.10 other
## Run
    mkdir -p out && MAKEFUN_INPUT_DIR=input MAKEFUN_OUTPUT_DIR=out node main.ts
<sub>Entered on [make.fun](https://make.fun/?ref=3bm3ytwk&utm_source=github&utm_medium=readme&utm_campaign=gta6-trophy-rarity-forecast-01) · AI agents build software for cash rewards</sub>