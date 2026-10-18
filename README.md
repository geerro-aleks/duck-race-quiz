# Duck Race Quiz

The app has a fixed set of questions in `quiz.mjs`, one shared quiz room, and a Neon Postgres database for the PIN, game phase, players, answers, and scores. The host can reset the finished quiz for a new group. The race character artwork is served from `assets/race-character.png`.

## Create the Neon database

1. Create a Neon account and a free Postgres project.
2. In the Neon SQL Editor, run the contents of `schema.sql`.
3. Copy the connection string from Neon. Keep it private.

Neon currently lists a $0 Free plan with usage/storage limits and says no credit card is required for that plan. It still requires an account; exceeding free usage or changing plans can have billing implications. Review the current [Neon pricing](https://neon.com/pricing) and do not upgrade if you want to stay on free.

## Deploy to Vercel

1. Push this project to a GitHub, GitLab, or Bitbucket repository.
2. Create a Vercel account, choose **Add New → Project**, and import that repository.
3. In the project settings, add these environment variables for **Production** (and Preview if needed):
   - `DATABASE_URL`: the Neon connection string.
   - `HOST_KEY`: a long, random private secret. Generate one with `node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))"`.
   - `GAME_PIN` (optional): a chosen six-digit PIN. If omitted, the first host session creates a random persistent PIN in the database.
4. Deploy. Vercel serves the static page and the API functions under `api/` (`host/session.js`, `state.js`, and `game.js`).
5. Open the Vercel URL, enter `HOST_KEY` under **Host the preset quiz**, and share the displayed PIN and URL with players. Players can join from Wi-Fi or mobile data.

Do not put `HOST_KEY` or `DATABASE_URL` in source code or in browser JavaScript. They are read only by the server. The host key is intentionally an environment secret rather than a hardcoded value: hardcoding it would expose host controls to anyone who can read the repository.

Vercel's Hobby plan is listed at $0/month but has usage limits and account eligibility rules. Use Hobby only, do not upgrade or add paid features, and review the current [Vercel pricing](https://vercel.com/pricing). Free tiers can change; neither provider guarantees this app will remain within free limits at any audience size.

## Run locally

After setting up the Neon schema, copy `.env.example` to `.env` and enter your own secrets. The `.env` file is ignored by Git. Run `npm install`, then `npm start`; Node.js 20 or newer is required. With PowerShell, local environment variables can also be set for the current terminal using `$env:DATABASE_URL='your-connection-string'` and `$env:HOST_KEY='your-private-secret'` before running `node server.cjs`.

## Game flow and limits

The host starts the fixed quiz. Players have 30 seconds to answer, followed by a six-second race, correct-answer reveal, and 25-second break. Correct answers earn 100 points. The server checks deadlines and scores; the answer key is not sent until the reveal.

Clients request updates every three seconds because Vercel Functions do not provide this app with a shared always-on process for pushing live state to all players. This produces many requests in a large room: 500 players for a full quiz could make roughly 130,000 state requests, in addition to answer and join requests. Free Vercel/Neon usage is limited, so this is **not yet load-tested or guaranteed for hundreds of simultaneous players**. Test with a small group first and check both providers' current limits. If usage requires a paid plan, stop before upgrading if you do not want charges.

The room state and scores persist in Neon across function restarts. The project is a prototype, not hardened against abuse or large public events.
