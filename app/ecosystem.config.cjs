module.exports = {
  apps: [{
    name: "ff-news-api",
    cwd: "/opt/ff-news/app",
    script: "src/server.js",
    instances: 1,
    exec_mode: "fork",
    autorestart: true,
    max_restarts: 10,
    time: true,
    env: {
      NODE_ENV: "production",
      BACKEND_PORT: "8081",
      CACHE_FILE: "/opt/ff-news/cache/latest.json"
    },
    out_file: "/opt/ff-news/logs/app.log",
    error_file: "/opt/ff-news/logs/app.log",
    merge_logs: true
  }]
};
