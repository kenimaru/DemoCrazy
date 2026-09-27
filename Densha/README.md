# 臺鐵運轉 · Rail Driver Taiwan

A Densha-de-Go-style driving game on procedurally generated Taiwan Railway (TRA) routes, built with Three.js.

```
npm install
npm run dev      # http://localhost:5174
```

## Gameplay
- One-handle master controller: P1–P5, N, B1–B8, EB. Air brakes and traction respond with lag.
- Keep to the timetable and stop the train front at the yellow 停車 marker. Within 10 cm is a PERFECT stop.
- 持時 (time remaining) drops for lateness, overspeed, missed horn boards (鳴), emergency braking and passing a red signal. Precise stops, on-time arrivals and on-time passes of skipped stations add time back. It reaching zero ends the run.
- Signals: G = line speed, YG = 75, Y = 45, R = stop. Starting signals clear at departure time. Some blocks have a train ahead, so signals upgrade as you approach.
- Speed limits come from curve radius (the tilting Puyuma gets higher limits) and occasional 慢行 track-work zones, each with an advance warning board.

## Controls
| Key | Action |
|---|---|
| ↑ / W, ↓ / S (or mouse wheel) | Notch towards power / brake |
| Space | Emergency brake |
| N | Neutral |
| H | Horn |
| Enter | Fast-forward station dwell |
| C | Camera: cab / chase / trackside / drone |
| Drag | Look around in the cab (double-click resets) |
| Esc / P | Pause |

## Routes
Lines: Western Line (Taipei–Hsinchu), Coast Line, Yilan Line, Hualien–Taitung Line and South-Link Line, with real station sequences. The seed generates everything else: curves, grades, tunnels, rivers and bridges, crossings, signals, scenery (townhouses with rooftop sheds, paddies, betel-nut palms, temples, wind turbines, sea coast) and the timetable.

Trains: EMU800 local, EMU3000 Tze-Chiang, TEMU2000 Puyuma. Oncoming traffic uses these plus the E1000 push-pull.

## Code map (`src/`)
- `route.js`: alignment, profile, stations, tunnels, bridges, limits, signals, timetable
- `terrain.js`: height and colour field in track coordinates
- `world.js`: chunked streaming of terrain, track, structures and scenery
- `game.js`: rules and scoring. `physics.js`: train dynamics
- `trainmodel.js`, `sky.js`, `hud.js`, `audio.js` (synthesised sound), `input.js`, `traffic.js`, `main.js`
