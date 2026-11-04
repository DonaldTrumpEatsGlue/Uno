<h1 align="center">
  <a href="https://github.com/DonaldTrumpEatsGlue/Uno">
  <img width="455" src="uno_cover.png" alt="Uno"></a>
</h1>

# Uno

This is a browser-based UNO game with a computer-play mode and a separate online mode for private invite-code tables and public rooms.

## Play online locally

1. Install Node.js 20 or newer.
2. Run `npm ci --prefix server`.
3. Run `npm run start:online` in this folder.
4. Open `http://localhost:3001/health` to verify the server, then serve this folder from a local web server and open `online.html`. For example, run `npx http-server .` from this folder and use the URL it prints.
5. Connect with a guest name, create a private/public room, and share its six-character code.

Rooms support two to four seats. Bot opponents are optional and off by default; enable them when creating a room or from the host controls while waiting. When the host starts, bots fill every open seat, so one person can start a solo game against bots or a group can top up a partially filled room. The server owns the shuffled hands, bot turns, and move validation; each browser only receives its own cards. Players can reconnect for 90 seconds, chat, call UNO, and vote together for a rematch. Solo bot games can be rematched by the human player. Game state is in memory and rooms expire after 30 minutes.

## Deploy online

`render.yaml` describes a separate Node WebSocket service for Render. Deploy this project as a Git repository, then create the web service from its Blueprint. In `uno-config.js`, change `serverUrl` to the service's secure WebSocket URL, ending in `/ws` (for example `wss://your-uno-service.onrender.com/ws`). If you want existing Openboard account sign-in, set the server's `SUPABASE_URL`, `SUPABASE_ANON_KEY`, and `SUPABASE_SERVICE_ROLE_KEY` to the same Supabase project used by Openboard; `SUPABASE_SERVICE_ROLE_KEY` stays server-side and must never be put in `uno-config.js`. Set `UNO_ALLOWED_ORIGINS` to the exact HTTPS URL of the published game. Guest play does not require Supabase.

Publish the static game files (including `online.html`, `online.js`, `online.css`, `uno-config.js`, `cards.css`, `retina_wood.png`, and `uno card back.png`) on a static host such as GitHub Pages. Online play requires serving the page over HTTP/HTTPS; opening the HTML directly as `file://` can block browser connections.

The online version preserves the current house rules: same-type draw-card stacking, drawing when no card is playable, and calling UNO at two cards before playing. Bot filling is an opt-in room setting and does not change computer-mode games.

## Tests

Run `npm run test:online` to test the server-authoritative UNO rules, private-hand snapshots, human multiplayer, solo bot games, bot turns, and rematches. Run `npm test --prefix server` for the same focused server tests.

## Contents

- [How to Start the Game](#how-to-start-the-game)
- [Play Online](#play-online-locally)
- [Development](#development)
- [Credits](#credits)

## How to Start the Game

Open `index.html` in a browser to play locally. Online rooms require serving the files over HTTP/HTTPS and running the online server as described above.

## Development

Want to contribute? Great!

To fix a bug or add an enhancement, follow these steps:

- Fork the repo
- Create a new branch (`git checkout -b improve-feature`)
- Make the appropriate changes in the files
- Add changes to reflect the changes made
- Commit your changes (`git commit -am 'Improve feature'`)
- Push to the branch (`git push origin improve-feature`)
- Create a Pull Request

## Credits

CSS for uno cards based off [a pen by rn404 on codepen.com](https://codepen.io/rn404/pen/mEpiG) containing CSS for cards 0-10
