module.exports = {
  apps: [
    {
      name: 'garage',
      script: 'server.js',
      cwd: '/home/eric/garage/current',
      instances: 1,
      exec_mode: 'fork',
      autorestart: true,
      watch: false,
      max_restarts: 10,
      env: {
        NODE_ENV: 'production',
      },
    },
  ],

  deploy: {
    production: {
      user: 'eric',
      host: '45.56.94.188',
      ref: 'origin/main',
      repo: 'https://github.com/ericman314/garage.git',
      path: '/home/eric/garage',
      'pre-setup': '',
      'post-setup': 'ln -sfn /home/eric/garage/shared/config current/config && npm install --omit=dev',
      'post-deploy': 'ln -sfn /home/eric/garage/shared/config current/config && npm install --omit=dev && pm2 startOrReload ecosystem.config.cjs --only garage',
    },
  },
}
