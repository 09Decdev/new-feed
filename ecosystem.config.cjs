// PM2 ecosystem — runs the bot directly via `node -r ts-node/register poster.ts`.
// No npm/cmd wrapper (the `cmd /c npm start` approach crash-loops on Windows PM2
// with "SyntaxError: Unexpected token ':'" on NPM.CMD). The .env is loaded by
// poster.ts's inline loadDotEnv(), so no dotenv-cli needed for PM2.
module.exports = {
  apps: [
    {
      name: 'news-poster',
      cwd: __dirname,
      script: 'node',
      args: '-r ts-node/register poster.ts --mode=run',
      interpreter: 'none',
      autorestart: true,
      max_restarts: 20,
      min_uptime: '10s',
    },
  ],
};
