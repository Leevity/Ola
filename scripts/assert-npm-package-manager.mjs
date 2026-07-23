const userAgent = process.env.npm_config_user_agent || ''

if (userAgent && !userAgent.startsWith('npm/')) {
  console.error(`Ola only supports npm. Detected package manager: ${userAgent}`)
  process.exit(1)
}
