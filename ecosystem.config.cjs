module.exports = {
  apps: [
    {
      name: 'vero',
      script: 'src/bootstrap.js',
      node_args: '--experimental-vm-modules',
      env: { NODE_ENV: 'production' },
      error_file: 'logs/error.log',
      out_file: 'logs/out.log',
      log_date_format: 'YYYY-MM-DD HH:mm:ss',
      restart_delay: 5000,
      max_memory_restart: '600M',
      watch: false
    }
  ]
}
