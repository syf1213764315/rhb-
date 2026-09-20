const path = require("path");

module.exports = {
  apps: [
    {
      name: "robin-snipe",
      cwd: __dirname,
      script: "server/index.ts",
      interpreter: "npx",
      interpreter_args: "tsx",
      instances: 1,
      autorestart: true,
      env: { NODE_ENV: "production", PORT: 8795, HOST: "0.0.0.0" },
      error_file: path.join(__dirname, "logs/pm2-error.log"),
      out_file: path.join(__dirname, "logs/pm2-out.log"),
      merge_logs: true,
      time: true,
    },
  ],
};
